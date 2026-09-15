import { createHash, randomUUID } from "node:crypto";
import {
  batchUpdatePayoutCells,
  getPayoutSheetGrids,
  readPayoutValues,
  type PayoutSheetGrid,
} from "./google-sheets";
import { normalizeUniformSpreadsheetConfig, type UniformSpreadsheetConfig } from "./google-sheets";
import {
  acquirePayoutLock,
  createPayoutRun,
  finalizePayoutRun,
  getPayoutRun,
  releaseUnreportedPayoutLock,
  updatePayoutRun,
  type PayoutArchiveCell,
  type PayoutReportMessage,
  type PayoutRoleTotal,
  type PayoutRun,
} from "./payout-store";
import { withPayoutWorkbookExclusivity } from "./payout-guard";
import { invalidateUniformSubmissionLedgerForPayout } from "./google-sheets";
import { invalidateUniformDeliveriesForPayout } from "./uniform-delivery-store";

export const PAYOUT_SOURCE_TAB = "Payout Logging1";
export type PayoutRole = "Quartermasters" | "Uploaders" | "Publishers";

export interface PayoutSheetsClient {
  grids(spreadsheetId: string): Promise<PayoutSheetGrid[]>;
  values(
    spreadsheetId: string,
    tab: string,
    range: string,
    render: "UNFORMATTED_VALUE" | "FORMULA",
  ): Promise<unknown[][]>;
  batchUpdate(spreadsheetId: string, requests: unknown[]): Promise<void>;
}

/** Production provider adapter. Tests can supply a fully local client. */
export const googlePayoutSheetsClient: PayoutSheetsClient = {
  grids: getPayoutSheetGrids,
  values: readPayoutValues,
  batchUpdate: batchUpdatePayoutCells,
};

export interface PayoutSnapshot {
  spreadsheet: ReturnType<typeof normalizeUniformSpreadsheetConfig>;
  sourceValues: unknown[][];
  sourceFingerprint: string;
  grandTotal: number;
  roles: PayoutRoleTotal[];
  clearCells: PayoutArchiveCell[];
  grids: {
    log: { title: string; sheetId: number; range: A1Range };
    moderated: { title: string; sheetId: number; range: A1Range };
  };
}

interface A1Range {
  startColumn: number;
  endColumn: number;
  startRow: number;
  endRow: number;
  a1: string;
}

const ROLE_COLUMNS: ReadonlyArray<{
  role: PayoutRole;
  nameColumn: number;
  amountColumn: number;
  summaryColumn: number;
}> = [
  { role: "Quartermasters", nameColumn: 0, amountColumn: 2, summaryColumn: 2 },
  { role: "Uploaders", nameColumn: 3, amountColumn: 6, summaryColumn: 6 },
  { role: "Publishers", nameColumn: 7, amountColumn: 10, summaryColumn: 10 },
];

function columnNumber(letters: string): number {
  return [...letters].reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0);
}
function columnLetters(number: number): string {
  let result = "";
  for (let value = number; value > 0; value = Math.floor(value / 26)) {
    value--;
    result = String.fromCharCode(65 + value % 26) + result;
  }
  return result;
}

function parseRange(input: string, gridRows: number): A1Range {
  const match = /^([A-Z]+)([1-9]\d*):([A-Z]+)([1-9]\d*)?$/.exec(input);
  if (!match) throw new Error("The configured uniform data range is invalid.");
  const startColumn = columnNumber(match[1]!);
  const endColumn = columnNumber(match[3]!);
  const startRow = Number(match[2]!);
  const requestedEnd = match[4] ? Number(match[4]) : gridRows;
  const endRow = Math.min(requestedEnd, gridRows);
  if (endRow < startRow) throw new Error(`Configured range ${input} has no rows in the current worksheet grid.`);
  return { startColumn, endColumn, startRow, endRow,
    a1: `${match[1]}${startRow}:${match[3]}${endRow}` };
}

function rowsEqual(left: unknown[][], right: unknown[][]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function fingerprint(value: unknown[][]): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function valueAt(values: unknown[][], row: number, column: number): unknown {
  return values[row]?.[column];
}
function blank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}
function hasFormula(values: unknown[][]): boolean {
  return values.some((row) => row.some((value) => typeof value === "string" && value.startsWith("=")));
}

/**
 * Strictly parse the one human-readable grand-total label. Payout cells
 * themselves must be real numbers from UNFORMATTED_VALUE; this only supports
 * conventional locale separators in A1's label such as "$1,234.50" or
 * "1.234,50".
 */
export function parseGrandTotalLabel(value: unknown): number {
  if (typeof value !== "string") throw new Error("Payout Logging1 A1 must contain a Grand Total Due label.");
  const match = /^\s*grand\s*total\s*due\s*:\s*(.+?)\s*$/i.exec(value);
  if (!match) throw new Error('Payout Logging1 A1 must be labeled "Grand Total Due:".');
  let number = match[1]!.trim().replace(/[^\d,.'\-\s]/g, "").replace(/[\s']/g, "");
  if (!number || /-/.test(number) && !/^-/.test(number)) throw new Error("Payout Logging1 A1 contains an invalid total.");
  const comma = number.lastIndexOf(",");
  const dot = number.lastIndexOf(".");
  if (comma !== -1 && dot !== -1) {
    // The final punctuation is the decimal separator; the other is grouping.
    const decimal = comma > dot ? "," : ".";
    number = number.replace(decimal === "," ? /\./g : /,/g, "").replace(decimal, ".");
  } else if (comma !== -1 || dot !== -1) {
    const separator = comma !== -1 ? "," : ".";
    const parts = number.split(separator);
    // A single 1,234 convention is grouping, while 12,50 is decimal.
    if (parts.length > 2 || parts.at(-1)!.length === 3) number = parts.join("");
    else number = `${parts.slice(0, -1).join("")}.${parts.at(-1)}`;
  }
  const parsed = Number(number);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Payout Logging1 A1 contains an invalid total.");
  return parsed;
}

function payoutNumber(value: unknown, cell: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${cell} must be a finite, non-negative numeric calculated payout.`);
  }
  return value;
}

function expectedHeader(value: unknown, label: string, cell: string): void {
  if (typeof value !== "string" || value.trim().toLocaleLowerCase() !== label.toLocaleLowerCase()) {
    throw new Error(`Payout Logging1 ${cell} must have the "${label}" header.`);
  }
}

export function summarizePayoutSource(values: unknown[][]): {
  grandTotal: number;
  roles: PayoutRoleTotal[];
} {
  if (values.length < 3) throw new Error("Payout Logging1 is missing its payout headers and summary row.");
  expectedHeader(valueAt(values, 1, 0), "Quartermaster", "A2");
  expectedHeader(valueAt(values, 1, 2), "Total Payout", "C2");
  expectedHeader(valueAt(values, 1, 3), "Uploader", "D2");
  expectedHeader(valueAt(values, 1, 6), "Total Payout", "G2");
  expectedHeader(valueAt(values, 1, 7), "Publisher", "H2");
  expectedHeader(valueAt(values, 1, 10), "Total Payout", "K2");
  const grandTotal = parseGrandTotalLabel(valueAt(values, 0, 0));
  const roles = ROLE_COLUMNS.map(({ role, nameColumn, amountColumn, summaryColumn }) => {
    const summary = payoutNumber(valueAt(values, 2, summaryColumn), `${columnLetters(summaryColumn + 1)}3`);
    const participants = new Map<string, { name: string; amount: number }>();
    for (let row = 3; row < values.length; row++) {
      const nameValue = valueAt(values, row, nameColumn);
      const amountValue = valueAt(values, row, amountColumn);
      if (blank(nameValue) && blank(amountValue)) continue;
      const amount = payoutNumber(amountValue, `${columnLetters(amountColumn + 1)}${row + 1}`);
      if (amount === 0 && blank(nameValue)) continue;
      if (typeof nameValue !== "string" || !nameValue.trim()) {
        throw new Error(`${columnLetters(nameColumn + 1)}${row + 1} requires a participant name for its payout.`);
      }
      // A named zero is omitted from the report but remains an accepted
      // calculated value. This avoids paying zero-value formula rows.
      if (amount === 0) continue;
      const name = nameValue.trim();
      const key = name.toLocaleLowerCase();
      const existing = participants.get(key);
      if (existing) existing.amount += amount;
      else participants.set(key, { name, amount });
    }
    const participantList = [...participants.values()];
    const total = participantList.reduce((sum, participant) => sum + participant.amount, 0);
    if (total !== summary) {
      throw new Error(`${role} entries total ${total}, but ${columnLetters(summaryColumn + 1)}3 is ${summary}. No payout was prepared.`);
    }
    return { role, participants: participantList, total };
  });
  const calculatedGrand = roles.reduce((sum, role) => sum + role.total, 0);
  if (calculatedGrand !== grandTotal) {
    throw new Error(`Role totals ${calculatedGrand} do not match Grand Total Due ${grandTotal}. No payout was prepared.`);
  }
  return { grandTotal, roles };
}

function requireGrid(grids: PayoutSheetGrid[], title: string): PayoutSheetGrid {
  const grid = grids.find((candidate) => candidate.title === title);
  if (!grid) throw new Error(`Google Sheets worksheet "${title}" does not exist.`);
  if (grid.rowCount < 2) throw new Error(`Google Sheets worksheet "${title}" has no data rows below its header.`);
  return grid;
}

/**
 * Read every used source row (A:K), validate calculated totals, and snapshot
 * the exact formula/value state that will be cleared later. No mutation occurs
 * in this operation.
 */
export async function readPayoutSnapshot(
  client: PayoutSheetsClient,
  spreadsheetInput: UniformSpreadsheetConfig,
): Promise<PayoutSnapshot> {
  const spreadsheet = normalizeUniformSpreadsheetConfig(spreadsheetInput);
  if (spreadsheet.logTab === PAYOUT_SOURCE_TAB || spreadsheet.moderatedTab === PAYOUT_SOURCE_TAB) {
    throw new Error("Uniform reset tabs cannot be the Payout Logging1 source worksheet.");
  }
  const grids = await client.grids(spreadsheet.spreadsheetId);
  requireGrid(grids, PAYOUT_SOURCE_TAB);
  const logGrid = requireGrid(grids, spreadsheet.logTab);
  const moderatedGrid = requireGrid(grids, spreadsheet.moderatedTab);
  const logRange = parseRange(spreadsheet.logRange, logGrid.rowCount);
  const moderatedRange = parseRange(spreadsheet.moderatedRange, moderatedGrid.rowCount);
  // Sold is fixed to F. A config which includes it would clear/formula-write
  // the same cells twice and is rejected rather than guessed around.
  if (logRange.startColumn <= 6 && logRange.endColumn >= 6) {
    throw new Error("The configured /log data range overlaps fixed Sold column F.");
  }
  const sourceValues = await client.values(spreadsheet.spreadsheetId, PAYOUT_SOURCE_TAB, "A:K", "UNFORMATTED_VALUE");
  const summary = summarizePayoutSource(sourceValues);
  const clearCells: PayoutArchiveCell[] = [
    { range: `${spreadsheet.logTab}!${logRange.a1}`, values: await client.values(spreadsheet.spreadsheetId, spreadsheet.logTab, logRange.a1, "FORMULA") },
    { range: `${spreadsheet.moderatedTab}!${moderatedRange.a1}`, values: await client.values(spreadsheet.spreadsheetId, spreadsheet.moderatedTab, moderatedRange.a1, "FORMULA") },
    { range: `${spreadsheet.logTab}!F${logRange.startRow}:F${logRange.endRow}`, values: await client.values(spreadsheet.spreadsheetId, spreadsheet.logTab, `F${logRange.startRow}:F${logRange.endRow}`, "FORMULA") },
  ];
  for (const cell of clearCells) {
    if (hasFormula(cell.values)) {
      throw new Error(`Configured reset range ${cell.range} contains formulas. Payout refuses to clear formulas; move formulas outside the configured uniform data range.`);
    }
  }
  return {
    spreadsheet, sourceValues, sourceFingerprint: fingerprint(sourceValues),
    ...summary, clearCells,
    grids: {
      log: { title: spreadsheet.logTab, sheetId: logGrid.sheetId, range: logRange },
      moderated: { title: spreadsheet.moderatedTab, sheetId: moderatedGrid.sheetId, range: moderatedRange },
    },
  };
}

export function createArchivedPayoutRun(
  snapshot: PayoutSnapshot,
  guildId: string,
  actorId: string,
  runId: string = randomUUID(),
): PayoutRun {
  const now = new Date().toISOString();
  return {
    runId, spreadsheetId: snapshot.spreadsheet.spreadsheetId, guildId, actorId,
    state: "archived", sourceTab: PAYOUT_SOURCE_TAB,
    sourceFingerprint: snapshot.sourceFingerprint, sourceValues: snapshot.sourceValues,
    grandTotal: snapshot.grandTotal, roles: snapshot.roles, clearCells: snapshot.clearCells,
    reportMessageIds: [], reportState: "not-started", createdAt: now, updatedAt: now,
  };
}

export async function archivePayoutPreview(snapshot: PayoutSnapshot, guildId: string, actorId: string, runId?: string): Promise<PayoutRun> {
  return createPayoutRun(createArchivedPayoutRun(snapshot, guildId, actorId, runId));
}

export async function assertPayoutSourceUnchanged(
  client: PayoutSheetsClient,
  run: PayoutRun,
): Promise<void> {
  const current = await client.values(run.spreadsheetId, PAYOUT_SOURCE_TAB, "A:K", "UNFORMATTED_VALUE");
  if (fingerprint(current) !== run.sourceFingerprint) {
    throw new Error("Payout source changed after preview. Review a fresh /payout preview before clearing anything.");
  }
  // Re-run validation too: a same-value but malformed provider representation
  // is never accepted as a safe reset.
  summarizePayoutSource(current);
}

function gridRange(sheetId: number, range: A1Range): Record<string, number> {
  return {
    sheetId,
    startRowIndex: range.startRow - 1,
    endRowIndex: range.endRow,
    startColumnIndex: range.startColumn - 1,
    endColumnIndex: range.endColumn,
  };
}
function clearRequest(sheetId: number, range: A1Range): unknown {
  return { updateCells: { range: gridRange(sheetId, range), fields: "userEnteredValue" } };
}
function falseRequest(sheetId: number, startRow: number, endRow: number): unknown {
  return {
    updateCells: {
      range: { sheetId, startRowIndex: startRow - 1, endRowIndex: endRow, startColumnIndex: 5, endColumnIndex: 6 },
      rows: Array.from({ length: endRow - startRow + 1 }, () => ({ values: [{ userEnteredValue: { boolValue: false } }] })),
      fields: "userEnteredValue",
    },
  };
}
function entirelyBlank(values: unknown[][]): boolean {
  return values.every((row) => row.every(blank));
}
function allFalse(values: unknown[][], count: number): boolean {
  return Array.from({ length: count }, (_, index) => {
    const value = values[index]?.[0];
    return value === false || value === "FALSE";
  }).every(Boolean);
}

async function clearStateMatches(client: PayoutSheetsClient, snapshot: PayoutSnapshot): Promise<boolean> {
  const [log, moderated, sold] = await Promise.all([
    client.values(snapshot.spreadsheet.spreadsheetId, snapshot.grids.log.title, snapshot.grids.log.range.a1, "FORMULA"),
    client.values(snapshot.spreadsheet.spreadsheetId, snapshot.grids.moderated.title, snapshot.grids.moderated.range.a1, "FORMULA"),
    client.values(snapshot.spreadsheet.spreadsheetId, snapshot.grids.log.title, `F${snapshot.grids.log.range.startRow}:F${snapshot.grids.log.range.endRow}`, "FORMULA"),
  ]);
  return entirelyBlank(log) && entirelyBlank(moderated) &&
    allFalse(sold, snapshot.grids.log.range.endRow - snapshot.grids.log.range.startRow + 1);
}

export class UnsafePayoutClearError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePayoutClearError";
  }
}

/**
 * The final destructive operation. It rechecks both source and every archived
 * destination cell immediately before issuing one atomic Sheets batch update.
 * A transport-unknown response is verified exactly once; any non-matching
 * outcome is deliberately left unsafe for an administrator to recover.
 */
export async function clearArchivedPayout(
  client: PayoutSheetsClient,
  run: PayoutRun,
  snapshot: PayoutSnapshot,
): Promise<{ recoveredUnknownOutcome: boolean }> {
  await assertPayoutSourceUnchanged(client, run);
  const currentCells = await Promise.all(snapshot.clearCells.map(async (cell) => {
    const separator = cell.range.lastIndexOf("!");
    return client.values(run.spreadsheetId, cell.range.slice(0, separator), cell.range.slice(separator + 1), "FORMULA");
  }));
  if (!currentCells.every((values, index) => rowsEqual(values, snapshot.clearCells[index]!.values))) {
    throw new Error("Uniform data changed after its payout archive was captured. Nothing was cleared.");
  }
  const requests = [
    clearRequest(snapshot.grids.log.sheetId, snapshot.grids.log.range),
    clearRequest(snapshot.grids.moderated.sheetId, snapshot.grids.moderated.range),
    falseRequest(snapshot.grids.log.sheetId, snapshot.grids.log.range.startRow, snapshot.grids.log.range.endRow),
  ];
  try {
    await client.batchUpdate(run.spreadsheetId, requests);
    return { recoveredUnknownOutcome: false };
  } catch (error) {
    const verified = await clearStateMatches(client, snapshot).catch(() => false);
    if (verified) return { recoveredUnknownOutcome: true };
    throw new UnsafePayoutClearError(`Payout reset outcome is unknown; automatic retry is blocked. ${error instanceof Error ? error.message : ""}`.trim());
  }
}

export interface PayoutReportDelivery {
  /**
   * Send exactly one already-built message. The nonce is persisted before this
   * call and makes audit/recovery state unambiguous. Throwing means the
   * outcome is unknown, never "safe to retry".
   */
  sendPage?(run: PayoutRun, embeds: PayoutReportEmbed[], nonce: string): Promise<string>;
  /** Compatibility adapter for a single-message report. */
  send?(run: PayoutRun): Promise<string[]>;
}

export interface PayoutReportEmbed {
  title: string;
  description?: string;
  fields: Array<{ name: string; value: string }>;
  footer: string;
}

/**
 * Builds private-report embed payloads without silently chopping payout lines.
 * The Discord adapter is responsible only for turning these into EmbedBuilder
 * instances and sending them to the administrator's DM.
 */
export function payoutReportEmbeds(run: Pick<PayoutRun, "runId" | "grandTotal" | "roles">): PayoutReportEmbed[] {
  const fields: Array<{ name: string; value: string }> = [];
  for (const role of run.roles) {
    let chunk = "";
    let chunkNumber = 1;
    for (const participant of role.participants) {
      const line = `${participant.name} — ${participant.amount} Robux`;
      if (line.length > 1024) {
        throw new Error(`Payout line for ${participant.name.slice(0, 80)} exceeds Discord's 1024-character field limit.`);
      }
      const candidate = chunk ? `${chunk}\n${line}` : line;
      if (candidate.length > 1024) {
        fields.push({
          name: `${role.role} (${role.participants.length} participants)${chunkNumber > 1 ? ` · ${chunkNumber}` : ""}`,
          value: chunk,
        });
        chunk = line;
        chunkNumber++;
      } else {
        chunk = candidate;
      }
    }
    // A role with no payable participants still clearly appears in the report.
    fields.push({
      name: `${role.role} (${role.participants.length} participants)${chunkNumber > 1 ? ` · ${chunkNumber}` : ""}`,
      value: chunk || "No payable participants.",
    });
    fields.push({ name: `${role.role} total`, value: `${role.total} Robux` });
  }
  const embeds: PayoutReportEmbed[] = [];
  let current: PayoutReportEmbed = {
    title: "Payout Summary",
    description: `Total payout: ${run.grandTotal} Robux\nThis report summarizes payouts; it does not transfer Robux.`,
    fields: [],
    footer: `Payout run: ${run.runId} · Pending reset`,
  };
  // A title, description, footer and 25 fields cannot exhaust 6,000 with
  // 1,024-byte fields in the normal report shape; retain an exact byte-aware
  // guard anyway so an oversized run is never truncated.
  let characterCount = current.title.length + (current.description?.length ?? 0) + current.footer.length;
  for (const field of fields) {
    if (field.name.length > 256 || field.value.length > 1024) throw new Error("Payout report field exceeds Discord limits.");
    if (current.fields.length === 25 || characterCount + field.name.length + field.value.length > 6000) {
      embeds.push(current);
      current = {
        title: "Payout Summary (continued)",
        fields: [],
        footer: `Payout run: ${run.runId} · Pending reset`,
      };
      characterCount = current.title.length + current.footer.length;
    }
    current.fields.push(field);
    characterCount += field.name.length + field.value.length;
  }
  embeds.push(current);
  return embeds;
}

/** Split an arbitrarily large report into Discord-valid direct messages. */
export function payoutReportMessages(
  run: Pick<PayoutRun, "runId" | "grandTotal" | "roles">,
): PayoutReportEmbed[][] {
  const embeds = payoutReportEmbeds(run);
  const messages: PayoutReportEmbed[][] = [];
  let page: PayoutReportEmbed[] = [];
  let pageCharacters = 0;
  for (const embed of embeds) {
    const characters = embed.title.length + (embed.description?.length ?? 0) + embed.footer.length +
      embed.fields.reduce((total, field) => total + field.name.length + field.value.length, 0);
    if (characters > 6000) throw new Error("Payout report embed exceeds Discord's 6,000-character limit.");
    if (page.length === 10 || pageCharacters + characters > 6000) {
      if (!page.length) throw new Error("Payout report could not be split into Discord-safe messages.");
      messages.push(page);
      page = [];
      pageCharacters = 0;
    }
    page.push(embed);
    pageCharacters += characters;
  }
  if (page.length) messages.push(page);
  return messages;
}

function reportNonce(): string {
  // 25 URL/component-safe lowercase hex characters, persisted before sending.
  return randomUUID().replaceAll("-", "").slice(0, 25);
}

function reportPlan(run: PayoutRun): { pages: PayoutReportEmbed[][]; messages: PayoutReportMessage[] } {
  const pages = payoutReportMessages(run);
  const existing = run.reportMessages;
  if (existing) {
    if (existing.length !== pages.length ||
        existing.some((message) => !/^[a-f0-9]{25}$/.test(message.nonce))) {
      throw new Error("The archived payout report plan is incompatible; no report was sent.");
    }
    return { pages, messages: existing };
  }
  // A run written by the first payout implementation could only ever deliver
  // one Discord message (it rejected reports above ten embeds). Preserve that
  // durable fact without a store migration or an accidental re-send.
  if (run.reportState === "delivered") {
    if (pages.length !== 1) {
      throw new Error("A legacy delivered payout report cannot be safely paged; do not clear it automatically.");
    }
    return {
      pages,
      messages: [{ nonce: reportNonce(), state: "delivered", messageId: run.reportMessageIds[0] }],
    };
  }
  return {
    pages,
    messages: pages.map(() => ({ nonce: reportNonce(), state: "pending" as const })),
  };
}

async function completePayoutRun(run: PayoutRun): Promise<PayoutRun> {
  await invalidateUniformSubmissionLedgerForPayout(run.spreadsheetId, run.runId);
  await invalidateUniformDeliveriesForPayout(run.spreadsheetId, run.runId);
  return finalizePayoutRun(run.runId);
}

/** An administrator explicitly attests that the uncertain private report was received. */
export async function acknowledgeUncertainPayoutReport(runId: string, actorId: string): Promise<PayoutRun> {
  return updatePayoutRun(runId, (run) => {
    if (run.reportState !== "uncertain") {
      throw new Error("This payout report is not awaiting an acknowledgement.");
    }
    let acknowledged = false;
    for (const message of run.reportMessages ?? []) {
      if (message.state === "uncertain") {
        message.state = "acknowledged";
        acknowledged = true;
      }
    }
    if (!acknowledged) throw new Error("The uncertain payout report page is unavailable for acknowledgement.");
    const allPagesFinal = (run.reportMessages ?? []).every((message) =>
      message.state === "delivered" || message.state === "acknowledged",
    );
    run.reportState = allPagesFinal ? "delivered" : "not-started";
    run.state = allPagesFinal ? "reported" : "locked";
    run.reportAcknowledgedAt = new Date().toISOString();
    run.reportAcknowledgedBy = actorId;
    delete run.failure;
  });
}

/**
 * Confirm-side orchestration. The caller must enforce live Discord admin,
 * maintenance, nonce actor/guild/TTL checks before calling this service.
 * Reports are delivered before clearing, so a DM failure has zero Sheets
 * mutations. The durable lock remains on any ambiguous failure.
 */
export async function confirmArchivedPayout(
  client: PayoutSheetsClient,
  runId: string,
  delivery: PayoutReportDelivery,
): Promise<PayoutRun> {
  const initial = await getPayoutRun(runId);
  if (!initial) throw new Error("The payout run is unavailable.");
  // A legacy run can be marked complete while retaining its old lock. Do not
  // build/report/clear again; claim the matching lock (if present) and repair
  // it through the one-transaction finalizer.
  if (initial.state === "complete") {
    await acquirePayoutLock(initial.spreadsheetId, runId);
    return withPayoutWorkbookExclusivity(initial.spreadsheetId, () => finalizePayoutRun(runId));
  }
  // Build every embed and page before taking a durable lock or attempting a
  // DM. A deterministic Discord-size failure remains a normal archived
  // preview instead of stranding an unsafe recovery lock.
  const prepared = reportPlan(initial);
  await acquirePayoutLock(initial.spreadsheetId, runId);
  return withPayoutWorkbookExclusivity(initial.spreadsheetId, async () => {
    let run = await getPayoutRun(runId);
    if (!run) throw new Error("The payout run is unavailable.");
    if (run.state === "complete") return finalizePayoutRun(run.runId);
    let snapshot: PayoutSnapshot;
    try {
      snapshot = await snapshotForArchivedRun(client, run);
      await assertPayoutSourceUnchanged(client, run);
    } catch (error) {
      // A race that changes source between the UI's last read and exclusive
      // lock acquisition is safe to abandon: neither a report nor a Sheet
      // write has happened. It must not strand the workbook lock.
      await releaseUnreportedPayoutLock(initial.spreadsheetId, runId).catch(() => undefined);
      throw error;
    }
    const plan = reportPlan(run);
    if (!run.reportMessages) {
      run = await updatePayoutRun(runId, (record) => {
        record.reportMessages = plan.messages;
      });
    }
    if (run.reportMessages?.some((message) => message.state === "sending")) {
      run = await updatePayoutRun(runId, (record) => {
        for (const message of record.reportMessages ?? []) {
          if (message.state === "sending") message.state = "uncertain";
        }
        record.reportState = "uncertain";
        record.failure = "A payout DM was in progress when the process stopped; its delivery cannot be confirmed.";
      });
    }
    if (run.reportState === "uncertain") {
      throw new Error("This payout report has an uncertain Discord delivery outcome. No spreadsheet cells were cleared and it must be recovered without automatically sending a duplicate report.");
    }
    if (run.reportState !== "delivered") {
      try {
        const messages = run.reportMessages ?? [];
        for (let index = 0; index < messages.length; index++) {
          const message = messages[index]!;
          if (message.state === "delivered" || message.state === "acknowledged") continue;
          if (message.state !== "pending") throw new Error("Payout report has an uncertain message and cannot be resent.");
          // Persist the claim first. A stop between this and Discord is
          // intentionally recovered as uncertain rather than duplicated.
          run = await updatePayoutRun(runId, (record) => {
            record.reportMessages![index]!.state = "sending";
          });
          let messageId: string;
          if (delivery.sendPage) {
            messageId = await delivery.sendPage(run, prepared.pages[index]!, message.nonce);
          } else {
            if (messages.length !== 1 || !delivery.send) {
              throw new Error("The payout report requires paged Discord delivery, but the delivery adapter cannot send pages.");
            }
            const ids = await delivery.send(run);
            messageId = ids[0] ?? "";
          }
          if (!messageId) throw new Error("Discord did not return a delivered report message ID.");
          run = await updatePayoutRun(runId, (record) => {
            const item = record.reportMessages![index]!;
            item.state = "delivered";
            item.messageId = messageId;
            record.reportMessageIds = record.reportMessages!
              .flatMap((candidate) => candidate.messageId ? [candidate.messageId] : []);
          });
        }
        run = await updatePayoutRun(runId, (record) => {
          record.reportState = "delivered";
          record.state = "reported";
          delete record.failure;
        });
      } catch (error) {
        await updatePayoutRun(runId, (record) => {
          for (const message of record.reportMessages ?? []) {
            if (message.state === "sending") message.state = "uncertain";
          }
          record.reportState = "uncertain";
          record.failure = `Payout report was not confirmed delivered: ${error instanceof Error ? error.message : String(error)}`;
        });
        throw new Error("Payout report delivery was not confirmed. No spreadsheet cells were cleared; recover this run instead of sending a duplicate report.");
      }
    }
    if ((run.reportMessages ?? []).some((message) =>
      message.state !== "delivered" && message.state !== "acknowledged",
    )) {
      throw new Error("Payout report delivery is incomplete. No spreadsheet cells were cleared.");
    }
    await updatePayoutRun(runId, (record) => { record.state = "clearing"; });
    try {
      await clearArchivedPayout(client, run, snapshot);
      run = await updatePayoutRun(runId, (record) => { record.state = "cleared"; });
    } catch (error) {
      await updatePayoutRun(runId, (record) => {
        record.state = "unsafe";
        record.failure = error instanceof Error ? error.message : String(error);
      });
      throw error;
    }
    // These durable invalidations happen before lock release, so old buttons
    // and retries cannot reopen a completed payout cycle.
    return completePayoutRun(run);
  });
}

/**
 * Recovery path for an ambiguous Sheets reset. It never repeats batchUpdate:
 * it first proves the exact archived scoped cells are now clear/false.
 */
export async function recoverUnknownPayoutClear(
  client: PayoutSheetsClient,
  runId: string,
): Promise<PayoutRun> {
  const initial = await getPayoutRun(runId);
  if (!initial) throw new Error("The payout run is unavailable.");
  await acquirePayoutLock(initial.spreadsheetId, runId);
  return withPayoutWorkbookExclusivity(initial.spreadsheetId, async () => {
    const run = await getPayoutRun(runId);
    if (!run) throw new Error("The payout run is unavailable.");
    if (run.state === "complete") return finalizePayoutRun(run.runId);
    if (run.state !== "unsafe" && run.state !== "cleared" && run.state !== "clearing") {
      throw new Error("This payout run is not awaiting reset-outcome recovery.");
    }
    const snapshot = await snapshotForArchivedRun(client, run);
    // Payout formulas may legitimately recalculate after a successful reset.
    // This path therefore verifies only the archived workbook/range identity
    // and exact blank/false postcondition; it never deletes again.
    if (!await clearStateMatches(client, snapshot)) {
      throw new Error("The archived reset cells do not match the intended cleared snapshot. No reset was repeated.");
    }
    return completePayoutRun(run);
  });
}

async function snapshotForArchivedRun(client: PayoutSheetsClient, run: PayoutRun): Promise<PayoutSnapshot> {
  // Reading config from the archive avoids later setup edits redirecting a
  // confirmed reset. Ranges and sheet IDs are re-derived from current metadata
  // only to construct the scoped batch request; old values are still compared.
  const grids = await client.grids(run.spreadsheetId);
  const archived = run.clearCells;
  if (archived.length !== 3) throw new Error("Payout archive is incomplete; no reset can be resumed.");
  const parseArchived = (index: number): { tab: string; range: A1Range } => {
    const cell = archived[index]!;
    const separator = cell.range.lastIndexOf("!");
    const tab = cell.range.slice(0, separator);
    const grid = requireGrid(grids, tab);
    return { tab, range: parseRange(cell.range.slice(separator + 1), grid.rowCount) };
  };
  const log = parseArchived(0);
  const moderated = parseArchived(1);
  const logGrid = requireGrid(grids, log.tab);
  const moderatedGrid = requireGrid(grids, moderated.tab);
  const sold = parseArchived(2);
  if (sold.tab !== log.tab || sold.range.startColumn !== 6 || sold.range.endColumn !== 6 ||
      sold.range.startRow !== log.range.startRow || sold.range.endRow !== log.range.endRow) {
    throw new Error("Payout archive Sold range is incompatible; no reset can be resumed.");
  }
  return {
    spreadsheet: {
      spreadsheetId: run.spreadsheetId, logTab: log.tab, moderatedTab: moderated.tab,
      logRange: log.range.a1.replace(/\d+$/, ""), moderatedRange: moderated.range.a1.replace(/\d+$/, ""),
      createMissingTabs: false,
    },
    sourceValues: run.sourceValues, sourceFingerprint: run.sourceFingerprint,
    grandTotal: run.grandTotal, roles: run.roles, clearCells: archived,
    grids: {
      log: { title: log.tab, sheetId: logGrid.sheetId, range: log.range },
      moderated: { title: moderated.tab, sheetId: moderatedGrid.sheetId, range: moderated.range },
    },
  };
}
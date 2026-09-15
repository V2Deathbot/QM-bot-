import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { config } from "./config";

/**
 * These are the only user-data cells written by the two commands.  They are
 * intentionally not worksheet headers: the administrator owns the sheet's
 * header row, formatting, checkbox columns, and every other column.
 */
export const LOG_UNIFORM_COLUMN_COUNT = 5;
export const MODERATED_UNIFORM_COLUMN_COUNT = 4;
/** Kept as a compatibility export for callers which write /log rows. */
export const UNIFORM_DETAIL_COLUMN_COUNT = LOG_UNIFORM_COLUMN_COUNT;
export const UNIFORM_SHEET_HEADERS = [] as const;
export const UNIFORM_STORAGE_HEADERS = [] as const;
export type UniformSheetRow = string[];

export interface UniformSpreadsheetConfig {
  spreadsheetId: string;
  logTab: string;
  moderatedTab: string;
  /** User-owned cells for /log, e.g. A2:E, A2:E500, or C5:G. */
  logRange?: string;
  /** User-owned cells for /moderated, e.g. A2:D, A2:D500, or C5:F. */
  moderatedRange?: string;
  /** Obsolete setting. Tabs and headers are never created by this bot. */
  createMissingTabs?: boolean;
}

export interface SpreadsheetValidationResult {
  spreadsheetId: string;
  logTab: string;
  moderatedTab: string;
  logRange: string;
  moderatedRange: string;
  createMissingTabs: false;
}

export interface AppendUniformRowsInput {
  config: UniformSpreadsheetConfig;
  logKind: "log" | "moderated";
  rows: UniformSheetRow[];
  submissionId: string;
}

export interface AppendUniformRowsResult {
  alreadyWritten: boolean;
  alreadyNotified?: boolean;
  count: number;
}

export interface MarkUniformRowsNotifiedResult {
  alreadyNotified: boolean;
  count: number;
}

export type SheetsProxy = (
  path: string,
  options?: { method?: string; body?: unknown; headers?: Record<string, string> },
) => Promise<Response>;

let proxyOverride: SheetsProxy | undefined;
export function setGoogleSheetsProxyForTests(proxy: SheetsProxy): void { proxyOverride = proxy; }
export function resetGoogleSheetsProxyForTests(): void { proxyOverride = undefined; }
async function proxy(pathname: string, options?: Parameters<SheetsProxy>[1]): Promise<Response> {
  return proxyOverride
    ? proxyOverride(pathname, options)
    : new ReplitConnectors().proxy("google-sheet", pathname, options);
}

function errorText(response: Response): string {
  return `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`.trim();
}
async function jsonResponse<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) throw new Error(`Google Sheets ${operation} failed (${errorText(response)}).`);
  try { return await response.json() as T; }
  catch { throw new Error(`Google Sheets ${operation} returned invalid JSON.`); }
}
function assertText(value: string, label: string, maxLength: number): string {
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${label} must be a non-empty value of at most ${maxLength} characters.`);
  }
  return text;
}

export function normalizeSpreadsheetId(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter a Google Sheets spreadsheet URL or spreadsheet ID.");
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("Spreadsheet must be a Google Sheets URL or spreadsheet ID."); }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "docs.google.com") {
    throw new Error("Spreadsheet URL must use https://docs.google.com/spreadsheets/d/<ID>.");
  }
  const match = /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/edit)?\/?$/.exec(parsed.pathname);
  if (!match || parsed.username || parsed.password) {
    throw new Error("Spreadsheet URL must exactly match docs.google.com/spreadsheets/d/<ID> (optionally /edit).");
  }
  return match[1]!;
}
export function normalizeSheetTab(input: string, label: string): string {
  const tab = assertText(input, label, 100);
  if (tab.includes("!")) throw new Error(`${label} cannot contain "!"; enter only a worksheet tab name.`);
  return tab;
}
export function quoteSheetTab(tab: string): string { return `'${tab.replaceAll("'", "''")}'`; }

interface DataRange {
  startColumn: number;
  endColumn: number;
  startRow: number;
  endRow?: number;
  normalized: string;
}
function columnNumber(letters: string): number {
  return [...letters].reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0);
}
function columnLetters(number: number): string {
  let value = number;
  let result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}
/**
 * A data range never contains a tab name. This prevents a settings value from
 * selecting a different sheet than the separately configured tab.
 */
export function normalizeUniformDataRange(input: string | undefined, width: number, label: string): string {
  const fallback = width === LOG_UNIFORM_COLUMN_COUNT ? "A2:E" : "A2:D";
  const value = (input?.trim() || fallback).toUpperCase();
  const match = /^([A-Z]+)([1-9]\d*):([A-Z]+)([1-9]\d*)?$/.exec(value);
  if (!match) {
    throw new Error(`${label} must be an A1 rectangle such as A2:${columnLetters(width)} or C5:${columnLetters(width + 2)}100.`);
  }
  const startColumn = columnNumber(match[1]!);
  const endColumn = columnNumber(match[3]!);
  const startRow = Number(match[2]!);
  const endRow = match[4] ? Number(match[4]) : undefined;
  if (endColumn - startColumn + 1 !== width || endColumn < startColumn) {
    throw new Error(`${label} must be exactly ${width} columns wide.`);
  }
  if (startRow < 2) throw new Error(`${label} must start below the header row (row 2 or later).`);
  if (endRow !== undefined && endRow < startRow) throw new Error(`${label} ends before it starts.`);
  return `${match[1]}${startRow}:${match[3]}${endRow ?? ""}`;
}
function parseDataRange(value: string): DataRange {
  const match = /^([A-Z]+)([1-9]\d*):([A-Z]+)([1-9]\d*)?$/.exec(value)!;
  return {
    startColumn: columnNumber(match[1]!),
    endColumn: columnNumber(match[3]!),
    startRow: Number(match[2]!),
    endRow: match[4] ? Number(match[4]) : undefined,
    normalized: value,
  };
}

export function normalizeUniformSpreadsheetConfig(input: UniformSpreadsheetConfig): SpreadsheetValidationResult {
  // Older settings may retain this historical opt-in.  It is deliberately
  // ignored rather than making an otherwise valid existing destination
  // unusable; this module never creates sheets or headers regardless.
  const spreadsheetId = normalizeSpreadsheetId(input.spreadsheetId);
  const logTab = normalizeSheetTab(input.logTab || "Uniform Logs", "The /log tab");
  const moderatedTab = normalizeSheetTab(input.moderatedTab || "Moderated Logs", "The /moderated tab");
  if (logTab.toLocaleLowerCase() === moderatedTab.toLocaleLowerCase()) {
    throw new Error("The /log and /moderated tabs must be different worksheets.");
  }
  return {
    spreadsheetId, logTab, moderatedTab,
    logRange: normalizeUniformDataRange(input.logRange, LOG_UNIFORM_COLUMN_COUNT, "The /log data range"),
    moderatedRange: normalizeUniformDataRange(input.moderatedRange, MODERATED_UNIFORM_COLUMN_COUNT, "The /moderated data range"),
    createMissingTabs: false,
  };
}

function rangePath(spreadsheetId: string, tab: string, range: string): string {
  return `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${quoteSheetTab(tab)}!${range}`)}`;
}
interface SheetMetadata {
  sheets?: Array<{ properties?: { title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } }>;
}
interface ValuesResponse { values?: unknown[][]; }
async function spreadsheetMetadata(spreadsheetId: string): Promise<SheetMetadata> {
  return jsonResponse(await proxy(
    `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(title,gridProperties(rowCount,columnCount)))`,
    { method: "GET" },
  ), "spreadsheet metadata lookup");
}

/**
 * Saving settings validates only that the configured existing tab and columns
 * exist. It never creates a tab, writes a header, or inspects/changes values.
 */
export async function validateSpreadsheetConfiguration(input: UniformSpreadsheetConfig): Promise<SpreadsheetValidationResult> {
  const normalized = normalizeUniformSpreadsheetConfig(input);
  const metadata = await spreadsheetMetadata(normalized.spreadsheetId);
  for (const [tab, range] of [[normalized.logTab, normalized.logRange], [normalized.moderatedTab, normalized.moderatedRange]] as const) {
    const sheet = metadata.sheets?.find((candidate) => candidate.properties?.title === tab);
    if (!sheet) throw new Error(`Google Sheets worksheet "${tab}" does not exist. Existing sheets are never created automatically.`);
    const parsed = parseDataRange(range);
    const columns = sheet.properties?.gridProperties?.columnCount;
    if (columns !== undefined && parsed.endColumn > columns) {
      throw new Error(`The ${tab} worksheet has only ${columns} columns; configured range ${range} is outside its grid.`);
    }
  }
  return normalized;
}

interface SubmissionLedgerEntry {
  key: string;
  destination: string;
  submissionId: string;
  targetRange: string;
  values: string[][];
  state: "reserved" | "written";
  notified: boolean;
  createdAt: string;
}
interface SubmissionLedger { entries: SubmissionLedgerEntry[]; }
let ledgerQueue: Promise<void> = Promise.resolve();
let destinationQueues = new Map<string, Promise<void>>();
let ledgerWriteFailureForTests: Error | undefined;
async function readLedger(): Promise<SubmissionLedger> {
  try {
    const parsed = JSON.parse(await readFile(config.uniformSubmissionLedgerFile, "utf8")) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) throw new Error("Uniform submission ledger has an invalid format.");
    return { entries: parsed.entries.filter((entry): entry is SubmissionLedgerEntry =>
      Boolean(entry) && typeof entry === "object" &&
      typeof (entry as SubmissionLedgerEntry).key === "string" &&
      Array.isArray((entry as SubmissionLedgerEntry).values),
    ) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
    throw error;
  }
}
async function writeLedger(ledger: SubmissionLedger): Promise<void> {
  if (ledgerWriteFailureForTests) throw ledgerWriteFailureForTests;
  const directory = path.dirname(config.uniformSubmissionLedgerFile);
  const temporary = `${config.uniformSubmissionLedgerFile}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, JSON.stringify(ledger, null, 2), "utf8");
  await rename(temporary, config.uniformSubmissionLedgerFile);
}
async function withLedger<T>(operation: (ledger: SubmissionLedger) => Promise<T> | T): Promise<T> {
  const result = ledgerQueue.then(async () => {
    const ledger = await readLedger();
    const value = await operation(ledger);
    await writeLedger(ledger);
    return value;
  });
  ledgerQueue = result.then(() => undefined, () => undefined);
  return result;
}
async function serialDestination<T>(destination: string, work: () => Promise<T>): Promise<T> {
  const prior = destinationQueues.get(destination) ?? Promise.resolve();
  const result = prior.then(work, work);
  const tail = result.then(() => undefined, () => undefined);
  destinationQueues.set(destination, tail);
  try { return await result; }
  finally {
    if (destinationQueues.get(destination) === tail) destinationQueues.delete(destination);
  }
}
export function resetUniformSubmissionLedgerForTests(): void {
  ledgerQueue = Promise.resolve();
  destinationQueues = new Map();
  ledgerWriteFailureForTests = undefined;
}
/** Test-only fault injection for the local notification bookkeeping path. */
export function setUniformSubmissionLedgerWriteFailureForTests(error?: Error): void {
  ledgerWriteFailureForTests = error;
}

function destinationFor(config: SpreadsheetValidationResult, kind: "log" | "moderated"): { tab: string; range: DataRange; destination: string } {
  const tab = kind === "log" ? config.logTab : config.moderatedTab;
  const range = parseDataRange(kind === "log" ? config.logRange : config.moderatedRange);
  return { tab, range, destination: `${config.spreadsheetId}\u0000${tab}\u0000${range.normalized}` };
}
function recordKey(destination: string, submissionId: string): string { return `${destination}\u0000${submissionId}`; }
function nonempty(cell: unknown): boolean { return String(cell ?? "").trim() !== ""; }
function equalsValues(actual: unknown[][], expected: string[][]): boolean {
  return expected.every((row, rowIndex) => row.every(
    (cell, columnIndex) => String(actual[rowIndex]?.[columnIndex] ?? "") === cell,
  ));
}
async function readRange(spreadsheetId: string, tab: string, range: string): Promise<unknown[][]> {
  const output = await jsonResponse<ValuesResponse>(
    await proxy(`${rangePath(spreadsheetId, tab, range)}?valueRenderOption=FORMULA`, { method: "GET" }),
    `worksheet "${tab}" lookup`,
  );
  return Array.isArray(output.values) ? output.values : [];
}
async function verifyReservation(config: SpreadsheetValidationResult, tab: string, entry: SubmissionLedgerEntry): Promise<boolean> {
  const actual = await readRange(config.spreadsheetId, tab, entry.targetRange);
  return equalsValues(actual, entry.values);
}

export async function appendUniformRows(input: AppendUniformRowsInput): Promise<AppendUniformRowsResult> {
  const normalized = normalizeUniformSpreadsheetConfig(input.config);
  const width = input.logKind === "log" ? LOG_UNIFORM_COLUMN_COUNT : MODERATED_UNIFORM_COLUMN_COUNT;
  if (!input.submissionId.trim()) throw new Error("The Discord interaction has no submission ID.");
  if (!input.rows.length || input.rows.some((row) => row.length !== width || row.some((value) => typeof value !== "string"))) {
    throw new Error(`/${input.logKind} rows must contain exactly ${width} text cells.`);
  }
  const { tab, range, destination } = destinationFor(normalized, input.logKind);
  const key = recordKey(destination, input.submissionId);
  return serialDestination(destination, async () => {
    let existing = await withLedger((ledger) => ledger.entries.find((entry) => entry.key === key));
    if (existing) {
      if (existing.state === "reserved") {
        let committed = false;
        try { committed = await verifyReservation(normalized, tab, existing); } catch { /* preserve conservative reservation */ }
        if (committed) {
          existing = await withLedger((ledger) => {
            const entry = ledger.entries.find((candidate) => candidate.key === key)!;
            entry.state = "written";
            return entry;
          });
        } else {
          throw new Error("The prior Google Sheets write is uncertain. The reserved cells were not overwritten; do not resubmit until an administrator verifies them.");
        }
      }
      return { alreadyWritten: true, count: 0, ...(existing.notified ? { alreadyNotified: true } : {}) };
    }

    const values = await readRange(normalized.spreadsheetId, tab, range.normalized);
    let lastRow = range.startRow - 1;
    for (const [offset, row] of values.entries()) {
      if (Array.isArray(row) && row.some(nonempty)) lastRow = range.startRow + offset;
    }
    const reservations = await withLedger((ledger) => ledger.entries.filter((entry) =>
      entry.destination === destination && entry.state === "reserved",
    ));
    for (const reservation of reservations) {
      const end = Number(/(\d+)$/.exec(reservation.targetRange)?.[1] ?? 0);
      lastRow = Math.max(lastRow, end);
    }
    const start = lastRow + 1;
    const end = start + input.rows.length - 1;
    if (range.endRow !== undefined && end > range.endRow) {
      throw new Error(`The configured ${range.normalized} range is full. No Google Sheets cells were changed.`);
    }
    const targetRange = `${columnLetters(range.startColumn)}${start}:${columnLetters(range.endColumn)}${end}`;
    const reservation: SubmissionLedgerEntry = {
      key, destination, submissionId: input.submissionId, targetRange,
      values: input.rows.map((row) => [...row]), state: "reserved", notified: false,
      createdAt: new Date().toISOString(),
    };
    await withLedger((ledger) => { ledger.entries.push(reservation); });
    try {
      await jsonResponse(await proxy(
        `${rangePath(normalized.spreadsheetId, tab, targetRange)}?valueInputOption=RAW`,
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: {
          range: `${quoteSheetTab(tab)}!${targetRange}`, majorDimension: "ROWS", values: reservation.values,
        } },
      ), "uniform row update");
      await withLedger((ledger) => {
        const entry = ledger.entries.find((candidate) => candidate.key === key)!;
        entry.state = "written";
      });
    } catch (error) {
      try {
        if (await verifyReservation(normalized, tab, reservation)) {
          await withLedger((ledger) => {
            const entry = ledger.entries.find((candidate) => candidate.key === key)!;
            entry.state = "written";
          });
          return { alreadyWritten: true, count: 0 };
        }
      } catch { /* retain reservation and original failure */ }
      throw error;
    }
    return { alreadyWritten: false, count: input.rows.length };
  });
}

/** Notification state is local bookkeeping, never an extra spreadsheet column. */
export async function markUniformRowsNotified(
  configInput: UniformSpreadsheetConfig,
  logKind: "log" | "moderated",
  submissionId: string,
  _discordMessageId = "",
): Promise<MarkUniformRowsNotifiedResult> {
  const config = normalizeUniformSpreadsheetConfig(configInput);
  const { destination } = destinationFor(config, logKind);
  const key = recordKey(destination, submissionId);
  return withLedger((ledger) => {
    const entry = ledger.entries.find((candidate) => candidate.key === key);
    if (!entry || entry.state !== "written") throw new Error(`No completed local record exists for submission ${submissionId}.`);
    if (entry.notified) return { alreadyNotified: true, count: entry.values.length };
    entry.notified = true;
    return { alreadyNotified: false, count: entry.values.length };
  });
}
import { ReplitConnectors } from "@replit/connectors-sdk";

/**
 * The sheet is deliberately a small, fixed schema.  Keeping this schema in
 * one place lets configuration validation and append-time validation reject a
 * worksheet that belongs to another application instead of writing into it.
 */
export const UNIFORM_SHEET_HEADERS = [
  "Timestamp",
  "Log Kind",
  "Customer Username",
  "Customer ID",
  "QM Username",
  "QM ID",
  "SEQM Username",
  "SEQM ID",
  "Uploader Username",
  "Uploader ID",
  "Publisher Username",
  "Publisher ID",
  "Asset ID",
  "Asset Link",
  "Submitter Discord ID",
  "Guild ID",
  "Submission ID",
] as const;

/** Internal bookkeeping columns kept beside the fixed 17-column detail schema. */
export const UNIFORM_NOTIFICATION_HEADERS = [
  "Notification Status",
  "Discord Message ID",
] as const;

/** Columns supplied by the uniform command before notification bookkeeping. */
export const UNIFORM_DETAIL_COLUMN_COUNT = UNIFORM_SHEET_HEADERS.length;
export const UNIFORM_STORAGE_HEADERS = [
  ...UNIFORM_SHEET_HEADERS,
  ...UNIFORM_NOTIFICATION_HEADERS,
] as const;

export type UniformSheetRow = [
  timestamp: string,
  logKind: string,
  customerUsername: string,
  customerId: string,
  qmUsername: string,
  qmId: string,
  seqmUsername: string,
  seqmId: string,
  uploaderUsername: string,
  uploaderId: string,
  publisherUsername: string,
  publisherId: string,
  assetId: string,
  assetLink: string,
  submitterDiscordId: string,
  guildId: string,
  submissionId: string,
];

export type UniformStoredSheetRow = [
  ...UniformSheetRow,
  notificationStatus: string,
  discordMessageId: string,
];

export interface UniformSpreadsheetConfig {
  /** Canonical Google spreadsheet ID, not an arbitrary API path. */
  spreadsheetId: string;
  logTab: string;
  moderatedTab: string;
  /**
   * Missing tabs are only created when an administrator explicitly opts in
   * during configuration.  The safe default is false.
   */
  createMissingTabs?: boolean;
}

export interface SpreadsheetValidationResult {
  spreadsheetId: string;
  logTab: string;
  moderatedTab: string;
  createMissingTabs: boolean;
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
  options?: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  },
) => Promise<Response>;

let proxyOverride: SheetsProxy | undefined;

/**
 * Tests may inject a response-only proxy. Production always creates a fresh
 * SDK instance so credentials are resolved by Replit and never handled here.
 */
export function setGoogleSheetsProxyForTests(proxy: SheetsProxy): void {
  proxyOverride = proxy;
}

export function resetGoogleSheetsProxyForTests(): void {
  proxyOverride = undefined;
}

async function proxy(path: string, options?: Parameters<SheetsProxy>[1]): Promise<Response> {
  if (proxyOverride) return proxyOverride(path, options);
  return new ReplitConnectors().proxy("google-sheet", path, options);
}

function errorText(response: Response): string {
  return `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`.trim();
}

async function jsonResponse<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) {
    throw new Error(`Google Sheets ${operation} failed (${errorText(response)}).`);
  }
  try {
    return await response.json() as T;
  } catch {
    throw new Error(`Google Sheets ${operation} returned invalid JSON.`);
  }
}

function assertText(value: string, label: string, maxLength: number): string {
  const text = value.trim();
  if (
    !text ||
    text.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(text)
  ) {
    throw new Error(`${label} must be a non-empty value of at most ${maxLength} characters.`);
  }
  return text;
}

/**
 * Accept either a bare spreadsheet ID or the normal Google Sheets URL.  Do
 * not accept a URL with a user-selected API path: all paths used below are
 * built by this module.
 */
export function normalizeSpreadsheetId(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter a Google Sheets spreadsheet URL or spreadsheet ID.");

  if (/^[A-Za-z0-9_-]+$/.test(value)) return value;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Spreadsheet must be a Google Sheets URL or spreadsheet ID.");
  }
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
  if (tab.includes("!")) {
    throw new Error(`${label} cannot contain "!"; enter only a worksheet tab name.`);
  }
  return tab;
}

export function normalizeUniformSpreadsheetConfig(
  config: UniformSpreadsheetConfig,
): SpreadsheetValidationResult {
  const spreadsheetId = normalizeSpreadsheetId(config.spreadsheetId);
  const logTab = normalizeSheetTab(config.logTab || "Uniform Logs", "The /log tab");
  const moderatedTab = normalizeSheetTab(
    config.moderatedTab || "Moderated Logs",
    "The /moderated tab",
  );
  if (logTab.toLocaleLowerCase() === moderatedTab.toLocaleLowerCase()) {
    throw new Error("The /log and /moderated tabs must be different dedicated worksheets.");
  }
  return {
    spreadsheetId,
    logTab,
    moderatedTab,
    createMissingTabs: config.createMissingTabs === true,
  };
}

/** Quote a tab for a Google A1 range, including the required apostrophe escape. */
export function quoteSheetTab(tab: string): string {
  return `'${tab.replaceAll("'", "''")}'`;
}

function rangePath(
  spreadsheetId: string,
  tab: string,
  range = "A:S",
): string {
  const quotedRange = `${quoteSheetTab(tab)}!${range}`;
  return `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(quotedRange)}`;
}

function metadataPath(spreadsheetId: string): string {
  return `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(sheetId,title))`;
}

interface SheetMetadata {
  sheets?: Array<{ properties?: { title?: string; sheetId?: number } }>;
}

interface ValuesResponse {
  values?: unknown[][];
}

interface ExistingSubmissionRows {
  rowNumbers: number[];
  alreadyNotified: boolean;
}

async function spreadsheetMetadata(spreadsheetId: string): Promise<SheetMetadata> {
  return jsonResponse<SheetMetadata>(
    await proxy(metadataPath(spreadsheetId), { method: "GET" }),
    "spreadsheet metadata lookup",
  );
}

async function tabValues(spreadsheetId: string, tab: string): Promise<unknown[][]> {
  const result = await jsonResponse<ValuesResponse>(
    await proxy(`${rangePath(spreadsheetId, tab)}?valueRenderOption=FORMULA`, { method: "GET" }),
    `worksheet "${tab}" lookup`,
  );
  return Array.isArray(result.values) ? result.values : [];
}

function headerRow(values: unknown[][]): unknown[] {
  const first = values[0];
  return Array.isArray(first) ? first : [];
}

function isBlankTable(values: unknown[][]): boolean {
  return values.length === 0 || values.every((row) =>
    !Array.isArray(row) || row.every((cell) => String(cell ?? "").trim() === ""),
  );
}

function hasExpectedHeaders(values: unknown[][]): boolean {
  const header = headerRow(values);
  return (
    (header.length === UNIFORM_SHEET_HEADERS.length &&
      UNIFORM_SHEET_HEADERS.every((expected, index) => String(header[index] ?? "") === expected)) ||
    (header.length === UNIFORM_STORAGE_HEADERS.length &&
      UNIFORM_STORAGE_HEADERS.every((expected, index) => String(header[index] ?? "") === expected))
  );
}

function missingTabNames(metadata: SheetMetadata, tabs: string[]): Set<string> {
  const names = new Set(
    (metadata.sheets ?? [])
      .map((sheet) => sheet.properties?.title)
      .filter((title): title is string => Boolean(title)),
  );
  return new Set(tabs.filter((tab) => !names.has(tab)));
}

async function addTabs(spreadsheetId: string, tabs: string[]): Promise<void> {
  if (!tabs.length) return;
  const response = await proxy(
    `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        requests: tabs.map((title) => ({ addSheet: { properties: { title } } })),
      },
    },
  );
  await jsonResponse<unknown>(response, "worksheet creation");
}

async function writeHeader(spreadsheetId: string, tab: string): Promise<void> {
  const response = await proxy(
    `${rangePath(spreadsheetId, tab, "A1:S1")}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: {
        range: `${quoteSheetTab(tab)}!A1:S1`,
        majorDimension: "ROWS",
        values: [Array.from(UNIFORM_STORAGE_HEADERS)],
      },
    },
  );
  await jsonResponse<unknown>(response, `header creation for "${tab}"`);
}

/**
 * Validate both dedicated worksheets before saving the configuration.  Reads
 * for every tab happen before any optional creation/header writes, so a
 * mismatched existing header fails with zero writes.
 */
export async function validateSpreadsheetConfiguration(
  input: UniformSpreadsheetConfig,
): Promise<SpreadsheetValidationResult> {
  const config = normalizeUniformSpreadsheetConfig(input);
  const tabs = [config.logTab, config.moderatedTab];
  const metadata = await spreadsheetMetadata(config.spreadsheetId);
  const missing = missingTabNames(metadata, tabs);
  if (missing.size && !config.createMissingTabs) {
    throw new Error(
      `Google Sheets worksheet(s) ${[...missing].map((tab) => `"${tab}"`).join(", ")} do not exist. ` +
      "Create those dedicated tabs first, or explicitly enable “Create missing tabs” and save again.",
    );
  }

  const existingTabs = tabs.filter((tab) => !missing.has(tab));
  const values = new Map<string, unknown[][]>();
  for (const tab of existingTabs) {
    const rows = await tabValues(config.spreadsheetId, tab);
    values.set(tab, rows);
    if (!isBlankTable(rows) && !hasExpectedHeaders(rows)) {
      throw new Error(
        `Google Sheets worksheet "${tab}" has incompatible headers. ` +
        "Use a blank dedicated worksheet or make its first row match the Uniform Logs headers exactly; existing data was not changed.",
      );
    }
  }

  const missingNames = [...missing];
  await addTabs(config.spreadsheetId, missingNames);
  for (const tab of tabs) {
    if (missing.has(tab) || isBlankTable(values.get(tab) ?? [])) {
      await writeHeader(config.spreadsheetId, tab);
    }
  }
  return config;
}

async function existingSubmissionIds(
  spreadsheetId: string,
  tab: string,
  submissionId?: string,
): Promise<Set<string> | ExistingSubmissionRows> {
  const values = await tabValues(spreadsheetId, tab);
  if (isBlankTable(values)) {
    throw new Error(
      `Google Sheets worksheet "${tab}" is missing its required header row. Re-save Spreadsheet Configuration before logging.`,
    );
  }
  if (!hasExpectedHeaders(values)) {
    throw new Error(
      `Google Sheets worksheet "${tab}" has incompatible headers. No uniform rows were written.`,
    );
  }
  const submissionIndex = UNIFORM_SHEET_HEADERS.indexOf("Submission ID");
  const notificationIndex = UNIFORM_STORAGE_HEADERS.indexOf("Notification Status");
  const ids = new Set<string>();
  const rowNumbers: number[] = [];
  const statuses: string[] = [];
  for (const [offset, row] of values.slice(1).entries()) {
    if (Array.isArray(row) && row[submissionIndex] !== undefined) {
      const id = String(row[submissionIndex]).trim();
      if (id) {
        ids.add(id);
        if (submissionId && id === submissionId) {
          rowNumbers.push(offset + 2);
          statuses.push(String(row[notificationIndex] ?? "").trim().toUpperCase());
        }
      }
    }
  }
  if (submissionId) {
    return {
      rowNumbers,
      alreadyNotified: rowNumbers.length > 0 && statuses.every((status) => status === "NOTIFIED"),
    };
  }
  return ids;
}

export async function appendUniformRows(
  input: AppendUniformRowsInput,
): Promise<AppendUniformRowsResult> {
  const config = normalizeUniformSpreadsheetConfig(input.config);
  if (!input.submissionId.trim()) throw new Error("The Discord interaction has no submission ID.");
  if (!input.rows.length) throw new Error("There are no uniform rows to append.");
  if (input.rows.some((row) =>
    row.length !== UNIFORM_DETAIL_COLUMN_COUNT &&
    row.length !== UNIFORM_SHEET_HEADERS.length ||
    row.some((cell) => typeof cell !== "string"),
  )) {
    throw new Error("Uniform rows do not match the configured Google Sheets schema.");
  }
  const tab = input.logKind === "log" ? config.logTab : config.moderatedTab;
  const existing = await existingSubmissionIds(config.spreadsheetId, tab, input.submissionId) as ExistingSubmissionRows;
  if (existing.rowNumbers.length) {
    return {
      alreadyWritten: true,
      count: 0,
      ...(existing.alreadyNotified ? { alreadyNotified: true } : {}),
    };
  }

  const storedRows: UniformStoredSheetRow[] = input.rows.map((row) => [
    ...row.slice(0, UNIFORM_DETAIL_COLUMN_COUNT),
    "PENDING",
    "",
  ] as UniformStoredSheetRow);
  try {
    const response = await proxy(
      `${rangePath(config.spreadsheetId, tab)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          majorDimension: "ROWS",
          values: storedRows,
        },
      },
    );
    await jsonResponse<unknown>(response, "uniform row append");
  } catch (error) {
    // A connector timeout can happen after Sheets committed the append. Verify
    // the keyed rows before surfacing the failure, allowing this invocation to
    // continue to its one Discord notice without ever appending again.
    try {
      const verified = await existingSubmissionIds(
        config.spreadsheetId,
        tab,
        input.submissionId,
      ) as ExistingSubmissionRows;
      if (verified.rowNumbers.length) {
        return {
          alreadyWritten: true,
          count: 0,
          ...(verified.alreadyNotified ? { alreadyNotified: true } : {}),
        };
      }
    } catch {
      // Preserve the original append error when verification is unavailable.
    }
    throw error;
  }
  return { alreadyWritten: false, count: input.rows.length };
}

/**
 * Mark all rows for one submission as notified after the Discord send
 * succeeds. The keyed Submission ID lookup makes retries after an uncertain
 * append or a failed status update safe without appending duplicate rows.
 */
export async function markUniformRowsNotified(
  configInput: UniformSpreadsheetConfig,
  logKind: "log" | "moderated",
  submissionId: string,
  discordMessageId = "",
): Promise<MarkUniformRowsNotifiedResult> {
  const config = normalizeUniformSpreadsheetConfig(configInput);
  if (!submissionId.trim()) throw new Error("The Discord interaction has no submission ID.");
  const tab = logKind === "log" ? config.logTab : config.moderatedTab;
  const existing = await existingSubmissionIds(
    config.spreadsheetId,
    tab,
    submissionId,
  ) as ExistingSubmissionRows;
  if (!existing.rowNumbers.length) {
    throw new Error(`Google Sheets has no rows for submission ${submissionId}.`);
  }
  if (existing.alreadyNotified) {
    return { alreadyNotified: true, count: existing.rowNumbers.length };
  }

  const statusColumn = "R";
  const messageColumn = "S";
  const response = await proxy(
    `/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}/values:batchUpdate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        valueInputOption: "RAW",
        data: existing.rowNumbers.map((rowNumber) => ({
          range: `${quoteSheetTab(tab)}!${statusColumn}${rowNumber}:${messageColumn}${rowNumber}`,
          majorDimension: "ROWS",
          values: [["NOTIFIED", discordMessageId]],
        })),
      },
    },
  );
  await jsonResponse<unknown>(response, "uniform notification status update");
  return { alreadyNotified: false, count: existing.rowNumbers.length };
}

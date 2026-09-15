import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import {
  appendUniformRows,
  markUniformRowsNotified,
  normalizeSpreadsheetId,
  quoteSheetTab,
  resetGoogleSheetsProxyForTests,
  setGoogleSheetsProxyForTests,
  UNIFORM_SHEET_HEADERS,
  UNIFORM_STORAGE_HEADERS,
  UNIFORM_DETAIL_COLUMN_COUNT,
  validateSpreadsheetConfiguration,
  type UniformSheetRow,
} from "../src/bot/google-sheets.ts";

afterEach(() => resetGoogleSheetsProxyForTests());

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function values() {
  return { values: [Array.from(UNIFORM_SHEET_HEADERS)] };
}

test("normalizes spreadsheet URLs and quotes worksheet names for A1 paths", () => {
  assert.equal(
    normalizeSpreadsheetId("https://docs.google.com/spreadsheets/d/abc_123/edit#gid=1"),
    "abc_123",
  );
  assert.equal(normalizeSpreadsheetId("abc_123"), "abc_123");
  assert.equal(quoteSheetTab("Owner's Uniform Logs"), "'Owner''s Uniform Logs'");
  assert.throws(
    () => normalizeSpreadsheetId("https://evil.example/spreadsheets/d/abc_123"),
    /docs\.google\.com/i,
  );
});

test("appends ten detailed rows once with RAW input and the fixed schema", async () => {
  const calls: Array<{ path: string; options?: { method?: string; body?: unknown } }> = [];
  setGoogleSheetsProxyForTests(async (path, options) => {
    calls.push({ path, options });
    if (options?.method === "GET") return response(values());
    return response({ updates: { updatedRows: 10 } });
  });
  const rows = Array.from({ length: 10 }, (_, index) =>
    Array.from({ length: UNIFORM_DETAIL_COLUMN_COUNT }, (_value, column) =>
      `${column === 16 ? "interaction-1" : index}`,
    ) as UniformSheetRow,
  );
  const result = await appendUniformRows({
    config: {
      spreadsheetId: "sheet-id",
      logTab: "Owner's Uniform Logs",
      moderatedTab: "Moderated Logs",
    },
    logKind: "log",
    rows,
    submissionId: "interaction-1",
  });

  assert.deepEqual(result, { alreadyWritten: false, count: 10 });
  assert.equal(calls.length, 2, "one duplicate check and one append");
  assert.match(decodeURIComponent(calls[0]!.path), /values\/'Owner''s Uniform Logs'!A:S\?valueRenderOption=FORMULA$/);
  assert.match(calls[1]!.path, /:append\?valueInputOption=RAW&insertDataOption=INSERT_ROWS$/);
  assert.equal(calls[1]!.options?.method, "POST");
  const body = calls[1]!.options?.body as { majorDimension: string; values: unknown[][] };
  assert.equal(body.majorDimension, "ROWS");
  assert.equal(body.values.length, 10);
  assert.deepEqual(body.values[0]!.length, UNIFORM_STORAGE_HEADERS.length);
  assert.equal(body.values[0]![UNIFORM_DETAIL_COLUMN_COUNT], "PENDING");
});

test("rejects an incompatible existing header before any write", async () => {
  const methods: string[] = [];
  setGoogleSheetsProxyForTests(async (path, options) => {
    methods.push(options?.method ?? "GET");
    if (path.includes("?fields=")) {
      return response({
        sheets: [
          { properties: { title: "Uniform Logs" } },
          { properties: { title: "Moderated Logs" } },
        ],
      });
    }
    if (decodeURIComponent(path).includes("'Uniform Logs'")) return response(values());
    return response({ values: [["not", "our", "schema"]] });
  });
  await assert.rejects(
    validateSpreadsheetConfiguration({
      spreadsheetId: "sheet-id",
      logTab: "Uniform Logs",
      moderatedTab: "Moderated Logs",
    }),
    /incompatible headers/i,
  );
  assert.deepEqual(methods, ["GET", "GET", "GET"]);
  assert.equal(methods.some((method) => method !== "GET"), false);
});

test("requests FORMULA values and rejects a formula-rendered blank without writing", async () => {
  const calls: Array<{ path: string; method?: string }> = [];
  setGoogleSheetsProxyForTests(async (path, options) => {
    calls.push({ path, method: options?.method });
    if (path.includes("?fields=")) {
      return response({
        sheets: [
          { properties: { title: "Uniform Logs" } },
          { properties: { title: "Moderated Logs" } },
        ],
      });
    }
    return response({ values: [["=\"\""]] });
  });

  await assert.rejects(
    validateSpreadsheetConfiguration({
      spreadsheetId: "sheet-id",
      logTab: "Uniform Logs",
      moderatedTab: "Moderated Logs",
    }),
    /incompatible headers/i,
  );
  assert.equal(calls.some(({ method }) => method !== "GET"), false);
  assert.ok(calls.some(({ path }) => path.includes("valueRenderOption=FORMULA")));
});

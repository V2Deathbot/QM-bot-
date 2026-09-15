import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

const directory = await mkdtemp(path.join(os.tmpdir(), "uniform-sheet-tests-"));
process.env.UNIFORM_SUBMISSION_LEDGER_FILE = path.join(directory, "submission-ledger.json");

const {
  appendUniformRows,
  markUniformRowsSold,
  markUniformRowsNotified,
  normalizeSpreadsheetId,
  normalizeUniformSpreadsheetConfig,
  normalizeUniformDataRange,
  quoteSheetTab,
  replaceUniformRowLink,
  resetGoogleSheetsProxyForTests,
  setUniformSubmissionLedgerWriteFailureForTests,
  setUniformSubmissionLedgerWriteFailureAfterForTests,
  setGoogleSheetsProxyForTests,
  validateSpreadsheetConfiguration,
} = await import("../src/bot/google-sheets.ts");

afterEach(() => resetGoogleSheetsProxyForTests());

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const base = {
  spreadsheetId: "sheet-id",
  logTab: "Uniform Logs",
  moderatedTab: "Moderated Logs",
  logRange: "A2:E",
  moderatedRange: "A2:D",
};

test("normalizes spreadsheet URLs, quotes tabs, and validates user data rectangles", () => {
  assert.equal(normalizeSpreadsheetId("https://docs.google.com/spreadsheets/d/abc_123/edit#gid=1"), "abc_123");
  assert.equal(quoteSheetTab("Owner's Sheet"), "'Owner''s Sheet'");
  assert.equal(normalizeUniformDataRange("c5:g", 5, "/log"), "C5:G");
  assert.equal(normalizeUniformDataRange("C5:G99", 5, "/log"), "C5:G99");
  assert.throws(() => normalizeUniformDataRange("A1:E", 5, "/log"), /below the header/i);
  assert.throws(() => normalizeUniformDataRange("A2:D", 5, "/log"), /exactly 5/i);
  assert.throws(() => normalizeUniformDataRange("Other!A2:E", 5, "/log"), /A1 rectangle/i);
  assert.equal(
    normalizeUniformSpreadsheetConfig({ ...base, createMissingTabs: true }).createMissingTabs,
    false,
    "an obsolete persisted flag is ignored; it never enables creation",
  );
});

test("configuration only reads existing tabs and never creates headers or worksheets", async () => {
  const calls: Array<{ path: string; method?: string }> = [];
  setGoogleSheetsProxyForTests(async (pathname, options) => {
    calls.push({ path: pathname, method: options?.method });
    return response({ sheets: [
      { properties: { title: "Uniform Logs", gridProperties: { rowCount: 1000, columnCount: 6 } } },
      { properties: { title: "Moderated Logs", gridProperties: { rowCount: 1000, columnCount: 6 } } },
    ] });
  });
  const saved = await validateSpreadsheetConfiguration(base);
  assert.equal(saved.logRange, "A2:E");
  assert.equal(saved.moderatedRange, "A2:D");
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});

test("writes only five selected /log cells after selected-column data, preserving header and Sold", async () => {
  const calls: Array<{ path: string; options?: { method?: string; body?: unknown } }> = [];
  const soldCheckboxes = new Map([[2, false], [5, true]]);
  setGoogleSheetsProxyForTests(async (pathname, options) => {
    calls.push({ path: pathname, options });
    if (options?.method === "GET") {
      // Selected A:E data: the blank second row does not matter, and an
      // unrelated F Sold checkbox is deliberately outside this response.
      return response({ values: [["qm", "seqm", "pub", "customer", "link"], [], ["later", "", "", "", ""]] });
    }
    return response({ updates: { updatedCells: 5 } });
  });
  const result = await appendUniformRows({
    config: base, logKind: "log", submissionId: "five-cells-only",
    rows: [["QM", "SEQM", "Publisher", "Customer", "https://www.roblox.com/catalog/1"]],
  });
  assert.deepEqual(result, { alreadyWritten: false, count: 1 });
  assert.equal(calls.length, 2);
  assert.match(decodeURIComponent(calls[0]!.path), /'Uniform Logs'!A2:E\?valueRenderOption=FORMULA$/);
  assert.match(decodeURIComponent(calls[1]!.path), /'Uniform Logs'!A5:E5\?valueInputOption=RAW$/);
  assert.equal(calls[1]!.options?.method, "PUT");
  const body = calls[1]!.options?.body as { range: string; values: unknown[][] };
  assert.equal(body.range, "'Uniform Logs'!A5:E5");
  assert.deepEqual(body.values, [["QM", "SEQM", "Publisher", "Customer", "https://www.roblox.com/catalog/1"]]);
  assert.deepEqual([...soldCheckboxes], [[2, false], [5, true]], "the F Sold checkbox column is never read or written");
  assert.equal(calls.some((call) => /!.*F\d/.test(decodeURIComponent(call.path))), false);
});

test("finds occupied selected cells beyond row 21 before reserving its exact rectangle", async () => {
  const calls: Array<{ path: string; options?: { method?: string; body?: unknown } }> = [];
  setGoogleSheetsProxyForTests(async (pathname, options) => {
    calls.push({ path: pathname, options });
    if (options?.method === "GET") {
      return response({ values: Array.from({ length: 21 }, (_value, index) =>
        index === 20 ? ["occupied"] : [],
      ) });
    }
    return response({});
  });
  await appendUniformRows({
    config: base, logKind: "log", submissionId: "after-row-21",
    rows: [["a", "b", "c", "d", "e"]],
  });
  assert.match(decodeURIComponent(calls[1]!.path), /'Uniform Logs'!A23:E23\?valueInputOption=RAW$/);
});

test("supports offsets and writes four /moderated cells without using append/INSERT_ROWS", async () => {
  const calls: Array<{ path: string; options?: { method?: string; body?: unknown } }> = [];
  setGoogleSheetsProxyForTests(async (pathname, options) => {
    calls.push({ path: pathname, options });
    if (options?.method === "GET") return response({ values: Array.from({ length: 20 }, () => []) });
    return response({});
  });
  await appendUniformRows({
    config: { ...base, logRange: "C5:G", moderatedRange: "C5:F" },
    logKind: "moderated", submissionId: "offset-moderated",
    rows: [["Uploader", "Publisher", "Customer", "https://www.roblox.com/catalog/2"]],
  });
  assert.match(decodeURIComponent(calls[1]!.path), /'Moderated Logs'!C5:F5\?valueInputOption=RAW$/);
  const body = calls[1]!.options?.body as { values: unknown[][] };
  assert.equal(body.values[0]!.length, 4);
  assert.equal(calls.some((call) => call.path.includes(":append") || call.path.includes("INSERT_ROWS")), false);
});

test("rejects bounded range exhaustion before issuing an update", async () => {
  const calls: Array<{ method?: string }> = [];
  setGoogleSheetsProxyForTests(async (_pathname, options) => {
    calls.push({ method: options?.method });
    return response({ values: [["one", "", "", "", ""], ["two", "", "", "", ""]] });
  });
  await assert.rejects(
    appendUniformRows({
      config: { ...base, logRange: "A2:E3" }, logKind: "log", submissionId: "full-range",
      rows: [["a", "b", "c", "d", "e"]],
    }),
    /range is full/i,
  );
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});

test("persists notification state locally without adding spreadsheet columns", async () => {
  let writes = 0;
  setGoogleSheetsProxyForTests(async (_pathname, options) => {
    if (options?.method === "GET") return response({ values: [] });
    writes++;
    return response({});
  });
  await appendUniformRows({
    config: base, logKind: "log", submissionId: "local-notification",
    rows: [["a", "b", "c", "d", "e"]],
  });
  assert.deepEqual(await markUniformRowsNotified(base, "log", "local-notification"), { alreadyNotified: false, count: 1 });
  assert.deepEqual(await markUniformRowsNotified(base, "log", "local-notification"), { alreadyNotified: true, count: 1 });
  assert.equal(writes, 1);
  const ledger = await readFile(process.env.UNIFORM_SUBMISSION_LEDGER_FILE!, "utf8");
  assert.match(ledger, /"notified": true/);
});

test("reports local notification bookkeeping failure without changing worksheet cells, then can resume", async () => {
  let writes = 0;
  setGoogleSheetsProxyForTests(async (_pathname, options) => {
    if (options?.method === "GET") return response({ values: [] });
    writes++;
    return response({});
  });
  await appendUniformRows({
    config: base, logKind: "moderated", submissionId: "notification-bookkeeping-failure",
    rows: [["Uploader", "Publisher", "Customer", "https://www.roblox.com/catalog/3"]],
  });
  setUniformSubmissionLedgerWriteFailureForTests(new Error("local ledger temporarily unavailable"));
  await assert.rejects(
    markUniformRowsNotified(base, "moderated", "notification-bookkeeping-failure"),
    /local ledger temporarily unavailable/i,
  );
  assert.equal(writes, 1, "notification tracking never writes a spreadsheet status column");
  setUniformSubmissionLedgerWriteFailureForTests();
  assert.deepEqual(
    await markUniformRowsNotified(base, "moderated", "notification-bookkeeping-failure"),
    { alreadyNotified: false, count: 1 },
  );
});

test("verifies an unknown write response using its persisted reserved target without a blind second update", async () => {
  let values: unknown[][] = [];
  let updateCalls = 0;
  setGoogleSheetsProxyForTests(async (_pathname, options) => {
    if (options?.method === "GET") return response({ values });
    updateCalls++;
    values = [["QM", "SEQM", "Publisher", "Customer", "https://www.roblox.com/catalog/9"]];
    throw new Error("connector response timed out after Sheets committed");
  });
  const result = await appendUniformRows({
    config: base, logKind: "log", submissionId: "unknown-write-response",
    rows: [["QM", "SEQM", "Publisher", "Customer", "https://www.roblox.com/catalog/9"]],
  });
  assert.deepEqual(result, { alreadyWritten: true, count: 0 });
  assert.equal(updateCalls, 1, "unknown responses are verified, not retried blindly");
});

test("replaces the exact ledger row link in place and marks only its real Sold F cells", async () => {
  const calls: Array<{ path: string; options?: { method?: string; body?: unknown } }> = [];
  let values: unknown[][] = [];
  const original = [
    ["QM", "SEQM", "Publisher", "Customer", "https://www.roblox.com/catalog/31"],
    ["QM", "SEQM", "Publisher", "Customer", "https://www.roblox.com/catalog/32"],
  ];
  setGoogleSheetsProxyForTests(async (pathname, options) => {
    calls.push({ path: pathname, options });
    if (options?.method === "GET") return response({ values });
    const decoded = decodeURIComponent(pathname);
    const body = options?.body as { values: unknown[][] };
    if (decoded.includes("!A2:E3")) values = body.values;
    if (decoded.includes("!E3")) values[1]![4] = body.values[0]![0];
    return response({});
  });
  await appendUniformRows({
    config: base, logKind: "log", submissionId: "exact-sold-and-relog",
    rows: original.map((row) => [...row]),
  });
  await replaceUniformRowLink({
    config: base, logKind: "log", submissionId: "exact-sold-and-relog", rowIndex: 1,
    newLink: "https://www.roblox.com/catalog/99",
  });
  await markUniformRowsSold(base, "log", "exact-sold-and-relog");
  const writes = calls.filter((call) => call.options?.method === "PUT");
  assert.equal(writes.length, 3, "append, one in-place relog cell, and one Sold range only");
  assert.match(decodeURIComponent(writes[1]!.path), /'Uniform Logs'!E3\?valueInputOption=RAW$/);
  assert.match(decodeURIComponent(writes[2]!.path), /'Uniform Logs'!F2:F3\?valueInputOption=RAW$/);
  assert.deepEqual((writes[2]!.options?.body as { values: unknown[][] }).values, [[true], [true]]);
  assert.deepEqual(values, [
    original[0],
    ["QM", "SEQM", "Publisher", "Customer", "https://www.roblox.com/catalog/99"],
  ]);
});

test("refuses relog conflicts and unsafe offset Sold writes before changing cells", async () => {
  const calls: Array<{ path: string; options?: { method?: string } }> = [];
  setGoogleSheetsProxyForTests(async (pathname, options) => {
    calls.push({ path: pathname, options });
    if (options?.method === "GET") return response({ values: [] });
    return response({});
  });
  await appendUniformRows({
    config: base, logKind: "log", submissionId: "unsafe-sold-offset",
    rows: [["QM", "SEQM", "Publisher", "Customer", "https://www.roblox.com/catalog/1"]],
  });
  await assert.rejects(
    replaceUniformRowLink({
      config: base, logKind: "log", submissionId: "unsafe-sold-offset", rowIndex: 0,
      newLink: "https://www.roblox.com/catalog/2",
    }),
    /no longer matches/i,
  );
  await assert.rejects(
    (async () => {
      const offset = { ...base, logRange: "C5:G" };
      await appendUniformRows({
        config: offset, logKind: "log", submissionId: "unsafe-sold-offset-f-column",
        rows: [["QM", "SEQM", "Publisher", "Customer", "https://www.roblox.com/catalog/3"]],
      });
      await markUniformRowsSold(offset, "log", "unsafe-sold-offset-f-column");
    })(),
    /overlaps Sold column F/i,
  );
  assert.equal(calls.filter((call) => call.options?.method === "PUT").length, 2);
});

test("reconciles a Sheets-committed relog after its local ledger save fails", async () => {
  let values: unknown[][] = [];
  let replacementWrites = 0;
  setGoogleSheetsProxyForTests(async (pathname, options) => {
    if (options?.method === "GET") return response({ values });
    const decoded = decodeURIComponent(pathname);
    const body = options?.body as { values: unknown[][] };
    if (decoded.includes("!A2:E2")) values = body.values;
    if (decoded.includes("!E2")) {
      replacementWrites += 1;
      values[0]![4] = body.values[0]![0];
    }
    return response({});
  });
  await appendUniformRows({
    config: base, logKind: "log", submissionId: "reconcile-ledger-after-sheet",
    rows: [["QM", "SEQM", "Publisher", "Customer", "https://www.roblox.com/catalog/1"]],
  });
  setUniformSubmissionLedgerWriteFailureAfterForTests(1, new Error("simulated post-Sheets ledger crash"));
  await assert.rejects(
    replaceUniformRowLink({
      config: base, logKind: "log", submissionId: "reconcile-ledger-after-sheet", rowIndex: 0,
      newLink: "https://www.roblox.com/catalog/2",
    }),
    /post-Sheets ledger crash/i,
  );
  setUniformSubmissionLedgerWriteFailureForTests();
  await replaceUniformRowLink({
    config: base, logKind: "log", submissionId: "reconcile-ledger-after-sheet", rowIndex: 0,
    newLink: "https://www.roblox.com/catalog/2",
  });
  assert.equal(replacementWrites, 1, "reconciliation verifies exact intended cells instead of writing again");
});
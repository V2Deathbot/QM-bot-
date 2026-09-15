import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

const directory = await mkdtemp(path.join(os.tmpdir(), "payout-tests-"));
process.env.PAYOUT_ARCHIVE_FILE = path.join(directory, "payout-runs.json");
process.env.UNIFORM_SUBMISSION_LEDGER_FILE = path.join(directory, "uniform-ledger.json");
process.env.UNIFORM_DELIVERY_FILE = path.join(directory, "uniform-deliveries.json");
const {
  summarizePayoutSource, payoutReportEmbeds, payoutReportMessages, readPayoutSnapshot, archivePayoutPreview,
  acknowledgeUncertainPayoutReport, confirmArchivedPayout, recoverUnknownPayoutClear,
} = await import("../src/bot/payout.ts");
const {
  acquirePayoutLock, activePayoutRunForGuild, finalizePayoutRun, getPayoutRun, payoutLockForWorkbook,
  payoutWorkbookGeneration, resetPayoutStoreForTests, updatePayoutRun,
} = await import("../src/bot/payout-store.ts");
const { resetPayoutGuardsForTests } = await import("../src/bot/payout-guard.ts");

afterEach(async () => {
  resetPayoutStoreForTests();
  resetPayoutGuardsForTests();
  await rm(directory, { recursive: true, force: true });
});

function source(): unknown[][] {
  return [
    ["Grand Total Due: 644"],
    ["Quartermaster", "3", "Total Payout", "Uploader", "13", "10", "Total Payout", "Publisher", "11", "10", "Total Payout"],
    [47, 22, 66, 25, 22, 2, 306, 11, 22, 3, 272],
    ["Alice", "", 10, "Up", "", "", 30, "Pub", "", "", 20],
    ["alice", "", 56, "up", "", "", 276, "Pub Two", "", "", 252],
  ];
}

const sheetConfig = { spreadsheetId: "payout-test-sheet", logTab: "Uniform Logging", moderatedTab: "Moderated Uniforms", logRange: "A2:E", moderatedRange: "A2:D" };
function mockSheets() {
  const originals: Record<string, unknown[][]> = {
    "Uniform Logging!A2:E6": [["old"], [], [], [], []],
    "Moderated Uniforms!A2:D5": [["old"], [], [], []],
    "Uniform Logging!F2:F6": [[true], [false], [true], [false], [false]],
  };
  const calls: unknown[][] = [];
  let changed = false;
  return {
    calls,
    setSourceChanged: () => { changed = true; },
    grids: async () => [
      { title: "Payout Logging1", sheetId: 1, rowCount: 20, columnCount: 11 },
      { title: "Uniform Logging", sheetId: 2, rowCount: 6, columnCount: 6 },
      { title: "Moderated Uniforms", sheetId: 3, rowCount: 5, columnCount: 4 },
    ],
    values: async (_id: string, tab: string, range: string, _render: string) => {
      if (tab === "Payout Logging1") {
        const value = source();
        if (changed) {
          value[0]![0] = "Grand Total Due: 645";
          value[2]![2] = 67;
          value[3]![2] = 11;
        }
        return value;
      }
      return originals[`${tab}!${range}`] ?? [];
    },
    batchUpdate: async (_id: string, requests: unknown[]) => { calls.push(requests); },
  };
}

test("payout parser validates source schema and aggregates case-insensitive role entries", () => {
  const summary = summarizePayoutSource(source());
  assert.equal(summary.grandTotal, 644);
  assert.deepEqual(summary.roles.map((role) => [role.role, role.total, role.participants]), [
    ["Quartermasters", 66, [{ name: "Alice", amount: 66 }]],
    ["Uploaders", 306, [{ name: "Up", amount: 306 }]],
    ["Publishers", 272, [{ name: "Pub", amount: 20 }, { name: "Pub Two", amount: 252 }]],
  ]);
  const mismatch = source();
  mismatch[2]![2] = 65;
  assert.throws(() => summarizePayoutSource(mismatch), /entries total/i);
  const formulaError = source();
  formulaError[3]![2] = "#REF!";
  assert.throws(() => summarizePayoutSource(formulaError), /finite.*numeric/i);
});

test("payout reporting chunks whole lines without truncating them", () => {
  const roles = summarizePayoutSource(source()).roles;
  const embeds = payoutReportEmbeds({ runId: "run-1", grandTotal: 644, roles });
  assert.ok(embeds.length <= 10);
  assert.ok(embeds.flatMap((embed) => embed.fields).every((field) => field.value.length <= 1024));
  assert.match(embeds[0]!.description!, /does not transfer Robux/i);
});

test("payout reports page beyond ten embeds without truncating a Discord message", () => {
  const roles = ["Quartermasters", "Uploaders", "Publishers"].map((role) => ({
    role: role as "Quartermasters" | "Uploaders" | "Publishers",
    participants: Array.from({ length: 100 }, (_, index) => ({ name: `${role}-${index}-${"x".repeat(980)}`, amount: 1 })),
    total: 100,
  }));
  const messages = payoutReportMessages({ runId: "report-pages", grandTotal: 300, roles });
  assert.ok(messages.length > 1);
  for (const page of messages) {
    assert.ok(page.length <= 10);
    const pageCharacters = page.reduce((pageTotal, embed) => {
      assert.ok(embed.fields.length <= 25);
      const embedCharacters = embed.title.length + (embed.description?.length ?? 0) + embed.footer.length +
        embed.fields.reduce((total, field) => total + field.name.length + field.value.length, 0);
      assert.ok(embedCharacters <= 6000);
      return pageTotal + embedCharacters;
    }, 0);
    assert.ok(pageCharacters <= 6000);
  }
});

test("durably archives before DM, refuses DM failure, and sends one scoped atomic clear only after delivery", async () => {
  const sheets = mockSheets();
  const snapshot = await readPayoutSnapshot(sheets, sheetConfig);
  const run = await archivePayoutPreview(snapshot, "guild", "admin", "orchestration");
  await assert.rejects(confirmArchivedPayout(sheets, run.runId, { send: async () => { throw new Error("DM disabled"); } }), /delivery was not confirmed/i);
  assert.equal(sheets.calls.length, 0);

  // A separate archived run proves send completion precedes exactly one atomic batch.
  const retrySheets = mockSheets();
  const retry = await archivePayoutPreview(await readPayoutSnapshot(retrySheets, { ...sheetConfig, spreadsheetId: "payout-second" }), "guild", "admin", "orchestration-second");
  let delivered = false;
  await confirmArchivedPayout(retrySheets, retry.runId, { send: async () => { delivered = true; return ["dm-1"]; } });
  assert.equal(delivered, true);
  assert.equal(retrySheets.calls.length, 1);
  const requests = retrySheets.calls[0] as Array<{ updateCells: { range: Record<string, number>; rows?: unknown[]; fields: string } }>;
  assert.deepEqual(requests.map((request) => request.updateCells.range), [
    { sheetId: 2, startRowIndex: 1, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 5 },
    { sheetId: 3, startRowIndex: 1, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 4 },
    { sheetId: 2, startRowIndex: 1, endRowIndex: 6, startColumnIndex: 5, endColumnIndex: 6 },
  ]);
  assert.equal(requests[2]!.updateCells.rows?.length, 5);
});

test("changed source blocks stale confirmation and concurrent confirmations cannot duplicate DM or reset", async () => {
  const staleSheets = mockSheets();
  const stale = await archivePayoutPreview(await readPayoutSnapshot(staleSheets, sheetConfig), "guild", "admin", "stale");
  staleSheets.setSourceChanged();
  await assert.rejects(confirmArchivedPayout(staleSheets, stale.runId, { send: async () => ["never"] }), /changed after preview/i);
  assert.equal(staleSheets.calls.length, 0);

  const sheets = mockSheets();
  const run = await archivePayoutPreview(await readPayoutSnapshot(sheets, { ...sheetConfig, spreadsheetId: "concurrent" }), "guild", "admin", "concurrent");
  let dms = 0;
  const outcomes = await Promise.allSettled([
    confirmArchivedPayout(sheets, run.runId, { send: async () => { dms++; return ["dm"]; } }),
    confirmArchivedPayout(sheets, run.runId, { send: async () => { dms++; return ["dm"]; } }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(dms, 1);
  assert.equal(sheets.calls.length, 1);
});

test("an uncertain report requires acknowledgement and never re-sends delivered report pages", async () => {
  const sheets = mockSheets();
  const run = await archivePayoutPreview(await readPayoutSnapshot(sheets, sheetConfig), "guild", "admin", "uncertain");
  await assert.rejects(
    confirmArchivedPayout(sheets, run.runId, { sendPage: async () => { throw new Error("DM connection ended"); } }),
    /not confirmed/i,
  );
  const uncertain = await getPayoutRun(run.runId);
  assert.equal(uncertain?.reportState, "uncertain");
  assert.equal(uncertain?.reportMessages?.[0]?.state, "uncertain");
  await acknowledgeUncertainPayoutReport(run.runId, "admin");
  let reSent = 0;
  await confirmArchivedPayout(sheets, run.runId, {
    sendPage: async () => {
      reSent++;
      return "must-not-send";
    },
  });
  assert.equal(reSent, 0);
  assert.equal(sheets.calls.length, 1);
});

test("acknowledging one uncertain report page resumes later pending pages before clear", async () => {
  const sheets = mockSheets();
  const run = await archivePayoutPreview(await readPayoutSnapshot(sheets, sheetConfig), "guild", "admin", "paged-uncertain");
  await updatePayoutRun(run.runId, (record) => {
    record.roles = ["Quartermasters", "Uploaders", "Publishers"].map((role) => ({
      role: role as "Quartermasters" | "Uploaders" | "Publishers",
      participants: Array.from({ length: 30 }, (_, index) => ({ name: `${role}-${index}-${"x".repeat(980)}`, amount: 1 })),
      total: 30,
    }));
    record.grandTotal = 90;
  });
  let attempts = 0;
  await assert.rejects(confirmArchivedPayout(sheets, run.runId, {
    sendPage: async () => {
      attempts++;
      if (attempts === 2) throw new Error("DM outcome unknown");
      return `dm-${attempts}`;
    },
  }), /not confirmed/i);
  const uncertain = await getPayoutRun(run.runId);
  assert.equal(uncertain?.reportMessages?.[0]?.state, "delivered");
  assert.equal(uncertain?.reportMessages?.[1]?.state, "uncertain");
  assert.ok(uncertain?.reportMessages?.some((message) => message.state === "pending"));
  await acknowledgeUncertainPayoutReport(run.runId, "admin");
  let resumed = 0;
  await confirmArchivedPayout(sheets, run.runId, {
    sendPage: async () => {
      resumed++;
      return `resumed-${resumed}`;
    },
  });
  assert.ok(resumed > 0);
  assert.equal(sheets.calls.length, 1);
});

test("unknown reset recovery verifies archived cleared cells and never repeats deletion", async () => {
  let batchCalls = 0;
  const clearedSheets = {
    grids: async () => [
      { title: "Payout Logging1", sheetId: 1, rowCount: 20, columnCount: 11 },
      { title: "Uniform Logging", sheetId: 2, rowCount: 6, columnCount: 6 },
      { title: "Moderated Uniforms", sheetId: 3, rowCount: 5, columnCount: 4 },
    ],
    values: async (_id: string, tab: string, range: string) => {
      if (tab === "Payout Logging1") {
        const recalculated = source();
        recalculated[0]![0] = "Grand Total Due: 999";
        return recalculated;
      }
      if (tab === "Uniform Logging" && range === "F2:F6") return Array.from({ length: 5 }, () => [false]);
      const rows = tab === "Uniform Logging" ? 5 : 4;
      return Array.from({ length: rows }, () => []);
    },
    batchUpdate: async () => { batchCalls++; },
  };
  const run = await archivePayoutPreview(await readPayoutSnapshot(mockSheets(), sheetConfig), "guild", "admin", "already-cleared");
  await updatePayoutRun(run.runId, (record) => {
    record.state = "unsafe";
    record.reportState = "delivered";
    record.reportMessageIds = ["dm"];
  });
  const complete = await recoverUnknownPayoutClear(clearedSheets, run.runId);
  assert.equal(complete.state, "complete");
  assert.equal(batchCalls, 0);
});

test("completion finalizes matching lock and generation in one idempotent transaction", async () => {
  const run = await archivePayoutPreview(await readPayoutSnapshot(mockSheets(), sheetConfig), "guild", "admin", "legacy-complete-lock");
  await acquirePayoutLock(run.spreadsheetId, run.runId);
  // Simulate the historical crash boundary after a separate complete write.
  await updatePayoutRun(run.runId, (record) => { record.state = "complete"; });
  assert.equal((await activePayoutRunForGuild("guild"))?.runId, run.runId);
  const first = await confirmArchivedPayout(mockSheets(), run.runId, {
    sendPage: async () => { throw new Error("completed runs must not send"); },
  });
  assert.equal(first.state, "complete");
  assert.equal(await payoutLockForWorkbook(run.spreadsheetId), undefined);
  assert.equal(await payoutWorkbookGeneration(run.spreadsheetId), 1);
  await finalizePayoutRun(run.runId);
  assert.equal(await payoutWorkbookGeneration(run.spreadsheetId), 1);
});
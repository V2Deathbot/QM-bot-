import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pool } from "../../lib/db/src/index.ts";
import { mutateBotDocument, readBotDocument } from "../../artifacts/api-server/src/bot/persistent-store.ts";
import { acquireBotRuntimeLease } from "../../artifacts/api-server/src/bot/runtime-lease.ts";

if (process.env["BOT_IMPORT_ENV"] !== "development" ||
    process.env["NODE_ENV"] === "production" ||
    process.env["REPLIT_DEPLOYMENT"] === "1") {
  throw new Error("Database persistence integration tests are development-only.");
}

const prefix = `bot-storage-test-${randomUUID()}`;
const counterOptions = {
  name: `${prefix}/counter`,
  filePath: path.join(tmpdir(), `${prefix}.json`),
  empty: () => ({ count: 0, label: "" }),
  validate(value: unknown): { count: number; label: string } {
    const document = value as { count?: unknown; label?: unknown };
    if (!document || typeof document.count !== "number" || !Number.isSafeInteger(document.count)) {
      throw new Error("invalid counter document");
    }
    if (typeof document.label !== "string") throw new Error("invalid counter document label");
    return { count: document.count, label: document.label };
  },
};

function runImporter(sourceDir: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["--filter", "@workspace/scripts", "run", "import-bot-data", "--", `--source-dir=${sourceDir}`, `--document-prefix=${prefix}`],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        env: { ...process.env, BOT_IMPORT_ENV: "development", BOT_IMPORT_TEST_MODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
}

async function writeEmptyImportSource(directory: string): Promise<void> {
  const files: Record<string, unknown> = {
    "guild-settings.json": { guilds: [] },
    "role-snapshots.json": { snapshots: [], notes: [] },
    "guild-security.json": { guilds: [] },
    "uniform-submission-ledger.json": { entries: [] },
    "uniform-deliveries.json": { records: [] },
    "payout-runs.json": { runs: [], locks: [], generations: {} },
  };
  await Promise.all(Object.entries(files).map(([name, contents]) =>
    writeFile(path.join(directory, name), JSON.stringify(contents)),
  ));
}

async function main(): Promise<void> {
  const exists = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'bot_documents'",
  );
  assert.equal(exists.rowCount, 1, "bot_documents must be applied to development before this integration test");
  const source = await mkdtemp(path.join(tmpdir(), "bot-import-source-"));
  let firstLease: Awaited<ReturnType<typeof acquireBotRuntimeLease>> | undefined;
  try {
    await pool.query(
      "INSERT INTO bot_documents (name, document, revision) VALUES ($1, $2, 0)",
      [counterOptions.name, JSON.stringify({ count: 0, label: "composite\u0000key" })],
    );
    await Promise.all(Array.from({ length: 12 }, () =>
      mutateBotDocument(counterOptions, (document) => { document.count += 1; }),
    ));
    const counter = await readBotDocument(counterOptions);
    assert.equal(counter.count, 12, "row locks serialize concurrent read-modify-write");
    assert.equal(counter.label, "composite\u0000key", "text storage round-trips NUL-containing JSON strings");
    await assert.rejects(
      readBotDocument({ ...counterOptions, name: `${prefix}/missing` }),
      /missing/i,
    );

    let leaseLost!: () => void;
    const lossObserved = new Promise<void>((resolve) => { leaseLost = resolve; });
    firstLease = await acquireBotRuntimeLease(() => leaseLost());
    await assert.rejects(acquireBotRuntimeLease(() => undefined), /leadership lock/i);
    await pool.query("SELECT pg_terminate_backend($1)", [firstLease.backendPid]);
    await Promise.race([
      lossObserved,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("lease loss callback was not observed")), 5_000)),
    ]);
    await firstLease.release().catch(() => undefined);
    firstLease = undefined;

    await writeEmptyImportSource(source);
    await pool.query(
      "INSERT INTO bot_documents (name, document, revision) VALUES ($1, $2, 0)",
      // This is deliberately last in importer order: earlier inserts must be
      // rolled back when the final document mismatches.
      [`${prefix}/payout-runs`, JSON.stringify({ deliberatelyDifferent: true })],
    );
    const imported = await runImporter(source);
    assert.notEqual(imported.code, 0, "mismatched document must reject the complete import");
    assert.match(imported.output, /does not match/i);
    const partial = await pool.query(
      "SELECT name FROM bot_documents WHERE name LIKE $1 AND name <> $2",
      [`${prefix}/%`, `${prefix}/payout-runs`],
    );
    assert.equal(partial.rowCount, 1, "only the independent counter may exist; mismatch caused no importer partial write");
    console.log("Development PostgreSQL persistence integration checks passed.");
  } finally {
    await firstLease?.release().catch(() => undefined);
    await pool.query("DELETE FROM bot_documents WHERE name LIKE $1", [`${prefix}/%`]);
    await rm(source, { recursive: true, force: true });
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Database persistence integration test failed.");
  process.exitCode = 1;
});
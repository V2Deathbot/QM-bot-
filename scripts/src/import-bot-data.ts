import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../../lib/db/src/index.ts";
import { validateGuildSettingsDocument } from "../../artifacts/api-server/src/bot/setup-store.ts";
import { validateRoleSnapshotsDocument } from "../../artifacts/api-server/src/bot/role-store.ts";
import { validateSecurityDocument } from "../../artifacts/api-server/src/bot/security-store.ts";
import { validateUniformSubmissionLedgerDocument } from "../../artifacts/api-server/src/bot/google-sheets.ts";
import { validateUniformDeliveriesDocument } from "../../artifacts/api-server/src/bot/uniform-delivery-store.ts";
import { validatePayoutRunsDocument } from "../../artifacts/api-server/src/bot/payout-store.ts";
import { validatePersistedRecoveryDocument } from "../../artifacts/api-server/src/bot/runtime-state-store.ts";

type SourceDocument = {
  name: string;
  file: string;
  collection: string;
  validate: (value: unknown) => void;
};

const documents: SourceDocument[] = [
  { name: "guild-settings", file: "guild-settings.json", collection: "guilds", validate: validateGuildSettingsDocument },
  { name: "role-snapshots", file: "role-snapshots.json", collection: "snapshots", validate: validateRoleSnapshotsDocument },
  { name: "guild-security", file: "guild-security.json", collection: "guilds", validate: validateSecurityDocument },
  { name: "uniform-submission-ledger", file: "uniform-submission-ledger.json", collection: "entries", validate: validateUniformSubmissionLedgerDocument },
  { name: "uniform-deliveries", file: "uniform-deliveries.json", collection: "records", validate: validateUniformDeliveriesDocument },
  { name: "payout-runs", file: "payout-runs.json", collection: "runs", validate: validatePayoutRunsDocument },
];

const initialRuntimeState = {
  recovery: {
    status: "pending",
    lastAttemptAt: null,
    lastSuccessfulAt: null,
    error: null,
    retryCount: 0,
    nextRetryAt: null,
    lastRetryAt: null,
    lastRetryOutcome: null,
  },
};
validatePersistedRecoveryDocument(initialRuntimeState);

function argument(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function checksum(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function main(): Promise<void> {
  if (process.env["BOT_IMPORT_ENV"] !== "development" ||
      process.env["NODE_ENV"] === "production" ||
      process.env["REPLIT_DEPLOYMENT"] === "1") {
    throw new Error("This importer is development-only. Set BOT_IMPORT_ENV=development; never run it in production.");
  }
  const sourceArgument = argument("--source-dir");
  if (!sourceArgument) {
    throw new Error("Missing --source-dir. Supply the explicit existing bot data directory; a default cwd is intentionally forbidden.");
  }
  const cwd = await realpath(process.cwd());
  const source = await realpath(path.resolve(cwd, sourceArgument));
  if (source === cwd || source === path.parse(source).root) {
    throw new Error("Refusing a workspace root as the import source. Pass the explicit bot data directory.");
  }
  if (!(await stat(source)).isDirectory()) {
    throw new Error("The explicit --source-dir is not a directory.");
  }
  const prefixArgument = argument("--document-prefix");
  if (prefixArgument && process.env["BOT_IMPORT_TEST_MODE"] !== "1") {
    throw new Error("--document-prefix is reserved for isolated development integration tests.");
  }
  if (prefixArgument && !/^[a-z0-9][a-z0-9/_-]{0,80}$/.test(prefixArgument)) {
    throw new Error("The test document prefix is invalid.");
  }

  const loaded = await Promise.all(documents.map(async (definition) => {
    const filePath = path.join(source, definition.file);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      throw new Error(`Expected source document is missing or unreadable: ${definition.file}. Nothing was imported.`);
    }
    let document: Record<string, unknown>;
    try {
      document = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`Expected source document is invalid JSON: ${definition.file}. Nothing was imported.`);
    }
    const collection = document?.[definition.collection];
    if (!document || typeof document !== "object" || !Array.isArray(collection)) {
      throw new Error(`Expected source document has no ${definition.collection} collection: ${definition.file}. Nothing was imported.`);
    }
    try {
      definition.validate(document);
    } catch {
      throw new Error(`Expected source document contains an invalid record: ${definition.file}. Nothing was imported.`);
    }
    return {
      ...definition,
      storageName: prefixArgument ? `${prefixArgument}/${definition.name}` : definition.name,
      raw,
      document,
      count: collection.length,
      sourceChecksum: checksum(raw),
    };
  }));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const item of loaded) {
      const existing = await client.query<{ document: string }>(
        "SELECT document FROM bot_documents WHERE name = $1 FOR UPDATE",
        [item.storageName],
      );
      if (existing.rowCount === 1) {
        if (checksum(existing.rows[0]!.document) !== item.sourceChecksum) {
          throw new Error(`Persistent document ${item.name} already exists but does not match this source. Refusing to overwrite.`);
        }
        continue;
      }
      await client.query(
        "INSERT INTO bot_documents (name, document, revision) VALUES ($1, $2, 0)",
        [item.storageName, item.raw],
      );
      const verified = await client.query<{ document: string }>(
        "SELECT document FROM bot_documents WHERE name = $1",
        [item.storageName],
      );
      if (verified.rowCount !== 1 ||
          checksum(verified.rows[0]!.document) !== item.sourceChecksum) {
        throw new Error(`Persistent document ${item.name} failed checksum verification.`);
      }
    }
    await client.query(
      "INSERT INTO bot_documents (name, document, revision) VALUES ($1, $2, 0) ON CONFLICT (name) DO NOTHING",
      [prefixArgument ? `${prefixArgument}/bot-runtime-state` : "bot-runtime-state", JSON.stringify(initialRuntimeState)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  // Backup only after every document has been committed and checksum-verified.
  // It is a copy, never a move; originals remain available for rollback review.
  const backupDir = path.join(source, ".import-backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-${checksum(source).slice(0, 12)}`);
  await mkdir(backupDir, { recursive: true });
  await Promise.all(loaded.map(async (item) => copyFile(path.join(source, item.file), path.join(backupDir, item.file))));
  await writeFile(path.join(backupDir, "manifest.json"), JSON.stringify(
    loaded.map(({ name, file, count, sourceChecksum }) => ({
      name, file, count, sourceChecksum,
    })),
    null,
    2,
  ));
  for (const item of loaded) {
    // Counts and digests provide a non-sensitive audit trail; never print data.
    console.log(`${item.name}: count=${item.count} sha256=${item.sourceChecksum} verified`);
  }
  console.log(`Imported ${loaded.length} bot documents; originals retained and copied to ${backupDir}.`);
}

void main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Bot data import failed.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * File mode is deliberately test-only. Production and normal development
 * always use PostgreSQL; a missing/corrupt database document is an error, not
 * permission to silently start with an empty moderation history.
 */
const fileMode = process.env["BOT_STORAGE_MODE"] === "file";
const fileQueues = new Map<string, Promise<void>>();
let tempSequence = 0;

export interface BotDocumentOptions<T> {
  name: string;
  filePath: string;
  empty: () => T;
  validate: (value: unknown) => T;
}

export function isFileBotStorage(): boolean {
  return fileMode;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function loadFile<T>(options: BotDocumentOptions<T>): Promise<T> {
  try {
    return options.validate(JSON.parse(await readFile(options.filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return options.empty();
    throw error;
  }
}

async function saveFile<T>(options: BotDocumentOptions<T>, value: T): Promise<void> {
  await mkdir(path.dirname(options.filePath), { recursive: true });
  const temporary = `${options.filePath}.${process.pid}.${tempSequence++}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, options.filePath);
}

async function databasePool() {
  // Do not load the database module in file-mode tests: its deliberate
  // DATABASE_URL guard keeps tests isolated from developer credentials.
  const { pool } = await import("@workspace/db");
  return pool;
}

async function loadDatabase<T>(options: BotDocumentOptions<T>): Promise<T> {
  const pool = await databasePool();
  const result = await pool.query<{ document: string }>(
    "SELECT document FROM bot_documents WHERE name = $1",
    [options.name],
  );
  if (result.rowCount !== 1) {
    throw new Error(
      `Persistent bot document "${options.name}" is missing. Run the one-time development import before enabling the bot.`,
    );
  }
  try {
    return options.validate(JSON.parse(result.rows[0]!.document));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Persistent bot document "${options.name}" contains invalid JSON.`);
    }
    throw error;
  }
}

export async function readBotDocument<T>(options: BotDocumentOptions<T>): Promise<T> {
  return clone(fileMode ? await loadFile(options) : await loadDatabase(options));
}

/**
 * A document mutation is one PostgreSQL transaction with SELECT ... FOR UPDATE
 * and revision increment. This serializes read-modify-write across bot
 * processes, not merely promises in one Node process.
 */
export async function mutateBotDocument<T, Result>(
  options: BotDocumentOptions<T>,
  mutation: (document: T) => Result | Promise<Result>,
): Promise<Result> {
  if (fileMode) {
    const prior = fileQueues.get(options.name) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(async () => {
      const document = await loadFile(options);
      const result = await mutation(document);
      // Revalidate before committing so a programming error cannot leave a
      // test fixture shaped differently from production data.
      const validated = options.validate(document);
      await saveFile(options, validated);
      return result;
    });
    const tail = operation.then(() => undefined, () => undefined);
    fileQueues.set(options.name, tail);
    void tail.finally(() => {
      if (fileQueues.get(options.name) === tail) fileQueues.delete(options.name);
    });
    return operation;
  }

  const pool = await databasePool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{ document: string }>(
      "SELECT document FROM bot_documents WHERE name = $1 FOR UPDATE",
      [options.name],
    );
    if (selected.rowCount !== 1) {
      throw new Error(
        `Persistent bot document "${options.name}" is missing. Run the one-time development import before enabling the bot.`,
      );
    }
    let document: T;
    try {
      document = options.validate(JSON.parse(selected.rows[0]!.document));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Persistent bot document "${options.name}" contains invalid JSON.`);
      }
      throw error;
    }
    const result = await mutation(document);
    const validated = options.validate(document);
    await client.query(
      "UPDATE bot_documents SET document = $2, revision = revision + 1, updated_at = NOW() WHERE name = $1",
      [options.name, JSON.stringify(validated)],
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Test helper only; it never affects the database-backed runtime. */
export function resetPersistentStoreForTests(): void {
  fileQueues.clear();
  tempSequence = 0;
}
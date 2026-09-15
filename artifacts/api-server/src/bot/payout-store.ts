import { config } from "./config";
import { mutateBotDocument, readBotDocument, resetPersistentStoreForTests } from "./persistent-store";

export type PayoutRunState =
  | "previewed"
  | "locked"
  | "archived"
  | "reported"
  | "clearing"
  | "cleared"
  | "complete"
  | "unsafe";

export interface PayoutArchiveCell {
  range: string;
  /** Formula-rendered cells, captured before any reset. */
  values: unknown[][];
}

export interface PayoutRoleTotal {
  role: "Quartermasters" | "Uploaders" | "Publishers";
  participants: Array<{ name: string; amount: number }>;
  total: number;
}

/**
 * One Discord DM. A report may need any number of these messages, each with
 * at most ten embeds. `sending` is deliberately not treated as retryable
 * after a restart: Discord may have accepted it before the process stopped.
 */
export interface PayoutReportMessage {
  nonce: string;
  state: "pending" | "sending" | "delivered" | "uncertain" | "acknowledged";
  messageId?: string;
}

export interface PayoutRun {
  runId: string;
  spreadsheetId: string;
  guildId: string;
  actorId: string;
  state: PayoutRunState;
  sourceFingerprint: string;
  sourceTab: "Payout Logging1";
  sourceValues: unknown[][];
  grandTotal: number;
  roles: PayoutRoleTotal[];
  clearCells: PayoutArchiveCell[];
  createdAt: string;
  updatedAt: string;
  /** Discord IDs are saved before cleanup so a retry never sends another report. */
  reportMessageIds: string[];
  reportState: "not-started" | "delivered" | "uncertain";
  reportMessages?: PayoutReportMessage[];
  reportAcknowledgedAt?: string;
  reportAcknowledgedBy?: string;
  failure?: string;
}

interface PayoutFile {
  runs: PayoutRun[];
  /** A non-complete lock is intentionally sticky across a process restart. */
  locks: Array<{ spreadsheetId: string; runId: string; acquiredAt: string }>;
  generations?: Record<string, number>;
}

const storeOptions = {
  name: "payout-runs",
  get filePath() { return config.payoutFile; },
  empty: (): PayoutFile => ({ runs: [], locks: [], generations: {} }),
  validate(value: unknown): PayoutFile {
    const parsed = value as Partial<PayoutFile>;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Payout archive has an invalid format.");
    }
    if (!Array.isArray(parsed.runs) || !Array.isArray(parsed.locks)) {
      throw new Error("Payout archive has an invalid format.");
    }
    const validRun = (run: unknown): run is PayoutRun =>
        Boolean(run) && typeof run === "object" && typeof (run as PayoutRun).runId === "string" &&
        typeof (run as PayoutRun).spreadsheetId === "string" &&
        typeof (run as PayoutRun).guildId === "string" && Array.isArray((run as PayoutRun).roles);
    const validLock = (lock: unknown): lock is { spreadsheetId: string; runId: string; acquiredAt: string } =>
        Boolean(lock) && typeof lock === "object" && typeof (lock as { spreadsheetId?: unknown }).spreadsheetId === "string" &&
        typeof (lock as { runId?: unknown }).runId === "string" &&
        typeof (lock as { acquiredAt?: unknown }).acquiredAt === "string";
    if (!parsed.runs.every(validRun) || !parsed.locks.every(validLock)) {
      throw new Error("Payout archive contains an invalid run or lock.");
    }
    return {
      runs: parsed.runs,
      locks: parsed.locks,
      generations: parsed.generations && typeof parsed.generations === "object" ? parsed.generations : {},
    };
  },
};

export function validatePayoutRunsDocument(value: unknown): void {
  storeOptions.validate(value);
}

async function mutate<T>(operation: (store: PayoutFile) => T | Promise<T>): Promise<T> {
  return mutateBotDocument(storeOptions, operation);
}

/** Serialized read which never creates or rewrites the archive file. */
async function inspect<T>(operation: (store: PayoutFile) => T | Promise<T>): Promise<T> {
  return operation(await readBotDocument(storeOptions));
}

function copyRun(run: PayoutRun): PayoutRun {
  return JSON.parse(JSON.stringify(run)) as PayoutRun;
}

export async function createPayoutRun(run: PayoutRun): Promise<PayoutRun> {
  return mutate((store) => {
    if (store.runs.some((candidate) => candidate.runId === run.runId)) {
      throw new Error("This payout run ID already exists.");
    }
    store.runs.push(copyRun(run));
    return copyRun(run);
  });
}

export async function getPayoutRun(runId: string): Promise<PayoutRun | undefined> {
  return inspect((store) => {
    const run = store.runs.find((candidate) => candidate.runId === runId);
    return run && copyRun(run);
  });
}

export async function updatePayoutRun(
  runId: string,
  change: (run: PayoutRun) => void,
): Promise<PayoutRun> {
  return mutate((store) => {
    const run = store.runs.find((candidate) => candidate.runId === runId);
    if (!run) throw new Error("The payout run is unavailable.");
    change(run);
    run.updatedAt = new Date().toISOString();
    return copyRun(run);
  });
}

/**
 * Persistent lock acquisition is a compare-and-set in the same atomic local
 * file commit as the lock write. An abandoned non-complete run therefore
 * fails closed after restart rather than permitting an overlapping reset.
 */
export async function acquirePayoutLock(spreadsheetId: string, runId: string): Promise<void> {
  await mutate((store) => {
    const current = store.locks.find((lock) => lock.spreadsheetId === spreadsheetId);
    if (current && current.runId !== runId) {
      throw new Error(`Payout reset is already locked by run ${current.runId}. Recover that run before starting another payout.`);
    }
    const run = store.runs.find((candidate) => candidate.runId === runId);
    if (!run) throw new Error("The payout run is unavailable.");
    if (run.spreadsheetId !== spreadsheetId) throw new Error("The payout lock does not match its archived workbook.");
    // A fully finalized run must never recreate a lock/generation merely
    // because a stale button is clicked. A legacy completed run that still has
    // its old matching lock remains claimable so finalization can repair it.
    if (run.state === "complete" && !current) return;
    if (!current) store.locks.push({ spreadsheetId, runId, acquiredAt: new Date().toISOString() });
    if (run.state === "previewed" || run.state === "archived") run.state = "locked";
    run.updatedAt = new Date().toISOString();
  });
}

/**
 * One durable commit for the irreversible completion boundary. A crash can no
 * longer leave a completed run behind a still-active lock. The operation also
 * repairs archives produced by the older two-step implementation: a matching
 * completed lock is released and increments generation exactly once.
 */
export async function finalizePayoutRun(runId: string): Promise<PayoutRun> {
  return mutate((store) => {
    const run = store.runs.find((candidate) => candidate.runId === runId);
    if (!run) throw new Error("The payout run is unavailable.");
    const lock = store.locks.find((candidate) => candidate.spreadsheetId === run.spreadsheetId);
    if (lock && lock.runId !== runId) {
      throw new Error("Another payout run owns this workbook lock.");
    }
    if (run.state !== "complete" && !lock) {
      throw new Error("The payout completion lock is unavailable.");
    }
    const hadMatchingLock = Boolean(lock);
    run.state = "complete";
    delete run.failure;
    run.updatedAt = new Date().toISOString();
    if (hadMatchingLock) {
      store.generations ??= {};
      store.generations[run.spreadsheetId] = (store.generations[run.spreadsheetId] ?? 0) + 1;
      store.locks = store.locks.filter((candidate) => candidate !== lock);
    }
    return copyRun(run);
  });
}
export async function payoutWorkbookGeneration(spreadsheetId: string): Promise<number> {
  return inspect((store) => store.generations?.[spreadsheetId] ?? 0);
}

/** A stale preview can release its lock only before any DM or Sheets mutation. */
export async function releaseUnreportedPayoutLock(spreadsheetId: string, runId: string): Promise<void> {
  await mutate((store) => {
    const run = store.runs.find((candidate) => candidate.runId === runId);
    if (!run || run.reportState !== "not-started" || (run.state !== "locked" && run.state !== "archived")) {
      throw new Error("This payout lock cannot be released after reporting or reset work began.");
    }
    run.state = "archived";
    run.updatedAt = new Date().toISOString();
    store.locks = store.locks.filter((lock) => lock.spreadsheetId !== spreadsheetId || lock.runId !== runId);
  });
}

export async function payoutLockForWorkbook(
  spreadsheetId: string,
): Promise<{ spreadsheetId: string; runId: string; acquiredAt: string } | undefined> {
  return inspect((store) => store.locks.find((lock) => lock.spreadsheetId === spreadsheetId));
}

/** Recovery discovery is guild-scoped so a settings edit cannot hide a lock. */
export async function activePayoutRunForGuild(guildId: string): Promise<PayoutRun | undefined> {
  return inspect((store) => {
    const locked = new Set(store.locks.map((lock) => lock.runId));
    const runs = store.runs
      .filter((run) => run.guildId === guildId && locked.has(run.runId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return runs[0] && copyRun(runs[0]);
  });
}

export function resetPayoutStoreForTests(): void {
  resetPersistentStoreForTests();
}
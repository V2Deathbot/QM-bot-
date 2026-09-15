import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { config } from "./config";

export type UniformDiscordNonceKind = "notice" | "customer" | "purchased" | "assistance" | "sold" | "relog";

/**
 * Discord accepts nonces up to 25 characters. Interaction IDs are already
 * commonly 19–20 digits, so suffixing one directly can exceed that limit.
 * Keep a readable type prefix and derive the remaining collision-resistant
 * portion from both immutable inputs.
 */
export function uniformDiscordNonce(
  kind: UniformDiscordNonceKind,
  submissionId: string,
): string {
  const prefix = `u-${kind}-`;
  const digestLength = 25 - prefix.length;
  return `${prefix}${createHash("sha256")
    .update(`uniform-delivery:${kind}:${submissionId}`)
    .digest("hex")
    .slice(0, digestLength)}`;
}

export interface UniformDeliveryRecord {
  submissionId: string;
  guildId: string;
  command: "log" | "moderated";
  actorId: string;
  customerId: string;
  seqmId: string;
  destinationChannelId: string;
  /** The configured upload-log channel at the moment Submit was first pressed. */
  uploadLogChannelId: string;
  /** Frozen data-only Sheets destination and values. Never derive a retry from later settings. */
  spreadsheet: {
    spreadsheetId: string;
    logTab: string;
    moderatedTab: string;
    logRange?: string;
    moderatedRange?: string;
  };
  rows: string[][];
  sheetState: "prepared" | "saved";
  assets: Array<{ id: number; url: string }>;
  customerName: string;
  /** Real ticket channel name frozen at submission time; never infer it from a Discord user. */
  ticketChannelName?: string;
  /** The original upload audit message, when it was durably recorded. */
  auditMessageId?: string;
  logNoticeState: "pending" | "claimed" | "sent" | "unresolved";
  customerDeliveryState: "pending" | "claimed" | "sent" | "unresolved";
  customerMessageId?: string;
  /** Incremented before a replacement delivery invalidates prior controls. */
  customerMessageRevision?: number;
  /**
   * A replacement is a separate durable outbox from the initial delivery.
   * Its fixed nonce and selected original row make restart/retry handling
   * safe without appending sheet rows or reusing the old customer message.
   */
  relog?: {
    state: "claimed" | "sheet-updated" | "pending" | "customer-claimed" | "sent" | "unresolved";
    /** A distinct outbox: a customer replacement must never be replayed for an audit retry. */
    auditState?: "pending" | "claimed" | "sent" | "unresolved";
    rowIndex: number;
    newAsset: { id: number; url: string };
    oldCustomerMessageId?: string;
    nonce: string;
    startedAt: string;
  };
  /**
   * A one-time, manually confirmed migration marker for a delivery rejected
   * before Discord accepted the legacy overlong notice nonce.
   */
  legacyNonceRejected?: true;
  terminal?: "purchased" | "assistance";
  action?: {
    kind: "purchased" | "assistance";
    reason?: string;
    state: "claimed" | "sent" | "unresolved";
    /** Audit completion is separate from the customer-facing confirmation. */
    auditState?: "pending" | "claimed" | "sent" | "unresolved";
    nonce: string;
  };
  createdAt: string;
}

interface DeliveryFile { records: UniformDeliveryRecord[]; }
let queue: Promise<void> = Promise.resolve();

async function readStore(): Promise<DeliveryFile> {
  try {
    const value = JSON.parse(await readFile(config.uniformDeliveryFile, "utf8")) as { records?: unknown };
    if (!Array.isArray(value.records)) throw new Error("Uniform delivery record file has an invalid format.");
    return {
      records: value.records.filter((record): record is UniformDeliveryRecord =>
        Boolean(record) && typeof record === "object" &&
        typeof (record as UniformDeliveryRecord).submissionId === "string" &&
        typeof (record as UniformDeliveryRecord).guildId === "string" &&
        typeof (record as UniformDeliveryRecord).customerId === "string" &&
        typeof (record as UniformDeliveryRecord).seqmId === "string" &&
        typeof (record as UniformDeliveryRecord).destinationChannelId === "string" &&
        typeof (record as UniformDeliveryRecord).uploadLogChannelId === "string" &&
        ((record as UniformDeliveryRecord).command === "log" ||
          (record as UniformDeliveryRecord).command === "moderated") &&
        Array.isArray((record as UniformDeliveryRecord).assets),
      ),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [] };
    throw error;
  }
}

async function writeStore(store: DeliveryFile): Promise<void> {
  await mkdir(path.dirname(config.uniformDeliveryFile), { recursive: true });
  const temporary = `${config.uniformDeliveryFile}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2), "utf8");
  await rename(temporary, config.uniformDeliveryFile);
}

async function mutate<T>(operation: (store: DeliveryFile) => T | Promise<T>): Promise<T> {
  const result = queue.then(async () => {
    const store = await readStore();
    const value = await operation(store);
    await writeStore(store);
    return value;
  });
  queue = result.then(() => undefined, () => undefined);
  return result;
}

export async function getUniformDelivery(submissionId: string): Promise<UniformDeliveryRecord | undefined> {
  return mutate((store) => store.records.find((record) => record.submissionId === submissionId));
}

/** Only durable records, never username matching, are candidates for /relog. */
export async function findUniformDeliveriesForChannel(
  guildId: string,
  channelId: string,
): Promise<UniformDeliveryRecord[]> {
  return mutate((store) => store.records.filter((record) =>
    record.guildId === guildId &&
    record.destinationChannelId === channelId &&
    record.sheetState === "saved" &&
    Boolean(record.customerMessageId || record.relog),
  ));
}

/** Create only after Sheets has committed. Existing records make delivery retries idempotent. */
export async function saveUniformDelivery(record: UniformDeliveryRecord): Promise<UniformDeliveryRecord> {
  return mutate((store) => {
    const existing = store.records.find((item) => item.submissionId === record.submissionId);
    if (existing) return existing;
    store.records.push(record);
    return record;
  });
}

export async function updateUniformDelivery(
  submissionId: string,
  change: (record: UniformDeliveryRecord) => void,
): Promise<UniformDeliveryRecord> {
  return mutate((store) => {
    const record = store.records.find((item) => item.submissionId === submissionId);
    if (!record) throw new Error("This uniform delivery record is unavailable.");
    change(record);
    return record;
  });
}

function canRecoverLegacyNonceRejection(record: UniformDeliveryRecord): boolean {
  return record.legacyNonceRejected === true &&
    record.sheetState === "saved" &&
    record.logNoticeState === "unresolved" &&
    record.customerDeliveryState === "pending" &&
    !record.customerMessageId;
}

export async function findLegacyNonceRejectedDelivery(
  guildId: string,
): Promise<UniformDeliveryRecord | undefined> {
  return mutate((store) => store.records.find((record) =>
    record.guildId === guildId && canRecoverLegacyNonceRejection(record),
  ));
}

/**
 * This is intentionally narrower than a general unresolved retry. The marker
 * is surgically applied only after an operator has confirmed Discord rejected
 * the legacy nonce before message creation. Claimed and generic unresolved
 * states remain non-replayable.
 */
export async function recoverLegacyNonceRejectedDelivery(
  guildId: string,
  submissionId: string,
): Promise<UniformDeliveryRecord> {
  return mutate((store) => {
    const record = store.records.find((item) =>
      item.guildId === guildId && item.submissionId === submissionId,
    );
    if (!record || !canRecoverLegacyNonceRejection(record)) {
      throw new Error("This delivery is not eligible for legacy nonce recovery.");
    }
    record.logNoticeState = "pending";
    delete record.legacyNonceRejected;
    return record;
  });
}

export async function claimUniformDeliveryAction(
  submissionId: string,
  kind: "purchased" | "assistance",
  reason?: string,
  expected?: { customerMessageId: string; customerMessageRevision: number },
): Promise<UniformDeliveryRecord> {
  return updateUniformDelivery(submissionId, (record) => {
    if (
      expected &&
      (record.customerMessageId !== expected.customerMessageId ||
        (record.customerMessageRevision ?? 0) !== expected.customerMessageRevision)
    ) {
      throw new Error("This uniform delivery control is no longer attached to its recorded customer message.");
    }
    // A replacement invalidates the prior message before its Sheet/send work
    // begins. Do not let an already-open old button interleave an action with
    // that replacement.
    if (record.relog && record.relog.state !== "sent") return;
    if (record.terminal || record.action) return;
    record.action = {
      kind, ...(reason ? { reason } : {}), state: "claimed",
      nonce: uniformDiscordNonce(kind, record.submissionId),
    };
  });
}

export function resetUniformDeliveryStoreForTests(): void {
  queue = Promise.resolve();
}
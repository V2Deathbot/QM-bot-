import { createHash } from "node:crypto";
import { config } from "./config";
import { mutateBotDocument, readBotDocument, resetPersistentStoreForTests } from "./persistent-store";

export type UniformDiscordNonceKind =
  | "notice"
  | "customer"
  | "purchased"
  | "assistance"
  | "sold"
  | "relog"
  | "moderated";

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
  /** Immutable Roblox user ID used for ownership verification. Missing on legacy records. */
  customerRobloxId?: number;
  /** Real ticket channel name frozen at submission time; never infer it from a Discord user. */
  ticketChannelName?: string;
  /** Attachment-driven Roblox publishing handoff for new uniform submissions. */
  publishing?: {
    state:
      | "handoff-pending"
      | "handoff-claimed"
      | "awaiting-result"
      | "moderation-pending"
      | "publish-claimed"
      | "published"
      | "moderation-claimed"
      | "moderated"
      | "unresolved";
    uniformType: string;
    /** Per-shirt Roblox descriptions, ordered with attachments. */
    uniformTypes?: string[];
    publisherName: string;
    /** Current stage of the two-step creation workflow. */
    stage?: "seqm-review" | "publisher";
    /** Publisher channel frozen when /created was submitted. */
    publisherChannelId?: string;
    moderatedChannelId?: string;
    seqmRoleId?: string;
    /** Senior Quartermaster display name captured on approval. */
    seqmName?: string;
    /** Exact asset approved by the Senior Quartermaster. */
    approvedAsset?: { id: number; url: string };
    attachments?: Array<{
      name: string;
      contentType: "image/png";
      size: number;
      url: string;
    }>;
    sourceDataBase64s?: string[];
    approvedAssets?: Array<{ id: number; url: string }>;
    /** Original zero-based shirt indexes corresponding to approvedAssets. */
    approvedAssetIndices?: number[];
    /** Approved shirt indexes that still require publisher action. */
    publisherAssetIndices?: number[];
    /** Approved assets Roblox already reports as published, delivered before publisher work. */
    alreadyPublishedAssets?: Array<{ id: number; url: string }>;
    alreadyPublishedAssetIndices?: number[];
    earlyCustomerDeliveryState?: "pending" | "claimed" | "sent" | "unresolved";
    earlyCustomerMessageId?: string;
    moderatedIndices?: number[];
    /** Durable moderated-result notification outbox for an automatically polled asset. */
    moderationNoticeState?: "pending" | "claimed" | "sent" | "unresolved";
    attachment: {
      name: string;
      contentType: "image/png";
      size: number;
      url: string;
    };
    /** Temporary durable source, removed once Discord confirms the handoff message. */
    sourceDataBase64?: string;
    handoffMessageId?: string;
    completedAt?: string;
  };
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
    publisherName?: string;
    oldCustomerMessageId?: string;
    nonce: string;
    startedAt: string;
  };
  /** Replacement PNG publishing handoff. The old row/message remain authoritative until published. */
  relogHandoff?: {
    state:
      | "handoff-pending"
      | "handoff-claimed"
      | "awaiting-result"
      | "publish-claimed"
      | "published"
      | "moderation-claimed"
      | "moderated"
      | "unresolved";
    actorId: string;
    publisherName?: string;
    rowIndex: number;
    uniformType: string;
    attachment: {
      name: string;
      contentType: "image/png";
      size: number;
      url: string;
    };
    nonce: string;
    /** Temporary durable source, removed once Discord confirms the handoff message. */
    sourceDataBase64?: string;
    /** Verified catalog asset retained so publish-claimed recovery can resume after restart. */
    publishedAsset?: { id: number; url: string };
    handoffMessageId?: string;
    completedAt?: string;
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
    /** Purchase sheet update completed before the customer confirmation was sent. */
    purchaseSheetState?: "sold";
    /** Audit completion is separate from the customer-facing confirmation. */
    auditState?: "pending" | "claimed" | "sent" | "unresolved";
    nonce: string;
  };
  /** Retained for audit, but never actionable after its workbook's payout reset. */
  invalidatedByPayoutRunId?: string;
  createdAt: string;
}

interface DeliveryFile { records: UniformDeliveryRecord[]; }

const storeOptions = {
  name: "uniform-deliveries",
  get filePath() { return config.uniformDeliveryFile; },
  empty: (): DeliveryFile => ({ records: [] }),
  validate(value: unknown): DeliveryFile {
    const parsed = value as { records?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.records)) {
      throw new Error("Uniform delivery record file has an invalid format.");
    }
    const validRecord = (record: unknown): record is UniformDeliveryRecord =>
        Boolean(record) && typeof record === "object" &&
        typeof (record as UniformDeliveryRecord).submissionId === "string" &&
        typeof (record as UniformDeliveryRecord).guildId === "string" &&
        typeof (record as UniformDeliveryRecord).customerId === "string" &&
        typeof (record as UniformDeliveryRecord).seqmId === "string" &&
        typeof (record as UniformDeliveryRecord).destinationChannelId === "string" &&
        typeof (record as UniformDeliveryRecord).uploadLogChannelId === "string" &&
        ((record as UniformDeliveryRecord).command === "log" ||
          (record as UniformDeliveryRecord).command === "moderated") &&
        Array.isArray((record as UniformDeliveryRecord).assets);
    if (!parsed.records.every(validRecord)) {
      throw new Error("Uniform delivery record document contains an invalid record.");
    }
    return {
      records: parsed.records,
    };
  },
};

export function validateUniformDeliveriesDocument(value: unknown): void {
  storeOptions.validate(value);
}

async function mutate<T>(operation: (store: DeliveryFile) => T | Promise<T>): Promise<T> {
  return mutateBotDocument(storeOptions, operation);
}

export async function getUniformDelivery(submissionId: string): Promise<UniformDeliveryRecord | undefined> {
  const store = await readBotDocument(storeOptions);
  return store.records.find((record) => record.submissionId === submissionId);
}

export async function findPendingUniformModerationChecks(): Promise<UniformDeliveryRecord[]> {
  const store = await readBotDocument(storeOptions);
  return store.records.filter((record) =>
    !record.invalidatedByPayoutRunId &&
    record.command === "log" &&
    record.publishing?.stage === "seqm-review" &&
    (record.publishing.state === "moderation-pending" ||
      record.publishing.state === "moderation-claimed"),
  );
}

/** Only durable records, never username matching, are candidates for /relog. */
export async function findUniformDeliveriesForChannel(
  guildId: string,
  channelId: string,
): Promise<UniformDeliveryRecord[]> {
  const store = await readBotDocument(storeOptions);
  return store.records.filter((record) =>
    record.guildId === guildId &&
    record.destinationChannelId === channelId &&
    record.sheetState === "saved" &&
      !record.invalidatedByPayoutRunId &&
    Boolean(record.customerMessageId || record.relog),
  );
}

/** Create only after Sheets has committed. Existing records make delivery retries idempotent. */
export async function saveUniformDelivery(record: UniformDeliveryRecord): Promise<UniformDeliveryRecord> {
  return mutate((store) => {
    const existing = store.records.find((item) => item.submissionId === record.submissionId);
    if (existing?.invalidatedByPayoutRunId) {
      throw new Error("This uniform submission belongs to a completed payout cycle and cannot write reset rows.");
    }
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
    if (record.invalidatedByPayoutRunId) {
      throw new Error("This uniform delivery belongs to a completed payout cycle and cannot be changed.");
    }
    change(record);
    return record;
  });
}

/** Preserve delivery audit history while invalidating every old control/retry. */
export async function invalidateUniformDeliveriesForPayout(
  spreadsheetId: string,
  payoutRunId: string,
): Promise<void> {
  await mutate((store) => {
    for (const record of store.records) {
      if (record.spreadsheet.spreadsheetId === spreadsheetId) {
        record.invalidatedByPayoutRunId ??= payoutRunId;
      }
    }
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
  const store = await readBotDocument(storeOptions);
  return store.records.find((record) =>
    record.guildId === guildId && !record.invalidatedByPayoutRunId && canRecoverLegacyNonceRejection(record),
  );
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
    // This callback runs inside the persistent-store transaction.  Returning
    // the existing record here made two concurrent customer clicks both look
    // like the caller had won the claim, so both could perform the irreversible
    // Sold/Discord work.  A competing claim must fail without changing the
    // durable record.
    if (record.terminal || record.action) {
      throw new Error("This customer outcome is already claimed or unresolved. It will not be sent again automatically.");
    }
    record.action = {
      kind, ...(reason ? { reason } : {}), state: "claimed",
      nonce: uniformDiscordNonce(kind, record.submissionId),
    };
  });
}

/**
 * Atomically claims one Discord delivery outbox.  The caller must persist the
 * claim before contacting Discord; a concurrent retry therefore observes a
 * non-pending state and cannot issue a second message.
 */
export async function claimUniformDeliveryStage(
  submissionId: string,
  stage: "logNotice" | "customerDelivery",
): Promise<UniformDeliveryRecord> {
  return updateUniformDelivery(submissionId, (record) => {
    const state = stage === "logNotice"
      ? record.logNoticeState
      : record.customerDeliveryState;
    if (state !== "pending") {
      throw new Error("This Discord delivery is already claimed or unresolved. No duplicate message will be sent.");
    }
    if (stage === "logNotice") record.logNoticeState = "claimed";
    else record.customerDeliveryState = "claimed";
  });
}

export function resetUniformDeliveryStoreForTests(): void {
  resetPersistentStoreForTests();
}
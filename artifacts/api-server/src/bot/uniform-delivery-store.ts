import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

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
  logNoticeState: "pending" | "claimed" | "sent" | "unresolved";
  customerDeliveryState: "pending" | "claimed" | "sent" | "unresolved";
  customerMessageId?: string;
  terminal?: "purchased" | "assistance";
  action?: {
    kind: "purchased" | "assistance";
    reason?: string;
    state: "claimed" | "sent" | "unresolved";
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

export async function claimUniformDeliveryAction(
  submissionId: string,
  kind: "purchased" | "assistance",
  reason?: string,
): Promise<UniformDeliveryRecord> {
  return updateUniformDelivery(submissionId, (record) => {
    if (record.terminal || record.action) return;
    record.action = {
      kind, ...(reason ? { reason } : {}), state: "claimed",
      nonce: `${record.submissionId}-${kind}`,
    };
  });
}

export function resetUniformDeliveryStoreForTests(): void {
  queue = Promise.resolve();
}
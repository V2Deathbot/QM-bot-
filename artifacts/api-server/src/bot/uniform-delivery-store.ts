/**
 * Legacy delivery-document validator retained for the one-time data importer.
 *
 * Uniform delivery commands and recovery are no longer executable features.
 * The importer validates only the old record envelope and inserts the exact
 * original document, preserving all audit and recovery fields byte-for-byte.
 */
interface LegacyUniformDelivery {
  submissionId: string;
  guildId: string;
  customerId: string;
  seqmId: string;
  destinationChannelId: string;
  uploadLogChannelId: string;
  command: "log" | "moderated";
  assets: unknown[];
}

export function validateUniformDeliveriesDocument(value: unknown): void {
  if (!value || typeof value !== "object" ||
      !Array.isArray((value as { records?: unknown }).records)) {
    throw new Error("Uniform delivery record file has an invalid format.");
  }
  const records = (value as { records: unknown[] }).records;
  const validRecord = (record: unknown): record is LegacyUniformDelivery =>
    Boolean(record) &&
    typeof record === "object" &&
    typeof (record as LegacyUniformDelivery).submissionId === "string" &&
    typeof (record as LegacyUniformDelivery).guildId === "string" &&
    typeof (record as LegacyUniformDelivery).customerId === "string" &&
    typeof (record as LegacyUniformDelivery).seqmId === "string" &&
    typeof (record as LegacyUniformDelivery).destinationChannelId === "string" &&
    typeof (record as LegacyUniformDelivery).uploadLogChannelId === "string" &&
    ((record as LegacyUniformDelivery).command === "log" ||
      (record as LegacyUniformDelivery).command === "moderated") &&
    Array.isArray((record as LegacyUniformDelivery).assets);
  if (!records.every(validRecord)) {
    throw new Error("Uniform delivery record document contains an invalid record.");
  }
}
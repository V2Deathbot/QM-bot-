/**
 * Legacy document validator retained for the one-time importer.
 *
 * Google Sheets uniform logging is no longer an executable bot feature. This
 * validator intentionally checks only the historical document envelope and
 * required record fields; the importer stores the original JSON unchanged.
 */
interface LegacyUniformSubmission {
  key: string;
  destination: string;
  submissionId: string;
  targetRange: string;
  values: string[][];
  state: "reserved" | "written";
  notified: boolean;
  createdAt: string;
}

export function validateUniformSubmissionLedgerDocument(value: unknown): void {
  if (!value || typeof value !== "object") {
    throw new Error("Uniform submission ledger has an invalid format.");
  }
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error("Uniform submission ledger has an invalid format.");
  }
  const isRecord = (entry: unknown): entry is LegacyUniformSubmission =>
    Boolean(entry) &&
    typeof entry === "object" &&
    typeof (entry as LegacyUniformSubmission).key === "string" &&
    typeof (entry as LegacyUniformSubmission).destination === "string" &&
    typeof (entry as LegacyUniformSubmission).submissionId === "string" &&
    typeof (entry as LegacyUniformSubmission).targetRange === "string" &&
    Array.isArray((entry as LegacyUniformSubmission).values) &&
    ["reserved", "written"].includes((entry as LegacyUniformSubmission).state) &&
    typeof (entry as LegacyUniformSubmission).notified === "boolean" &&
    typeof (entry as LegacyUniformSubmission).createdAt === "string";
  if (!entries.every(isRecord)) {
    throw new Error("Uniform submission ledger contains an invalid record.");
  }
}
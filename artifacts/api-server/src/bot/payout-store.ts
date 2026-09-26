/**
 * Legacy payout archive validator retained for the one-time data importer.
 *
 * Payout operations are no longer part of the bot. The validator checks the
 * archive envelope and stable identifiers while leaving the imported JSON
 * untouched, including fields added by historical versions.
 */
interface LegacyPayoutRun {
  runId: string;
  spreadsheetId: string;
  guildId: string;
  roles: unknown[];
}

interface LegacyPayoutLock {
  spreadsheetId: string;
  runId: string;
  acquiredAt: string;
}

export function validatePayoutRunsDocument(value: unknown): void {
  if (!value || typeof value !== "object") {
    throw new Error("Payout archive has an invalid format.");
  }
  const parsed = value as { runs?: unknown; locks?: unknown };
  if (!Array.isArray(parsed.runs) || !Array.isArray(parsed.locks)) {
    throw new Error("Payout archive has an invalid format.");
  }
  const validRun = (run: unknown): run is LegacyPayoutRun =>
    Boolean(run) &&
    typeof run === "object" &&
    typeof (run as LegacyPayoutRun).runId === "string" &&
    typeof (run as LegacyPayoutRun).spreadsheetId === "string" &&
    typeof (run as LegacyPayoutRun).guildId === "string" &&
    Array.isArray((run as LegacyPayoutRun).roles);
  const validLock = (lock: unknown): lock is LegacyPayoutLock =>
    Boolean(lock) &&
    typeof lock === "object" &&
    typeof (lock as LegacyPayoutLock).spreadsheetId === "string" &&
    typeof (lock as LegacyPayoutLock).runId === "string" &&
    typeof (lock as LegacyPayoutLock).acquiredAt === "string";
  if (!parsed.runs.every(validRun) || !parsed.locks.every(validLock)) {
    throw new Error("Payout archive contains an invalid run or lock.");
  }
}
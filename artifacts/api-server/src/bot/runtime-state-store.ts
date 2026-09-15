import { config } from "./config";
import { mutateBotDocument, readBotDocument } from "./persistent-store";

export interface PersistedRecoveryState {
  status: "pending" | "successful" | "blocked";
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  error: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  lastRetryAt: string | null;
  lastRetryOutcome: "pending" | "successful" | "blocked" | null;
}

interface RuntimeStateDocument {
  recovery: PersistedRecoveryState;
}

export const emptyRecoveryState = (): PersistedRecoveryState => ({
  status: "pending",
  lastAttemptAt: null,
  lastSuccessfulAt: null,
  error: null,
  retryCount: 0,
  nextRetryAt: null,
  lastRetryAt: null,
  lastRetryOutcome: null,
});

const options = {
  name: "bot-runtime-state",
  get filePath() { return config.runtimeStateFile; },
  empty: (): RuntimeStateDocument => ({ recovery: emptyRecoveryState() }),
  validate(value: unknown): RuntimeStateDocument {
    const document = value as Partial<RuntimeStateDocument>;
    const recovery = document?.recovery as Partial<PersistedRecoveryState> | undefined;
    if (!document || typeof document !== "object" || !recovery ||
        !["pending", "successful", "blocked"].includes(recovery.status ?? "") ||
        typeof recovery.retryCount !== "number" || !Number.isSafeInteger(recovery.retryCount) ||
        recovery.retryCount < 0) {
      throw new Error("The persistent bot runtime state document has an invalid format.");
    }
    return { recovery: { ...emptyRecoveryState(), ...recovery } as PersistedRecoveryState };
  },
};

export function validatePersistedRecoveryDocument(value: unknown): void {
  options.validate(value);
}

export async function readPersistedRecoveryState(): Promise<PersistedRecoveryState> {
  return (await readBotDocument(options)).recovery;
}

export async function savePersistedRecoveryState(
  recovery: PersistedRecoveryState,
): Promise<void> {
  await mutateBotDocument(options, (document) => {
    document.recovery = structuredClone(recovery);
  });
}
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

export interface RateLimitAction {
  actorId: string;
  action: "blacklist" | "group_blacklist" | "revoke_blacklist";
  at: string;
}

export interface SecurityState {
  guildId: string;
  lockdown: {
    active: boolean;
    automatic: boolean;
    reason: string;
    startedAt: string | null;
    startedBy: string | null;
  };
  destructiveActions: RateLimitAction[];
  /** Existing administrators observed at boot are trusted; only later grants are escalations. */
  observedAdministrators: Record<string, string>;
  identityLedger: Array<{
    discordUserId: string;
    robloxUserId: number;
    observedAt: string;
    source: "command" | "verified";
  }>;
}

interface SecurityFile {
  guilds: SecurityState[];
}

let queue: Promise<void> = Promise.resolve();

const blank = (guildId: string): SecurityState => ({
  guildId,
  lockdown: {
    active: false,
    automatic: false,
    reason: "",
    startedAt: null,
    startedBy: null,
  },
  destructiveActions: [],
  observedAdministrators: {},
  identityLedger: [],
});

function valid(value: unknown): value is SecurityState {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.guildId === "string" && typeof item.lockdown === "object";
}

async function readStore(): Promise<SecurityFile> {
  try {
    const parsed = JSON.parse(await readFile(config.securityFile, "utf8")) as {
      guilds?: unknown;
    };
    if (!Array.isArray(parsed.guilds) || !parsed.guilds.every(valid)) {
      throw new Error("The security state file has an invalid format.");
    }
    return { guilds: parsed.guilds as SecurityState[] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { guilds: [] };
    throw error;
  }
}

async function writeStore(store: SecurityFile): Promise<void> {
  await mkdir(path.dirname(config.securityFile), { recursive: true });
  const temporary = `${config.securityFile}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2), "utf8");
  await rename(temporary, config.securityFile);
}

export async function getSecurityState(guildId: string): Promise<SecurityState> {
  await queue;
  const store = await readStore();
  const found = store.guilds.find((entry) => entry.guildId === guildId);
  return structuredClone(found ?? blank(guildId));
}

/** Serializes read-modify-write operations so concurrent interactions cannot overspend limits. */
export async function mutateSecurityState<T>(
  guildId: string,
  mutation: (state: SecurityState) => T | Promise<T>,
): Promise<T> {
  let value!: T;
  const operation = queue.then(async () => {
    const store = await readStore();
    let state = store.guilds.find((entry) => entry.guildId === guildId);
    if (!state) {
      state = blank(guildId);
      store.guilds.push(state);
    }
    value = await mutation(state);
    await writeStore(store);
  });
  queue = operation.catch(() => undefined);
  await operation;
  return value;
}

export async function recordIdentityAssociation(
  guildId: string,
  discordUserId: string,
  robloxUserId: number,
  source: "command" | "verified" = "command",
): Promise<{ warnings: string[] }> {
  return mutateSecurityState(guildId, (state) => {
    const warnings: string[] = [];
    const discordMatches = state.identityLedger.filter(
      (entry) => entry.discordUserId === discordUserId && entry.robloxUserId !== robloxUserId,
    );
    const robloxMatches = state.identityLedger.filter(
      (entry) => entry.robloxUserId === robloxUserId && entry.discordUserId !== discordUserId,
    );
    if (discordMatches.length) warnings.push("same_discord_different_roblox");
    if (robloxMatches.length) warnings.push("same_roblox_different_discord");
    if (!state.identityLedger.some((entry) => entry.discordUserId === discordUserId && entry.robloxUserId === robloxUserId)) {
      state.identityLedger.push({ discordUserId, robloxUserId, observedAt: new Date().toISOString(), source });
    }
    return { warnings };
  });
}
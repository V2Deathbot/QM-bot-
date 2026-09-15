import { config } from "./config";
import { isFileBotStorage, mutateBotDocument, readBotDocument } from "./persistent-store";

export interface RoleSnapshot {
  key: string;
  guildId: string;
  discordUserId: string;
  robloxUserId: number;
  robloxUsername: string;
  roleIds: string[];
  cardId?: string;
  cardUrl?: string;
  cardUpdatedAt?: string;
  blacklistType?: string;
  blacklistReason?: string;
  source?: "command" | "sync";
  blacklistNotificationAttemptedAt?: string;
  revocationNotificationAttemptedAt?: string;
  status: "pending" | "active" | "revocation_pending" | "revoked" | "failed";
  createdAt: string;
  revokedAt?: string;
  revocationCardMovedAt?: string;
}

interface SnapshotFile {
  snapshots: RoleSnapshot[];
  notes?: BlacklistNote[];
}

export interface BlacklistNote {
  id: string;
  guildId: string;
  robloxUserId?: number;
  robloxUsername?: string;
  actorId: string;
  text: string;
  createdAt: string;
}

const memberQueues = new Map<string, Promise<void>>();
const guildLifecycleQueues = new Map<string, Promise<void>>();
let loaded: SnapshotFile | undefined;

/** Serializes command and synchronizer role sinks for the same Discord account. */
export function withMemberRoleLock<T>(
  guildId: string,
  discordUserId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${guildId}:${discordUserId}`;
  const previous = memberQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.then(() => undefined, () => undefined);
  memberQueues.set(key, settled);
  void settled.finally(() => {
    if (memberQueues.get(key) === settled) memberQueues.delete(key);
  });
  return current;
}

/**
 * Commands, joins, and polling all change a guild's blacklist lifecycle.
 * Serializing that complete lifecycle avoids a stale command/sync read
 * overwriting a newer snapshot.  Do not call this recursively.
 */
export function withGuildBlacklistLifecycleLock<T>(
  guildId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = guildLifecycleQueues.get(guildId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.then(() => undefined, () => undefined);
  guildLifecycleQueues.set(guildId, settled);
  void settled.finally(() => {
    if (guildLifecycleQueues.get(guildId) === settled) {
      guildLifecycleQueues.delete(guildId);
    }
  });
  return current;
}

async function load(): Promise<SnapshotFile> {
  if (isFileBotStorage() && loaded) return cloneFile(loaded);
  const file = await readBotDocument(storeOptions);
  if (isFileBotStorage()) loaded = cloneFile(file);
  return file;
}

function cloneSnapshot(snapshot: RoleSnapshot): RoleSnapshot {
  return { ...snapshot, roleIds: [...snapshot.roleIds] };
}

function cloneFile(file: SnapshotFile): SnapshotFile {
  return {
    snapshots: file.snapshots.map(cloneSnapshot),
    notes: file.notes?.map((note) => ({ ...note })),
  };
}

const storeOptions = {
  name: "role-snapshots",
  get filePath() { return config.snapshotFile; },
  empty: (): SnapshotFile => ({ snapshots: [], notes: [] }),
  validate(value: unknown): SnapshotFile {
    const file = value as Partial<SnapshotFile>;
    if (!file || typeof file !== "object" || !Array.isArray(file.snapshots) ||
        (file.notes !== undefined && !Array.isArray(file.notes))) {
      throw new Error("The persistent role snapshot document has an invalid format.");
    }
    if (!file.snapshots.every((snapshot) => {
      const value = snapshot as Partial<RoleSnapshot>;
      return Boolean(value) && typeof value === "object" &&
        typeof value.key === "string" && typeof value.guildId === "string" &&
        typeof value.discordUserId === "string" && typeof value.robloxUserId === "number" &&
        Number.isSafeInteger(value.robloxUserId) && typeof value.robloxUsername === "string" &&
        Array.isArray(value.roleIds) && value.roleIds.every((id) => typeof id === "string") &&
        ["pending", "active", "revocation_pending", "revoked", "failed"].includes(value.status ?? "") &&
        typeof value.createdAt === "string";
    }) || !(file.notes ?? []).every((note) => {
      const value = note as Partial<BlacklistNote>;
      return Boolean(value) && typeof value === "object" && typeof value.id === "string" &&
        typeof value.guildId === "string" && typeof value.actorId === "string" &&
        typeof value.text === "string" && typeof value.createdAt === "string";
    })) {
      throw new Error("The persistent role snapshot document contains an invalid record.");
    }
    return {
      snapshots: file.snapshots as RoleSnapshot[],
      notes: (file.notes ?? []) as BlacklistNote[],
    };
  },
};

export function validateRoleSnapshotsDocument(value: unknown): void {
  storeOptions.validate(value);
}

/**
 * PostgreSQL serializes mutations across all bot processes. Clone before
 * changing state so a rejected mutation cannot publish a partial document.
 */
async function mutateFile<T>(
  mutation: (file: SnapshotFile) => T,
): Promise<T> {
  let committed: SnapshotFile | undefined;
  const result = await mutateBotDocument(storeOptions, (file) => {
    for (const snapshot of file.snapshots) snapshot.source ??= "command";
    const next = cloneFile(file);
    const result = mutation(next);
    file.snapshots = next.snapshots;
    file.notes = next.notes;
    committed = next;
    return result;
  });
  if (isFileBotStorage() && committed) loaded = cloneFile(committed);
  return result;
}

export async function saveRoleSnapshot(snapshot: RoleSnapshot): Promise<void> {
  await mutateFile((current) => {
    const saved = cloneSnapshot(snapshot);
    const index = current.snapshots.findIndex((item) => item.key === saved.key);
    if (index === -1) current.snapshots.push(saved);
    else current.snapshots[index] = saved;
  });
}

export async function findActiveSnapshot(
  guildId: string,
  robloxUserId: number,
): Promise<RoleSnapshot | undefined> {
  const current = await load();
  const snapshot = current.snapshots.find(
    (snapshot) =>
      snapshot.guildId === guildId &&
      snapshot.robloxUserId === robloxUserId &&
      snapshot.status === "active",
  );
  return snapshot ? cloneSnapshot(snapshot) : undefined;
}

export async function findRoleSnapshot(
  guildId: string,
  robloxUserId: number,
): Promise<RoleSnapshot | undefined> {
  const current = await load();
  const snapshot = current.snapshots.find(
    (candidate) =>
      candidate.guildId === guildId &&
      candidate.robloxUserId === robloxUserId,
  );
  return snapshot
    ? {
        ...snapshot,
        roleIds: [...snapshot.roleIds],
      }
    : undefined;
}

export async function findPendingOrActiveSnapshot(
  guildId: string,
  robloxUserId: number,
): Promise<RoleSnapshot | undefined> {
  const snapshot = await findRoleSnapshot(guildId, robloxUserId);
  return snapshot &&
    ["pending", "active", "revocation_pending"].includes(snapshot.status)
    ? snapshot
    : undefined;
}

export async function listActiveSnapshots(
  guildId: string,
): Promise<RoleSnapshot[]> {
  const current = await load();
  return current.snapshots
    .filter(
      (snapshot) =>
        snapshot.guildId === guildId && snapshot.status === "active",
    )
    .map((snapshot) => ({
      ...snapshot,
      roleIds: [...snapshot.roleIds],
    }));
}

export async function listApprovedSnapshotsForMember(
  guildId: string,
  discordUserId: string,
): Promise<RoleSnapshot[]> {
  const current = await load();
  return current.snapshots
    .filter((snapshot) =>
      snapshot.guildId === guildId &&
      snapshot.discordUserId === discordUserId &&
      snapshot.source === "command" &&
      ["pending", "active", "revocation_pending"].includes(snapshot.status),
    )
    .map((snapshot) => ({ ...snapshot, roleIds: [...snapshot.roleIds] }));
}

/** All command snapshots for an account, including completed revocations. */
export async function listSnapshotsForMember(
  guildId: string,
  discordUserId: string,
): Promise<RoleSnapshot[]> {
  const current = await load();
  return current.snapshots
    .filter(
      (snapshot) =>
        snapshot.guildId === guildId &&
        snapshot.discordUserId === discordUserId &&
        snapshot.source === "command",
    )
    .map((snapshot) => ({ ...snapshot, roleIds: [...snapshot.roleIds] }));
}

export async function saveBlacklistNote(note: BlacklistNote): Promise<void> {
  await mutateFile((current) => {
    current.notes ??= [];
    current.notes.push({ ...note });
  });
}

export async function listBlacklistNotes(
  guildId: string,
  robloxUserId?: number,
): Promise<BlacklistNote[]> {
  const current = await load();
  return (current.notes ?? [])
    .filter((note) => note.guildId === guildId && (robloxUserId === undefined || note.robloxUserId === robloxUserId))
    .map((note) => ({ ...note }));
}

export async function listRestorableSnapshots(
  guildId: string,
): Promise<RoleSnapshot[]> {
  const current = await load();
  return current.snapshots
    .filter(
      (snapshot) =>
        snapshot.guildId === guildId &&
        ["pending", "active", "revocation_pending"].includes(snapshot.status),
    )
    .map((snapshot) => ({
      ...snapshot,
      roleIds: [...snapshot.roleIds],
    }));
}

export async function revokeRoleSnapshot(
  key: string,
): Promise<RoleSnapshot | undefined> {
  return mutateFile((current) => {
    const snapshot = current.snapshots.find((item) => item.key === key);
    if (!snapshot) return undefined;
    snapshot.status = "revoked";
    snapshot.revokedAt = new Date().toISOString();
    return cloneSnapshot(snapshot);
  });
}
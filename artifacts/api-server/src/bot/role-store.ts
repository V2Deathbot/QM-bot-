import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

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

let loaded: SnapshotFile | undefined;
let writeQueue = Promise.resolve();
const memberQueues = new Map<string, Promise<void>>();
const guildLifecycleQueues = new Map<string, Promise<void>>();
let temporaryFileSequence = 0;

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
  if (loaded) return loaded;

  try {
    const raw = await readFile(config.snapshotFile, "utf8");
    loaded = JSON.parse(raw) as SnapshotFile;
    loaded.notes ??= [];
    // Snapshots predating source tracking can only have been created by this
    // bot's command flow. Migrate those records explicitly; never promote a
    // known `sync` record to command-approved status.
    for (const snapshot of loaded.snapshots) {
      snapshot.source ??= "command";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    loaded = { snapshots: [], notes: [] };
  }

  return loaded;
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

/**
 * Serialize mutations and only publish the replacement in-memory state after
 * its complete JSON document has been atomically installed. This deliberately
 * avoids modifying `loaded` before a failed disk write.
 */
async function mutateFile<T>(
  mutation: (file: SnapshotFile) => T,
): Promise<T> {
  const operation = writeQueue.catch(() => undefined).then(async () => {
    const next = cloneFile(await load());
    const result = mutation(next);
    const directory = path.dirname(config.snapshotFile);
    const temporaryFile = `${config.snapshotFile}.${process.pid}.${temporaryFileSequence++}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryFile, JSON.stringify(next, null, 2), "utf8");
    await rename(temporaryFile, config.snapshotFile);
    loaded = next;
    return result;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
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

/** Command-approved records which still impose a Discord restriction. */
export async function listActiveRestrictionSnapshots(
  guildId: string,
): Promise<RoleSnapshot[]> {
  const current = await load();
  return current.snapshots
    .filter((snapshot) =>
      snapshot.guildId === guildId &&
      snapshot.source !== "sync" &&
      (snapshot.status === "pending" || snapshot.status === "active" ||
        (snapshot.status === "revocation_pending" && !snapshot.revocationCardMovedAt)),
    )
    .map(cloneSnapshot);
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
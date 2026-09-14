import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  source?: "command" | "sync";
  blacklistNotificationAttemptedAt?: string;
  revocationNotificationAttemptedAt?: string;
  status: "pending" | "active" | "revocation_pending" | "revoked" | "failed";
  createdAt: string;
  revokedAt?: string;
}

interface SnapshotFile {
  snapshots: RoleSnapshot[];
}

let loaded: SnapshotFile | undefined;
let writeQueue = Promise.resolve();

async function load(): Promise<SnapshotFile> {
  if (loaded) return loaded;

  try {
    const raw = await readFile(config.snapshotFile, "utf8");
    loaded = JSON.parse(raw) as SnapshotFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    loaded = { snapshots: [] };
  }

  return loaded;
}

async function persist(): Promise<void> {
  const current = await load();
  const directory = path.dirname(config.snapshotFile);
  await mkdir(directory, { recursive: true });
  const operation = writeQueue.catch(() => undefined).then(() =>
    writeFile(config.snapshotFile, JSON.stringify(current, null, 2), "utf8"),
  );
  writeQueue = operation.catch(() => undefined);
  await operation;
}

export async function saveRoleSnapshot(snapshot: RoleSnapshot): Promise<void> {
  const current = await load();
  const index = current.snapshots.findIndex((item) => item.key === snapshot.key);

  if (index === -1) current.snapshots.push(snapshot);
  else current.snapshots[index] = snapshot;

  await persist();
}

export async function findActiveSnapshot(
  guildId: string,
  robloxUserId: number,
): Promise<RoleSnapshot | undefined> {
  const current = await load();
  return current.snapshots.find(
    (snapshot) =>
      snapshot.guildId === guildId &&
      snapshot.robloxUserId === robloxUserId &&
      snapshot.status === "active",
  );
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
  const current = await load();
  const snapshot = current.snapshots.find((item) => item.key === key);
  if (!snapshot) return undefined;

  snapshot.status = "revoked";
  snapshot.revokedAt = new Date().toISOString();
  await persist();
  return snapshot;
}
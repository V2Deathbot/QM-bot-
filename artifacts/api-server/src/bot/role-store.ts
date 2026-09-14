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
  status: "active" | "revoked";
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
  writeQueue = writeQueue.then(() =>
    writeFile(config.snapshotFile, JSON.stringify(current, null, 2), "utf8"),
  );
  await writeQueue;
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
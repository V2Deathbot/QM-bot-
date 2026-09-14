import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

export interface GuildSetup {
  guildId: string;
  moderatorRoleId: string;
  auditChannelId: string;
  updatedBy: string;
  updatedAt: string;
}

interface GuildSetupFile {
  guilds: GuildSetup[];
}

let mutationQueue: Promise<void> = Promise.resolve();

function isGuildSetup(value: unknown): value is GuildSetup {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["guildId"] === "string" &&
    typeof candidate["moderatorRoleId"] === "string" &&
    typeof candidate["auditChannelId"] === "string" &&
    typeof candidate["updatedBy"] === "string" &&
    typeof candidate["updatedAt"] === "string"
  );
}

async function readStore(): Promise<GuildSetupFile> {
  try {
    const raw = await readFile(config.setupFile, "utf8");
    const parsed = JSON.parse(raw) as { guilds?: unknown };
    if (!Array.isArray(parsed.guilds) || !parsed.guilds.every(isGuildSetup)) {
      throw new Error("The bot setup file has an invalid format.");
    }
    return { guilds: parsed.guilds };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { guilds: [] };
    }
    throw error;
  }
}

async function writeStore(store: GuildSetupFile): Promise<void> {
  const directory = path.dirname(config.setupFile);
  const temporaryFile = `${config.setupFile}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporaryFile, JSON.stringify(store, null, 2), "utf8");
  await rename(temporaryFile, config.setupFile);
}

export async function getGuildSetup(
  guildId: string,
): Promise<GuildSetup | undefined> {
  await mutationQueue;
  const store = await readStore();
  return store.guilds.find((setup) => setup.guildId === guildId);
}

export async function saveGuildSetup(
  setup: GuildSetup,
): Promise<GuildSetup> {
  const operation = mutationQueue.then(async () => {
    const store = await readStore();
    const index = store.guilds.findIndex(
      (candidate) => candidate.guildId === setup.guildId,
    );
    if (index === -1) store.guilds.push(setup);
    else store.guilds[index] = setup;
    await writeStore(store);
  });

  mutationQueue = operation.catch(() => undefined);
  await operation;
  return setup;
}
export type BlacklistType = "appealable" | "conditional" | "permanent";

export const config = {
  discordToken: process.env["DISCORD_BOT_TOKEN"],
  discordGuildId: process.env["DISCORD_GUILD_ID"],
  trelloApiKey: process.env["TRELLO_API_KEY"],
  trelloToken: process.env["TRELLO_TOKEN"],
  trelloBoardId: process.env["TRELLO_BOARD_ID"],
  trelloRetryBaseDelayMs: parseDelay(
    process.env["TRELLO_RETRY_BASE_DELAY_MS"],
    30_000,
  ),
  trelloRetryMaxDelayMs: parseDelay(
    process.env["TRELLO_RETRY_MAX_DELAY_MS"],
    5 * 60_000,
  ),
  trelloSyncIntervalMs: parseBoundedDelay(
    process.env["TRELLO_SYNC_INTERVAL_MS"],
    60_000,
    15_000,
    60 * 60_000,
  ),
  trelloListNames: {
    appealable:
      process.env["TRELLO_LIST_APPEALABLE"] ?? "Appealable Blacklist",
    conditional:
      process.env["TRELLO_LIST_CONDITIONAL"] ?? "Conditional Blacklist",
    permanent:
      process.env["TRELLO_LIST_PERMANENT"] ?? "Permanent Blacklist",
    revoked: process.env["TRELLO_LIST_REVOKED"] ?? "Revoked Blacklist",
    group: process.env["TRELLO_LIST_GROUP"] ?? "Group Blacklist",
  },
  snapshotFile:
    process.env["ROLE_SNAPSHOT_FILE"] ?? "data/role-snapshots.json",
  setupFile:
    process.env["BOT_SETUP_FILE"] ?? "data/guild-settings.json",
} as const;

function parseDelay(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function parseBoundedDelay(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

export function getMissingConfiguration(): string[] {
  const required = [
    ["DISCORD_BOT_TOKEN", config.discordToken],
    ["DISCORD_GUILD_ID", config.discordGuildId],
    ["TRELLO_API_KEY", config.trelloApiKey],
    ["TRELLO_TOKEN", config.trelloToken],
    ["TRELLO_BOARD_ID", config.trelloBoardId],
  ] as const;

  return required.filter(([, value]) => !value).map(([key]) => key);
}

export function getConfigurationStatus() {
  return {
    configured: getMissingConfiguration().length === 0,
    missing: getMissingConfiguration(),
    discordGuildConfigured: Boolean(config.discordGuildId),
    trelloLists: config.trelloListNames,
  };
}
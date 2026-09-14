export type BlacklistType = "appealable" | "conditional" | "permanent";

export const config = {
  discordToken: process.env["DISCORD_BOT_TOKEN"],
  discordGuildId: process.env["DISCORD_GUILD_ID"],
  trelloApiKey: process.env["TRELLO_API_KEY"],
  trelloToken: process.env["TRELLO_TOKEN"],
  trelloBoardId: process.env["TRELLO_BOARD_ID"],
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
} as const;

export function getMissingConfiguration(): string[] {
  const required = [
    ["DISCORD_BOT_TOKEN", config.discordToken],
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
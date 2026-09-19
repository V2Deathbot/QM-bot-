import { config } from "./config";
import { mutateBotDocument, readBotDocument } from "./persistent-store";

export interface GuildSetup {
  guildId: string;
  /**
   * Named uniform leadership roles.  These are deliberately separate from
   * moderatorRoleId: they permit uniform logging only, never bot settings,
   * payouts, or blacklist administration.
   */
  seniorQuartermasterRoleId?: string;
  quartermasterRoleId?: string;
  moderatorRoleId: string;
  auditChannelId: string;
  securityAlertChannelId?: string;
  trelloAlertChannelId?: string;
  blacklistRoleId?: string;
  trello?: TrelloMappings;
  audit?: AuditSettings;
  security?: SecuritySettings;
  monitoring?: TrelloMonitoringSettings;
  identity?: IdentitySettings;
  /** Optional uniform-log destinations. Legacy access fields are retained as inert data. */
  uniforms?: UniformSettings;
  /** Legacy blacklist grants retained as inert data for storage compatibility. */
  blacklistAuthorizedRoleIds?: string[];
  blacklistAuthorizedMemberIds?: string[];
  /** Per-command grants. An absent or empty entry means Administrator/server-owner only. */
  commandPermissions?: Partial<Record<CommandPermissionName, CommandPermissionGrant>>;
  /** Explicit member allowed to run payouts and change security limits. */
  securityOwnerId?: string;
  updatedBy: string;
  updatedAt: string;
}

export const commandPermissionNames = [
  "settings", "payout", "blacklist", "revoke_blacklist", "create", "moderated", "relog",
] as const;
export type CommandPermissionName = typeof commandPermissionNames[number] | "created" | "log";
export interface CommandPermissionGrant {
  roleIds: string[];
  memberIds: string[];
}

export function commandPermissionName(command: string): CommandPermissionName | undefined {
  if (command === "setup" || command === "settings") return "settings";
  if (command === "log") return "log";
  if (command === "created") return "created";
  if ((commandPermissionNames as readonly string[]).includes(command)) {
    return command as CommandPermissionName;
  }
  return undefined;
}

export function commandPermissionFor(
  setup: GuildSetup,
  command: string,
): CommandPermissionGrant {
  const key = commandPermissionName(command);
  const grant = key ? setup.commandPermissions?.[key] : undefined;
  return {
    roleIds: [...new Set((grant?.roleIds ?? []).filter((id) => /^\d{5,25}$/.test(id)))],
    memberIds: [...new Set((grant?.memberIds ?? []).filter((id) => /^\d{5,25}$/.test(id)))],
  };
}

/** Whether a command has an explicit new-model entry (including an intentional empty grant). */
export function hasCommandPermissionEntry(setup: GuildSetup, command: string): boolean {
  const key = commandPermissionName(command);
  return Boolean(key && setup.commandPermissions && Object.prototype.hasOwnProperty.call(setup.commandPermissions, key));
}

export interface SecuritySettings {
  perAdminLimit: number;
  globalLimit: number;
  windowMinutes: number;
  automaticLockdown: boolean;
  automaticLockdownThreshold: number;
  confirmationsRequired: boolean;
  protectedUserIds: string[];
  protectedRoleIds: string[];
  altDetectionEnabled: boolean;
  robloxAltDetectionEnabled: boolean;
  historicalAssociationWarnings: boolean;
  recentPermissionEscalationProtection: boolean;
  securityAuditAlerts: boolean;
}

export interface TrelloMonitoringSettings {
  manualChangeDetection: boolean;
  desyncDetection: boolean;
  pollingIntervalSeconds: number;
}

export interface TrelloMappings {
  /** Board ID selected through the setup panel; credentials remain external. */
  boardId?: string;
  lists: {
    appealable: string;
    conditional: string;
    permanent: string;
    group: string;
    revoked: string;
  };
  labels: {
    blacklisted: string;
    appealable: string;
    conditional: string;
    permanent: string;
    group: string;
    revoked: string;
  };
}

export interface AuditSettings {
  trelloAlerts: boolean;
  blacklistLogs: boolean;
  roleEnforcementLogs: boolean;
  joinLeaveBlacklistLogs: boolean;
}

export interface IdentitySettings {
  sameRobloxDifferentDiscord: boolean;
  sameDiscordDifferentRoblox: boolean;
  historicalAssociationWarnings: boolean;
  /** Deliberately fixed off: identity associations are warnings, never punishment. */
  autoPunishPossibleAlts: false;
}

export interface UniformSettings {
  /** Legacy channel used by /log before the two-stage /create workflow. */
  logChannelId?: string;
  /** Channel where Senior Quartermasters review and upload created PNGs. */
  seqmReviewChannelId?: string;
  /** Branch-specific Senior Quartermaster review channels. */
  armySeqmChannelId?: string;
  marinesSeqmChannelId?: string;
  navySeqmChannelId?: string;
  veteranSeqmChannelId?: string;
  /** Channel where publishers receive approved Classic Shirts. */
  publisherChannelId?: string;
  /** Channel used by /moderated. Undefined means that command is not configured. */
  moderatedChannelId?: string;
  /** Additional submitters allowed to use either uniform command. */
  authorizedRoleIds: string[];
  authorizedMemberIds: string[];
  /** Optional Google Sheets destination for the detailed uniform rows. */
  spreadsheet?: UniformSpreadsheetSettings;
}

export interface UniformSpreadsheetSettings {
  /** Canonical Google Sheets ID; credentials remain in the Replit connector. */
  spreadsheetId: string;
  logTab: string;
  moderatedTab: string;
  /** Data-only destination for /log. Defaults to A2:E for legacy settings. */
  logRange?: string;
  /** Data-only destination for /moderated. Defaults to A2:D for legacy settings. */
  moderatedRange?: string;
  /** Obsolete; configurations which still enable this fail clearly on use. */
  createMissingTabs?: boolean;
}

export const defaultUniformSettings = (): UniformSettings => ({
  authorizedRoleIds: [],
  authorizedMemberIds: [],
});

export function uniformSettingsFor(setup: GuildSetup): UniformSettings {
  const spreadsheet = setup.uniforms?.spreadsheet
    ? {
        ...setup.uniforms.spreadsheet,
        logTab: setup.uniforms.spreadsheet.logTab || "Uniform Logs",
        moderatedTab: setup.uniforms.spreadsheet.moderatedTab || "Moderated Logs",
        logRange: setup.uniforms.spreadsheet.logRange || "A2:E",
        moderatedRange: setup.uniforms.spreadsheet.moderatedRange || "A2:D",
      }
    : undefined;
  return {
    ...defaultUniformSettings(),
    ...setup.uniforms,
    authorizedRoleIds: [...(setup.uniforms?.authorizedRoleIds ?? [])],
    authorizedMemberIds: [...(setup.uniforms?.authorizedMemberIds ?? [])],
    ...(spreadsheet ? { spreadsheet } : {}),
  };
}

/** Blacklist submitter grants are deliberately separate from all other roles. */
export function blacklistAccessFor(setup: GuildSetup): {
  authorizedRoleIds: string[];
  authorizedMemberIds: string[];
} {
  const valid = (id: string): boolean => /^\d{5,25}$/.test(id);
  return {
    authorizedRoleIds: [...new Set((setup.blacklistAuthorizedRoleIds ?? []).filter(valid))],
    authorizedMemberIds: [...new Set((setup.blacklistAuthorizedMemberIds ?? []).filter(valid))],
  };
}

/** Roles which receive the narrowly-scoped uniform submitter permission. */
export function quartermasterUniformRoleIds(setup: GuildSetup): string[] {
  return [...new Set([
    setup.seniorQuartermasterRoleId,
    setup.quartermasterRoleId,
  ].filter((id): id is string => Boolean(id)))];
}

export const defaultSecuritySettings = (): SecuritySettings => ({
  perAdminLimit: 3,
  globalLimit: 8,
  windowMinutes: 5,
  automaticLockdown: true,
  automaticLockdownThreshold: 8,
  confirmationsRequired: true,
  protectedUserIds: [],
  protectedRoleIds: [],
  altDetectionEnabled: true,
  robloxAltDetectionEnabled: true,
  historicalAssociationWarnings: true,
  recentPermissionEscalationProtection: true,
  securityAuditAlerts: true,
});

export const defaultMonitoringSettings = (): TrelloMonitoringSettings => ({
  manualChangeDetection: true,
  desyncDetection: true,
  pollingIntervalSeconds: 60,
});

export const defaultTrelloMappings = (): TrelloMappings => ({
  boardId: config.trelloBoardId,
  lists: { ...config.trelloListNames },
  labels: {
    blacklisted: "blacklisted",
    appealable: "appealable",
    conditional: "conditional",
    permanent: "permanent",
    group: "group blacklist",
    revoked: "revoked",
  },
});

export const defaultAuditSettings = (): AuditSettings => ({
  trelloAlerts: true,
  blacklistLogs: true,
  roleEnforcementLogs: true,
  joinLeaveBlacklistLogs: true,
});

export const defaultIdentitySettings = (): IdentitySettings => ({
  sameRobloxDifferentDiscord: true,
  sameDiscordDifferentRoblox: true,
  historicalAssociationWarnings: true,
  autoPunishPossibleAlts: false,
});

export function securitySettingsFor(setup: GuildSetup): SecuritySettings {
  return { ...defaultSecuritySettings(), ...setup.security,
    protectedUserIds: [...(setup.security?.protectedUserIds ?? [])],
    protectedRoleIds: [...(setup.security?.protectedRoleIds ?? [])] };
}

export function trelloMappingsFor(setup: GuildSetup): TrelloMappings {
  const defaults = defaultTrelloMappings();
  return {
    boardId: setup.trello?.boardId || defaults.boardId,
    lists: { ...defaults.lists, ...setup.trello?.lists },
    labels: { ...defaults.labels, ...setup.trello?.labels },
  };
}

export function auditSettingsFor(setup: GuildSetup): AuditSettings {
  return { ...defaultAuditSettings(), ...setup.audit };
}

interface GuildSetupFile {
  guilds: GuildSetup[];
}

function isGuildSetup(value: unknown): value is GuildSetup {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const validOptionalIds = (ids: unknown): boolean =>
    ids === undefined ||
    (Array.isArray(ids) && ids.every((id) => typeof id === "string" && /^\d{5,25}$/.test(id)));
  const permissions = candidate["commandPermissions"];
  const validCommandPermissions = permissions === undefined || Boolean(
    permissions && typeof permissions === "object" &&
    Object.entries(permissions).every(([name, value]) =>
      ((commandPermissionNames as readonly string[]).includes(name) || name === "log") &&
      Boolean(value) && typeof value === "object" &&
      validOptionalIds((value as Record<string, unknown>)["roleIds"]) &&
      validOptionalIds((value as Record<string, unknown>)["memberIds"]),
    )
  );
  return (
    typeof candidate["guildId"] === "string" &&
    typeof candidate["moderatorRoleId"] === "string" &&
    typeof candidate["auditChannelId"] === "string" &&
    validOptionalIds(candidate["blacklistAuthorizedRoleIds"]) &&
    validOptionalIds(candidate["blacklistAuthorizedMemberIds"]) &&
    validCommandPermissions &&
    typeof candidate["updatedBy"] === "string" &&
    typeof candidate["updatedAt"] === "string"
  );
}

const storeOptions = {
  name: "guild-settings",
  get filePath() { return config.setupFile; },
  empty: (): GuildSetupFile => ({ guilds: [] }),
  validate(value: unknown): GuildSetupFile {
    const parsed = value as { guilds?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.guilds) ||
        !parsed.guilds.every(isGuildSetup)) {
      throw new Error("The persistent guild settings document has an invalid format.");
    }
    return { guilds: parsed.guilds };
  },
};

export function validateGuildSettingsDocument(value: unknown): void {
  storeOptions.validate(value);
}

async function readStore(): Promise<GuildSetupFile> {
  return readBotDocument(storeOptions);
}

function migrateObsoletePresence(store: GuildSetupFile): boolean {
  let migrated = false;
  store.guilds = store.guilds.map((setup) => {
    if (!Object.prototype.hasOwnProperty.call(setup, "presence")) return setup;
    // Presence was removed from the application. Remove only that obsolete
    // field, preserving every other persisted setting.
    const withoutPresence = { ...setup } as GuildSetup & { presence?: unknown };
    delete withoutPresence.presence;
    migrated = true;
    return withoutPresence;
  });
  return migrated;
}

export async function getGuildSetup(
  guildId: string,
): Promise<GuildSetup | undefined> {
  const store = await readStore();
  if (!migrateObsoletePresence(store)) {
    return store.guilds.find((setup) => setup.guildId === guildId);
  }
  return mutateBotDocument(storeOptions, (current) => {
    migrateObsoletePresence(current);
    return current.guilds.find((setup) => setup.guildId === guildId);
  });
}

export async function saveGuildSetup(
  setup: GuildSetup,
): Promise<GuildSetup> {
  return mutateBotDocument(storeOptions, (store) => {
    migrateObsoletePresence(store);
    const index = store.guilds.findIndex(
      (candidate) => candidate.guildId === setup.guildId,
    );
    if (index === -1) store.guilds.push(setup);
    else store.guilds[index] = setup;
    return setup;
  });
}

/**
 * Apply a setup mutation while holding the same serialized store queue used by
 * saveGuildSetup. The updater reads the latest persisted record inside the
 * queue, so a slow provider-backed settings flow cannot overwrite unrelated
 * changes made while it was waiting.
 */
export async function updateGuildSetup(
  guildId: string,
  updater: (current: GuildSetup | undefined) => GuildSetup | Promise<GuildSetup>,
): Promise<GuildSetup> {
  return mutateBotDocument(storeOptions, async (store) => {
    migrateObsoletePresence(store);
    const index = store.guilds.findIndex((candidate) => candidate.guildId === guildId);
    const current = index === -1 ? undefined : store.guilds[index];
    const updated = await updater(current);
    if (updated.guildId !== guildId) {
      throw new Error("The guild setup mutation returned the wrong guild.");
    }
    if (index === -1) store.guilds.push(updated);
    else store.guilds[index] = updated;
    return updated;
  });
}
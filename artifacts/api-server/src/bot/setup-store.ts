import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

export interface GuildSetup {
  guildId: string;
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
  /** Optional uniform-log destinations and non-administrator submitter access. */
  uniforms?: UniformSettings;
  updatedBy: string;
  updatedAt: string;
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
  /** Channel used by /log. Undefined means that command is not configured. */
  logChannelId?: string;
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
  /** Missing tabs are created only when explicitly enabled by an administrator. */
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
  const operation = mutationQueue.then(async () => {
    const store = await readStore();
    const migrated = migrateObsoletePresence(store);
    if (migrated) await writeStore(store);
    const index = store.guilds.findIndex((setup) => setup.guildId === guildId);
    return store.guilds[index];
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function saveGuildSetup(
  setup: GuildSetup,
): Promise<GuildSetup> {
  const operation = mutationQueue.then(async () => {
    const store = await readStore();
    migrateObsoletePresence(store);
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
  const operation = mutationQueue.then(async () => {
    const store = await readStore();
    migrateObsoletePresence(store);
    const index = store.guilds.findIndex((candidate) => candidate.guildId === guildId);
    const current = index === -1 ? undefined : store.guilds[index];
    const updated = await updater(current);
    if (updated.guildId !== guildId) {
      throw new Error("The guild setup mutation returned the wrong guild.");
    }
    if (index === -1) store.guilds.push(updated);
    else store.guilds[index] = updated;
    await writeStore(store);
    return updated;
  });

  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}
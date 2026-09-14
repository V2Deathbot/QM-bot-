import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { DEFAULT_PRESENCE_SETTINGS } from "./presence";

export interface GuildSetup {
  guildId: string;
  moderatorRoleId: string;
  auditChannelId: string;
  securityAlertChannelId?: string;
  trelloAlertChannelId?: string;
  blacklistRoleId?: string;
  trello?: TrelloMappings;
  audit?: AuditSettings;
  presence?: PresenceSettings;
  security?: SecuritySettings;
  monitoring?: TrelloMonitoringSettings;
  identity?: IdentitySettings;
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

export interface PresenceSettings {
  /** Schema marker used to migrate the original five-template default safely. */
  presenceConfigVersion?: 2;
  enabled: boolean;
  activities: string[];
  rotationEnabled: boolean;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  /** Activities disabled individually in the settings UI. */
  disabledActivities?: string[];
  /** False disables templates which require live values. */
  dynamicActivitiesEnabled?: boolean;
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

export const defaultPresenceSettings = (): PresenceSettings => ({
  presenceConfigVersion: 2,
  ...DEFAULT_PRESENCE_SETTINGS,
  activities: [...DEFAULT_PRESENCE_SETTINGS.activities],
  disabledActivities: [...(DEFAULT_PRESENCE_SETTINGS.disabledActivities ?? [])],
});

export function securitySettingsFor(setup: GuildSetup): SecuritySettings {
  return { ...defaultSecuritySettings(), ...setup.security,
    protectedUserIds: [...(setup.security?.protectedUserIds ?? [])],
    protectedRoleIds: [...(setup.security?.protectedRoleIds ?? [])] };
}

export function presenceSettingsFor(setup: GuildSetup): PresenceSettings {
  const defaults = defaultPresenceSettings();
  const persisted = setup.presence;
  const legacyDefaults = new Set([
    "Customers",
    "Quartermaster Corps",
    "Blacklist Records",
    "Supply Operations",
    "Active Blacklists",
  ]);
  // Only the original default marker identifies the five-template schema.
  // A bespoke older activity list is left untouched; a legacy default gains
  // the new templates while preserving every administrator-added activity.
  const needsLegacyMigration = persisted?.presenceConfigVersion !== 2 &&
    persisted?.activities.includes("Active Blacklists") === true;
  const legacyDynamic = "{ACTIVE_BLACKLISTS} Active Blacklists";
  const migratedActivities = needsLegacyMigration
    ? [
        ...defaults.activities,
        ...persisted!.activities.filter((activity) => !legacyDefaults.has(activity)),
      ]
    : persisted?.activities ?? defaults.activities;
  const migratedDisabled = (persisted?.disabledActivities ?? defaults.disabledActivities ?? [])
    .map((activity) => activity === "Active Blacklists" && needsLegacyMigration ? legacyDynamic : activity)
    .filter((activity, index, values) => migratedActivities.includes(activity) && values.indexOf(activity) === index);
  return {
    ...defaults,
    ...persisted,
    presenceConfigVersion: 2,
    activities: [...migratedActivities],
    disabledActivities: [...migratedDisabled],
    // Older settings allowed a one-minute interval. Preserve the rest of a
    // persisted custom configuration while safely migrating that value.
    minIntervalMinutes: Math.max(2, persisted?.minIntervalMinutes ?? defaults.minIntervalMinutes),
    maxIntervalMinutes: Math.max(
      Math.max(2, persisted?.minIntervalMinutes ?? defaults.minIntervalMinutes),
      persisted?.maxIntervalMinutes ?? defaults.maxIntervalMinutes,
    ),
  };
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

export async function getGuildSetup(
  guildId: string,
): Promise<GuildSetup | undefined> {
  const operation = mutationQueue.then(async () => {
    const store = await readStore();
    const index = store.guilds.findIndex((setup) => setup.guildId === guildId);
    const setup = store.guilds[index];
    if (!setup?.presence || setup.presence.presenceConfigVersion === 2) return setup;
    const migratedPresence = presenceSettingsFor(setup);
    // Persist only an identified legacy schema migration. Bespoke unversioned
    // configurations receive a version marker without replacing activities.
    store.guilds[index] = { ...setup, presence: migratedPresence };
    await writeStore(store);
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
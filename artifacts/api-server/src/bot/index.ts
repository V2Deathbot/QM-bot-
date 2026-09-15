import {
  Client,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { logger } from "../lib/logger";
import { config, getMissingConfiguration, type BlacklistType } from "./config";
import {
  checkTrelloReadiness,
  createBlacklistCard,
  createGroupBlacklistCard,
  findBlacklistCardsByRobloxId,
  findBlacklistCardByRobloxId,
  getTrelloReadiness,
  requireTrelloReadiness,
  reactivateBlacklistCardById,
  revokeBlacklistCardById,
  validateTrelloMappings,
  type TrelloReadiness,
} from "./trello";
import {
  findPendingOrActiveSnapshot,
  saveRoleSnapshot,
  saveBlacklistNote,
  withGuildBlacklistLifecycleLock,
  withMemberRoleLock,
} from "./role-store";
import {
  describeRoles,
  getRemovableRoleIds,
  removeAssignableRoles,
} from "./role-actions";
import { findRobloxUser, getRobloxGroupUrl } from "./roblox";
import {
  requireAuditChannel,
  sendAuditEvent,
  validateGuildSetup,
  validateModeratorRole,
  type AuditEvent,
} from "./audit";
import {
  getGuildSetup,
  defaultIdentitySettings,
  defaultAuditSettings,
  defaultMonitoringSettings,
  defaultSecuritySettings,
  defaultTrelloMappings,
  saveGuildSetup,
  securitySettingsFor,
  auditSettingsFor,
  trelloMappingsFor,
  type GuildSetup,
} from "./setup-store";
import {
  getSecurityState,
  mutateSecurityState,
  recordIdentityAssociation,
  type SecurityState,
} from "./security-store";
import { fetchGuildMembers } from "./guild-members";
import {
  enforceBlacklistForJoinedMember,
  getBlacklistSyncStatus,
  processApprovedRevocation,
  setNextBlacklistSyncAt,
  synchronizeBlacklists,
  type BlacklistSyncTrigger,
} from "./blacklist-sync";
import {
  displayId,
  embedOnlyResponse,
  noMentions,
  presentationEmbed,
  readableDate,
  safePresentationText,
  titleCaseHeading,
} from "./presentation";

const settingsCommand = new SlashCommandBuilder()
  .setName("settings")
  .setDescription("Quartermaster administration, setup, security, and records.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const moderationCommands = [
  new SlashCommandBuilder()
    .setName("blacklist")
    .setDescription("Blacklist a Roblox user and remove their server roles.")
    .addStringOption((option) =>
      option
        .setName("user")
        .setDescription("The Roblox username, not the display name.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("type")
        .setDescription("The blacklist category.")
        .setRequired(true)
        .addChoices(
          { name: "Appealable", value: "appealable" },
          { name: "Conditional", value: "conditional" },
          { name: "Permanent", value: "permanent" },
        ),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why the Roblox user is being blacklisted.")
        .setRequired(true),
    )
    .addUserOption((option) =>
      option
        .setName("discord_user")
        .setDescription("Optional: ping the matching Discord member directly."),
    ),
  new SlashCommandBuilder()
    .setName("revoke_blacklist")
    .setDescription("Move a user blacklist card to revoked and restore roles.")
    .addStringOption((option) =>
      option
        .setName("username")
        .setDescription("The exact Roblox username.")
        .setRequired(true),
    )
    .addUserOption((option) =>
      option
        .setName("discord_user")
        .setDescription("Optional: ping the Discord member directly."),
    ),
  new SlashCommandBuilder()
    .setName("blacklist_lookup")
    .setDescription("Look up an active or revoked blacklist record.")
    .addStringOption((option) => option.setName("username").setDescription("Roblox username").setRequired(true)),
];

// These recovery controls must remain reachable before first-time setup. In
// particular, maintenance must never make a partially configured guild stuck.
const setupOnlyCommands = [settingsCommand].map((command) => command.toJSON());
const enabledCommands = [settingsCommand, ...moderationCommands].map((command) =>
  command.toJSON(),
);

export type BotRecoveryStatus = "pending" | "successful" | "blocked";
export type BotRetryOutcome = "pending" | "successful" | "blocked";

interface BotRecoveryState {
  status: BotRecoveryStatus;
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  error: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  lastRetryAt: string | null;
  lastRetryOutcome: BotRetryOutcome | null;
}

const recovery: BotRecoveryState = {
  status: "pending",
  lastAttemptAt: null,
  lastSuccessfulAt: null,
  error: null,
  retryCount: 0,
  nextRetryAt: null,
  lastRetryAt: null,
  lastRetryOutcome: null,
};

let discordClient: Client | null = null;
let commandsRegistered = false;
let setupCommandRegistered = false;
let guildSetupComplete = false;
let recoveryAttempt: Promise<BotRefreshResult> | null = null;
let trelloRetryTimer: ReturnType<typeof setTimeout> | null = null;
let blacklistSyncTimer: ReturnType<typeof setTimeout> | null = null;
let shutdownHooksInstalled = false;
type SettingsCategory = "moderation" | "integrations" | "security" | "logs" | "system";

type SettingsLocation =
  | { kind: "root" }
  | { kind: "category"; category: SettingsCategory }
  | { kind: "page"; id: string; parent: SettingsLocation };

interface SetupSession {
  userId: string;
  guildId: string;
  expiresAt: number;
  nonce: string;
  /** The one ephemeral setup message this session is authorized to operate. */
  messageId?: string;
  /** `/settings` controls always carry the session nonce in their custom ID. */
  nonceRequired?: boolean;
  /** `/settings` keeps a small, explicit navigation stack for safe Back controls. */
  navigation?: SettingsLocation[];
}
const setupSessions = new Map<string, SetupSession>();
const confirmations = new Map<string, {
  userId: string;
  guildId: string;
  command: "blacklist" | "group_blacklist" | "revoke_blacklist" | "security_unlock";
  original: ChatInputCommandInteraction;
  target?: { discordUserId: string; robloxUserId: number; robloxUsername: string; cardId?: string };
  expiresAt: number;
}>();
const maintenanceConfirmations = new Map<string, {
  userId: string;
  guildId: string;
  active: boolean;
  revision: number;
  reason: string;
  expiresAt: number;
  original: ChatInputCommandInteraction | ModalSubmitInteraction;
}>();

const destructiveCommands = new Set(["blacklist", "group_blacklist", "revoke_blacklist"]);
const setupSessionLifetimeMs = 10 * 60_000;
const permissionEscalationWindowMs = 10 * 60_000;

const maintenanceMessage =
  "Bot under maintenance. Normal commands are temporarily unavailable; background blacklist protection continues.";
// Legacy command names are retained only as internal compatibility adapters;
// command registration exposes `/settings` alone for these operations.
const maintenanceAllowedCommands = new Set([
  "settings", "maintenance", "security_status", "security_lockdown", "security_unlock",
]);

async function maintenanceActive(guildId: string): Promise<boolean> {
  return (await getSecurityState(guildId)).maintenance.active;
}

function invalidateGuildInteractiveState(guildId: string): void {
  for (const [id, session] of setupSessions) {
    if (session.guildId === guildId) setupSessions.delete(id);
  }
  for (const [id, pending] of confirmations) {
    if (pending.guildId === guildId) confirmations.delete(id);
  }
  for (const [id, pending] of maintenanceConfirmations) {
    if (pending.guildId === guildId) maintenanceConfirmations.delete(id);
  }
}

function clearBlacklistSyncTimer(): void {
  if (blacklistSyncTimer) {
    clearTimeout(blacklistSyncTimer);
    blacklistSyncTimer = null;
  }
  setNextBlacklistSyncAt(null);
}

function syncIntervalMs(setup?: GuildSetup): number {
  const seconds = setup?.monitoring?.pollingIntervalSeconds;
  return seconds && Number.isInteger(seconds) && seconds >= 15 && seconds <= 3600
    ? seconds * 1000
    : config.trelloSyncIntervalMs;
}

function scheduleBlacklistSync(guild: Guild, setup?: GuildSetup): void {
  clearBlacklistSyncTimer();
  const intervalMs = syncIntervalMs(setup);
  const nextSyncAt = new Date(
    Date.now() + intervalMs,
  ).toISOString();
  setNextBlacklistSyncAt(nextSyncAt);
  blacklistSyncTimer = setTimeout(() => {
    blacklistSyncTimer = null;
    setNextBlacklistSyncAt(null);
    void runGuildBlacklistSync(guild, "poll").finally(() => {
      if (discordClient?.isReady() && guildSetupComplete) {
        void getGuildSetup(guild.id).then((current) =>
          scheduleBlacklistSync(guild, current),
        );
      }
    });
  }, intervalMs);
  blacklistSyncTimer.unref?.();
}

async function runGuildBlacklistSync(
  guild: Guild,
  trigger: BlacklistSyncTrigger,
): Promise<void> {
  const setup = await getGuildSetup(guild.id);
  if (!setup) {
    clearBlacklistSyncTimer();
    return;
  }

  await synchronizeBlacklists(guild, setup, trigger);
  if (trigger !== "poll") scheduleBlacklistSync(guild, setup);
}

function clearTrelloRetry(): void {
  if (trelloRetryTimer) {
    clearTimeout(trelloRetryTimer);
    trelloRetryTimer = null;
  }
  recovery.nextRetryAt = null;
}

function resetTrelloRetry(): void {
  clearTrelloRetry();
  recovery.retryCount = 0;
}

function scheduleTrelloRetry(): void {
  if (trelloRetryTimer) return;

  const delay = Math.min(
    config.trelloRetryBaseDelayMs * 2 ** recovery.retryCount,
    config.trelloRetryMaxDelayMs,
  );
  recovery.retryCount += 1;
  recovery.nextRetryAt = new Date(Date.now() + delay).toISOString();

  trelloRetryTimer = setTimeout(() => {
    trelloRetryTimer = null;
    recovery.nextRetryAt = null;
    void refreshBot("automatic").catch((error) => {
      logger.error({ err: error }, "Automatic bot recovery retry failed");
    });
  }, delay);
  trelloRetryTimer.unref?.();
}

function keyFor(guildId: string, robloxUserId: number): string {
  return `${guildId}:${robloxUserId}`;
}

async function auditBestEffort(
  guild: Guild,
  setup: GuildSetup,
  event: AuditEvent,
): Promise<void> {
  try {
    await sendAuditEvent(guild, setup, event);
  } catch {
    logger.warn(
      { guildId: guild.id, action: event.action },
      "Could not send moderation audit event",
    );
  }
}

async function interactionMember(
  interaction: ChatInputCommandInteraction,
): Promise<GuildMember> {
  return interaction.guild!.members.fetch({ user: interaction.user.id, force: true });
}

export async function canUseModerationCommands(
  interaction: ChatInputCommandInteraction,
  _setup: GuildSetup,
): Promise<boolean> {
  const guild = interaction.guild!;
  const member = await interactionMember(interaction);
  if (guild.ownerId === member.id) return true;
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

async function currentAdministrator(guild: Guild, userId: string): Promise<boolean> {
  const member = await guild.members.fetch({ user: userId, force: true });
  return guild.ownerId === member.id ||
    member.permissions.has(PermissionFlagsBits.Administrator);
}

async function requireCurrentAdministrator(
  guild: Guild,
  userId: string,
  setup?: GuildSetup,
  command?: string,
): Promise<void> {
  if (await currentAdministrator(guild, userId)) return;
  if (setup) {
    await auditBestEffort(guild, setup, {
      action: "Unauthorized administrative command denied",
      status: "failed",
      actorId: userId,
      fields: command ? [{ name: "Command", value: command }] : [],
    });
  }
  throw new Error("Only a current Discord Administrator or the server owner may use this command.");
}

function cleanText(value: string, label: string, maximum = 500): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maximum || /[\u0000-\u001f\u007f]/.test(cleaned)) {
    throw new Error(`${label} must contain 1–${maximum} printable characters.`);
  }
  return cleaned;
}

async function reserveDestructiveAction(
  guild: Guild,
  actorId: string,
  setup: GuildSetup,
  action: "blacklist" | "group_blacklist" | "revoke_blacklist",
): Promise<{ lockdownActivated: boolean; denial?: string }> {
  const settings = securitySettingsFor(setup);
  const result = await mutateSecurityState(guild.id, (state) => {
    const now = Date.now();
    const since = now - settings.windowMinutes * 60_000;
    state.destructiveActions = state.destructiveActions.filter(
      (entry) => Date.parse(entry.at) >= since,
    );
    if (state.maintenance.active) {
      throw new Error("Bot maintenance mode is active. Commands are temporarily unavailable.");
    }
    if (state.lockdown.active) {
      throw new Error(`Security lockdown is active: ${state.lockdown.reason || "no reason provided"}.`);
    }
    const escalationAt = state.observedAdministrators[actorId];
    if (
      settings.recentPermissionEscalationProtection &&
      escalationAt &&
      now - Date.parse(escalationAt) < permissionEscalationWindowMs
    ) {
      throw new Error("This administrator permission was granted recently. Destructive commands are delayed for 10 minutes.");
    }
    const own = state.destructiveActions.filter((entry) => entry.actorId === actorId).length;
    if (own >= settings.perAdminLimit) {
      throw new Error(`Blacklist rate limit reached: ${own}/${settings.perAdminLimit} actions in ${settings.windowMinutes} minutes.`);
    }
    if (state.destructiveActions.length >= settings.globalLimit) {
      if (settings.automaticLockdown) {
        state.lockdown = {
          active: true, automatic: true, reason: "Global blacklist rate limit reached",
          startedAt: new Date().toISOString(), startedBy: null,
        };
      }
      return {
        lockdownActivated: false,
        denial: `Global blacklist rate limit reached: ${settings.globalLimit} actions in ${settings.windowMinutes} minutes.`,
      };
    }
    state.destructiveActions.push({ actorId, action, at: new Date().toISOString() });
    const lockdownActivated = settings.automaticLockdown &&
      state.destructiveActions.length >= settings.automaticLockdownThreshold;
    if (lockdownActivated) {
      state.lockdown = {
        active: true, automatic: true, reason: "Automatic lockdown threshold reached",
        startedAt: new Date().toISOString(), startedBy: null,
      };
    }
    return { lockdownActivated };
  });
  if (result.denial) {
    await auditBestEffort(guild, setup, {
      action: "Global blacklist rate limit denied",
      status: "failed",
      actorId,
      fields: [{ name: "Result", value: result.denial }],
    });
    throw new Error(result.denial);
  }
  if (result.lockdownActivated) {
    await auditBestEffort(guild, setup, {
      action: "HIGH PRIORITY: automatic security lockdown enabled",
      status: "failed", actorId,
      fields: [{ name: "Reason", value: "Configured destructive-action threshold was reached." }],
    });
  }
  return result;
}

async function protectTarget(
  guild: Guild,
  member: GuildMember,
  setup: GuildSetup,
): Promise<void> {
  const settings = securitySettingsFor(setup);
  const protectedTarget = member.id === guild.ownerId ||
    member.id === guild.members.me?.id ||
    settings.protectedUserIds.includes(member.id) ||
    member.roles.cache.some((role) => settings.protectedRoleIds.includes(role.id));
  if (!protectedTarget) return;
  await auditBestEffort(guild, setup, {
    action: "Protected blacklist target denied", status: "failed", actorId: guild.client.user?.id ?? setup.updatedBy,
    target: `<@${member.id}> (${member.id})`,
  });
  throw new Error("This target is protected by server security settings.");
}

async function validateBlacklistRoleForAction(
  guild: Guild,
  setup: GuildSetup,
): Promise<void> {
  if (!setup.blacklistRoleId) return;
  const role = await guild.roles.fetch(setup.blacklistRoleId);
  const botMember = guild.members.me;
  if (!role || role.managed || !botMember || role.position >= botMember.roles.highest.position) {
    throw new Error("The configured blacklisted role is missing or not assignable by the bot.");
  }
}

async function resolveMember(
  interaction: ChatInputCommandInteraction,
  robloxUsername: string,
): Promise<GuildMember> {
  const directUser = interaction.options.getUser("discord_user");
  if (directUser) return interaction.guild!.members.fetch(directUser.id);

  const members = await fetchGuildMembers(interaction.guild!);
  const normalized = robloxUsername.trim().toLowerCase();
  const matches = members.filter((member) =>
    [member.user.username, member.user.globalName, member.nickname]
      .filter(Boolean)
      .some((value) => value!.trim().toLowerCase() === normalized),
  );

  if (matches.size === 0) {
    throw new Error(
      `I could not match Roblox username "${robloxUsername}" to a Discord member. Use the optional discord_user field to ping them directly.`,
    );
  }
  if (matches.size > 1) {
    throw new Error(
      `More than one Discord member matches "${robloxUsername}". Use the optional discord_user field to ping the correct member.`,
    );
  }

  return matches.first()!;
}

function setupSessionId(guildId: string, userId: string): string {
  return `setup:${guildId}:${userId}`;
}

function sealSettingsComponents(payload: unknown, nonce: string): unknown {
  const seal = (component: unknown) => {
    const candidate = component as {
      data?: { custom_id?: string };
      components?: unknown[];
      setCustomId?: (id: string) => unknown;
    };
    const id = candidate.data?.custom_id;
    if (id && !id.endsWith(`:${nonce}`) && typeof candidate.setCustomId === "function") {
      candidate.setCustomId(`${id}:${nonce}`);
    }
    for (const nested of candidate.components ?? []) seal(nested);
  };
  seal(payload);
  return payload;
}

function scopedSetupModalId(guildId: string, userId: string, id: string): string {
  const session = setupSessions.get(setupSessionId(guildId, userId));
  if (!session) throw new Error("This settings session has expired. Run /settings again.");
  return `${id}:${session.nonce}`;
}

function botAvatarUrl(): string | undefined {
  const user = discordClient?.user;
  return typeof user?.displayAvatarURL === "function"
    ? user.displayAvatarURL()
    : undefined;
}

function brandedEmbed(title: string, description: string): EmbedBuilder {
  const avatar = botAvatarUrl();
  return presentationEmbed(title, description, "info", avatar);
}

function outcomeEmbed(
  title: string,
  description: string,
  tone: "info" | "success" | "warning" | "error" = "info",
  fields?: Array<{ name: string; value: string; inline?: boolean }>,
): EmbedBuilder {
  return presentationEmbed(title, description, tone, botAvatarUrl(), fields);
}

function responseWithEmbed(
  content: string,
  title: string,
  tone: "info" | "success" | "warning" | "error",
  description = content,
  fields?: Array<{ name: string; value: string; inline?: boolean }>,
) {
  // Embeds carry the readable result. Clearing content is important when
  // this payload edits a deferred response; repeating the same sentence in
  // both surfaces makes command output noisy.
  return embedOnlyResponse(outcomeEmbed(title, description, tone, fields));
}

function errorResponse(message: string, title = "Command Error") {
  return responseWithEmbed(message, title, "error");
}

const settingsCategories: Array<{
  id: SettingsCategory;
  label: string;
  description: string;
}> = [
  { id: "moderation", label: "Moderation", description: "Blacklist rules, records, and identity lookup" },
  { id: "integrations", label: "Integrations", description: "Trello configuration and monitoring" },
  { id: "security", label: "Security", description: "Lockdown, access safeguards, and identity detection" },
  { id: "logs", label: "Logs & Server", description: "Audit destinations and Discord policy" },
  { id: "system", label: "System", description: "Status, maintenance, bot state, and configuration" },
];

type SettingsOption = {
  label: string;
  value: string;
  description: string;
};

function settingsRootCategories(configured: boolean, maintenance: boolean): typeof settingsCategories {
  // A maintenance page must not reveal ordinary configuration controls. Before
  // setup the same small emergency surface remains available so a broken or
  // partially configured guild can still recover.
  if (maintenance || !configured) {
    return settingsCategories.filter((category) =>
      category.id === "system" || category.id === "security");
  }
  return settingsCategories;
}

function settingsCategoryOptions(
  category: SettingsCategory,
  configured: boolean,
  maintenance: boolean,
): SettingsOption[] {
  if (maintenance) {
    if (category === "system") {
      return [
        { label: "System Status", value: "settings-action:status", description: "View current emergency and command status" },
        { label: "Disable Maintenance", value: "settings-action:maintenance-disable", description: "Restore normal administration" },
      ];
    }
    if (category === "security") {
      return [
        { label: "Security Lockdown", value: "settings-action:lockdown", description: "Immediately stop destructive actions" },
        { label: "Security Unlock", value: "settings-action:unlock", description: "Unlock after confirmation" },
      ];
    }
    return [];
  }

  if (!configured) {
    if (category === "system") {
      return [
        { label: "Complete First-time Setup", value: "settings-action:initial-audit", description: "Verify an audit channel before enabling commands" },
        { label: "System Status", value: "settings-action:status", description: "View setup and command registration status" },
        { label: "Enable Maintenance", value: "settings-action:maintenance-enable", description: "Temporarily lock normal administration" },
        { label: "Disable Maintenance", value: "settings-action:maintenance-disable", description: "Restore normal administration" },
      ];
    }
    if (category === "security") {
      return [
        { label: "Security Lockdown", value: "settings-action:lockdown", description: "Immediately stop destructive actions" },
        { label: "Security Unlock", value: "settings-action:unlock", description: "Unlock after confirmation" },
      ];
    }
    return [];
  }

  switch (category) {
    case "moderation":
      return [
        { label: "Blacklist Rules", value: "setup:blacklist", description: "Discord role and Trello list mappings" },
        { label: "Blacklist a Group", value: "settings-action:group", description: "Create a group blacklist record" },
        { label: "Add Blacklist Note", value: "settings-action:note", description: "Record a durable moderation note" },
        { label: "Identity Lookup", value: "settings-action:identity-lookup", description: "Search recorded associations" },
      ];
    case "integrations":
      return [
        { label: "Trello Configuration", value: "setup:trello", description: "Monitoring and polling configuration" },
        { label: "Sync Monitoring Report", value: "settings-action:sync", description: "Run a monitoring-only Trello report" },
      ];
    case "security":
      return [
        { label: "Security Configuration", value: "setup:security", description: "Limits, protections, and confirmations" },
        { label: "Security Lockdown", value: "settings-action:lockdown", description: "Immediately stop destructive actions" },
        { label: "Security Unlock", value: "settings-action:unlock", description: "Unlock after confirmation" },
        { label: "Identity Detection", value: "setup:identity", description: "Warning-only association controls" },
      ];
    case "logs":
      return [
        { label: "Audit Configuration", value: "setup:audit", description: "Destinations and retained log categories" },
        { label: "Discord Configuration", value: "setup:discord", description: "View server authorization policy" },
      ];
    case "system":
      return [
        { label: "System Status", value: "settings-action:status", description: "View command, Trello, and security status" },
        { label: "Enable Maintenance", value: "settings-action:maintenance-enable", description: "Temporarily lock normal administration" },
        { label: "Disable Maintenance", value: "settings-action:maintenance-disable", description: "Restore normal administration" },
        { label: "Bot State", value: "setup:bot-state", description: "View emergency availability and controls" },
        { label: "View Configuration", value: "setup:view", description: "Review active server configuration" },
      ];
  }
}

function settingsMenu(nonce: string, configured: boolean, maintenance = false): {
  embeds: EmbedBuilder[];
  components: Array<ActionRowBuilder<StringSelectMenuBuilder>>;
} {
  const categories = settingsRootCategories(configured, maintenance);
  return {
    embeds: [brandedEmbed(
      maintenance ? "EMERGENCY SETTINGS" : "QUARTERMASTER SETTINGS",
      maintenance
        ? "Maintenance is active. Choose an emergency category. Normal configuration and moderation controls are hidden and remain unavailable."
        : configured
          ? "Choose a category to manage Quartermaster. Controls are private, expire after 10 minutes, and re-check your current Administrator permission.\n\n**Moderation** covers blacklist rules and records. **Integrations** covers Trello. **Security** covers safeguards and identity detection. **Logs & Server** covers audit and Discord policy. **System** covers status and maintenance."
          : "Initial setup is required. Open System to verify an audit channel; emergency status and security controls remain available.",
    )],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`settings:select:${nonce}`)
        .setPlaceholder("Choose a settings category")
        .addOptions(categories.map((category) => ({
          label: category.label,
          value: `settings-category:${category.id}:${nonce}`,
          description: category.description,
        }))),
    )],
  };
}

function settingsCategoryMenu(
  nonce: string,
  category: SettingsCategory,
  configured: boolean,
  maintenance: boolean,
): {
  embeds: EmbedBuilder[];
  components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>>;
} {
  const definition = settingsCategories.find((candidate) => candidate.id === category);
  if (!definition) throw new Error("That settings category is not available.");
  const options = settingsCategoryOptions(category, configured, maintenance);
  if (!options.length) {
    throw new Error("That settings category is unavailable while maintenance or initial setup is active.");
  }
  return {
    embeds: [brandedEmbed(
      definition.label,
      maintenance
        ? "Only emergency controls are available while maintenance is active. Choose an action or return to categories."
        : `Choose a ${definition.label.toLowerCase()} setting or action. Related controls are grouped here; use Back to return to categories.`,
    )],
    // Discord select menus and buttons cannot share a row. Keep Back in its
    // own row so every category page has an obvious, safe parent.
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`settings:option:${category}:${nonce}`)
          .setPlaceholder(`Choose a ${definition.label.toLowerCase()} option`)
          .addOptions(options.map((option) => ({
            ...option,
            value: `${option.value}:${nonce}`,
          }))),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`settings:back:root:${nonce}`)
          .setLabel("Back to Categories")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function settingsRootLocation(): SettingsLocation {
  return { kind: "root" };
}

function settingsCategoryLocation(category: SettingsCategory): SettingsLocation {
  return { kind: "category", category };
}

function settingsPageLocation(id: string, parent: SettingsLocation): SettingsLocation {
  return { kind: "page", id, parent };
}

function settingsNavigation(session: SetupSession): SettingsLocation[] {
  return session.navigation?.length ? session.navigation : [settingsRootLocation()];
}

function settingsCurrentParent(session: SetupSession): SettingsLocation {
  const stack = settingsNavigation(session);
  const current = stack.at(-1)!;
  if (current.kind === "page") return current.parent;
  if (current.kind === "category") return stack.at(-2) ?? settingsRootLocation();
  return settingsRootLocation();
}

function settingsBackButton(target: SettingsLocation, nonce: string): ButtonBuilder {
  if (target.kind === "root") {
    return new ButtonBuilder()
      .setCustomId(`settings:back:root:${nonce}`)
      .setLabel("Back to Categories")
      .setStyle(ButtonStyle.Secondary);
  }
  if (target.kind === "category") {
    return new ButtonBuilder()
      .setCustomId(`settings:back:category:${target.category}:${nonce}`)
      .setLabel("Back to Category")
      .setStyle(ButtonStyle.Secondary);
  }
  return new ButtonBuilder()
    .setCustomId(`settings:back:page:${target.id}:${nonce}`)
    .setLabel("Back")
    .setStyle(ButtonStyle.Secondary);
}

function settingsPayloadHasConfirmation(payload: unknown): boolean {
  const found = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as { data?: { custom_id?: string }; components?: unknown[] };
    if (candidate.data?.custom_id &&
        /^(?:confirm|cancel|maintenance-confirm|maintenance-cancel):/.test(candidate.data.custom_id)) {
      return true;
    }
    return (candidate.components ?? []).some(found);
  };
  return found(payload);
}

function withSettingsBack(payload: unknown, session: SetupSession): unknown {
  if (!payload || typeof payload !== "object" || settingsPayloadHasConfirmation(payload)) return payload;
  // The root has no parent. This guard also keeps compatibility requests that
  // invoke an old action value directly from producing a dead Back button.
  if (settingsNavigation(session).at(-1)?.kind === "root") return payload;
  const data = payload as { components?: unknown[] };
  const components = Array.isArray(data.components) ? data.components : [];
  if (components.some((component) => {
    const candidate = component as { components?: unknown[] };
    return (candidate.components ?? []).some((child) => {
      const id = (child as { data?: { custom_id?: string } }).data?.custom_id;
      return id?.startsWith("settings:back:");
    });
  })) return payload;
  return {
    ...data,
    components: [
      ...components,
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        settingsBackButton(settingsCurrentParent(session), session.nonce),
      ),
    ],
  };
}

function setupMenu(nonce: string): {
  embeds: EmbedBuilder[];
  components: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>>;
} {
  const buttons = [
    ["blacklist", "Blacklist Settings"],
    ["trello", "Trello Settings"],
    ["security", "Security Settings"],
    ["audit", "Audit Settings"],
    ["discord", "Discord Settings"],
    ["identity", "Identity / Alt Detection"],
    ["bot-state", "Bot State"],
    ["view", "View Configuration"],
  ] as const;
  return {
    embeds: [brandedEmbed("Setup",
      "Choose a category. Setup controls are bound to you and expire after 10 minutes.",
    )],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...buttons.slice(0, 4).map(([id, label]) =>
          new ButtonBuilder().setCustomId(`setup:${id}:${nonce}`).setLabel(label).setStyle(ButtonStyle.Secondary),
        ),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...buttons.slice(4).map(([id, label]) =>
          new ButtonBuilder().setCustomId(`setup:${id}:${nonce}`).setLabel(label).setStyle(ButtonStyle.Secondary),
        ),
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(`setup:select:${nonce}`).setPlaceholder("Jump to a setup category").addOptions(
          buttons.map(([id, label]) => ({ label, value: `setup:${id}:${nonce}` })),
        ),
      ),
    ],
  };
}

async function requireSettingsSession(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
): Promise<{ session: SetupSession; setup?: GuildSetup }> {
  if (!interaction.guild) throw new Error("Settings are only available in the configured server.");
  const session = setupSessions.get(setupSessionId(interaction.guild.id, interaction.user.id));
  if (!session || session.expiresAt <= Date.now() || session.guildId !== interaction.guild.id) {
    throw new Error("This settings session has expired or belongs to another administrator. Run /settings again.");
  }
  const raw = interaction.isStringSelectMenu?.() ? interaction.values[0] : interaction.customId;
  const nonce = raw.match(/:([a-f0-9]{32})$/)?.[1];
  if (!nonce || nonce !== session.nonce) {
    throw new Error("This settings control belongs to an expired session. Run /settings again.");
  }
  if ((interaction.isButton?.() || interaction.isStringSelectMenu?.()) &&
      session.messageId && interaction.message?.id !== session.messageId) {
    throw new Error("This settings control belongs to an older settings message. Run /settings again.");
  }
  if (config.discordGuildId && interaction.guild.id !== config.discordGuildId) {
    throw new Error("Settings can only be used in the configured server.");
  }
  const setup = await getGuildSetup(interaction.guild.id);
  await requireCurrentAdministrator(interaction.guild, interaction.user.id, setup, "settings interaction");
  return { session, setup };
}

async function handleSettings(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild!;
  const existing = await getGuildSetup(guild.id);
  await requireCurrentAdministrator(guild, interaction.user.id, existing, "/settings");
  const state = await getSecurityState(guild.id);
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const response = await interaction.editReply(settingsMenu(nonce, Boolean(existing), state.maintenance.active));
  setupSessions.set(setupSessionId(guild.id, interaction.user.id), {
    userId: interaction.user.id, guildId: guild.id, expiresAt: Date.now() + setupSessionLifetimeMs,
    messageId: response?.id, nonce, nonceRequired: true,
    navigation: [settingsRootLocation()],
  });
}

function securityEmbed(setup: GuildSetup, state: SecurityState): EmbedBuilder {
  const settings = securitySettingsFor(setup);
  return outcomeEmbed("Security Settings", "Controls for administrative access, protections, and destructive-action safeguards.", "info", [
    { name: "Administrator Access", value: "Current Administrator permission required", inline: true },
    { name: "Per-Administrator Limit", value: `${settings.perAdminLimit} actions / ${settings.windowMinutes} minutes`, inline: true },
    { name: "Global Limit", value: `${settings.globalLimit} actions / ${settings.windowMinutes} minutes`, inline: true },
    { name: "Automatic Lockdown", value: settings.automaticLockdown ? "Enabled" : "Disabled", inline: true },
    { name: "Confirmation", value: settings.confirmationsRequired ? "Enabled" : "Disabled", inline: true },
    { name: "Escalation Guard", value: settings.recentPermissionEscalationProtection ? "Enabled" : "Disabled", inline: true },
    { name: "Current State", value: state.lockdown.active ? `Locked — ${safePresentationText(state.lockdown.reason || "No reason provided")}` : "Not locked", inline: true },
    { name: "Protected Identities", value: `${settings.protectedUserIds.length} users; ${settings.protectedRoleIds.length} roles`, inline: true },
  ]);
}

async function saveSetupChange(
  guild: Guild,
  next: GuildSetup,
  actorId: string,
  setting: string,
  oldValue: string,
  newValue: string,
): Promise<GuildSetup> {
  const updated = { ...next, updatedBy: actorId, updatedAt: new Date().toISOString() };
  await saveGuildSetup(updated);
  await auditBestEffort(guild, updated, {
    action: "Bot configuration changed", status: "success", actorId,
    fields: [{ name: "Setting", value: setting }, { name: "Old", value: oldValue }, { name: "New", value: newValue }],
  });
  return updated;
}

async function requireSetupSession(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
): Promise<GuildSetup> {
  if (!interaction.guild) throw new Error("Setup is only available in the configured server.");
  const session = setupSessions.get(setupSessionId(interaction.guild.id, interaction.user.id));
  if (!session || session.expiresAt <= Date.now()) {
    throw new Error("This settings session has expired. Run /settings again.");
  }
  const customNonce = interaction.customId.match(/:([a-f0-9]{32})$/)?.[1];
  if (session.nonceRequired && customNonce !== session.nonce) {
    throw new Error("This settings control belongs to an expired session. Run /settings again.");
  }
  if (
    interaction.isButton?.() || interaction.isStringSelectMenu?.()
  ) {
    const messageId = interaction.message?.id;
    if (session.messageId && messageId !== session.messageId) {
      throw new Error("This settings control belongs to an older settings message. Run /settings again.");
    }
  }
  if (session.guildId !== interaction.guild.id || session.userId !== interaction.user.id) {
    throw new Error("This setup session belongs to another administrator.");
  }
  if (config.discordGuildId && interaction.guild.id !== config.discordGuildId) {
    throw new Error("Setup can only be used in the configured server.");
  }
  const setup = await getGuildSetup(interaction.guild.id);
  if (!setup) throw new Error("Complete initial setup before changing settings.");
  await requireCurrentAdministrator(interaction.guild, interaction.user.id, setup, "setup interaction");
  return setup;
}

function numberInput(id: string, label: string, value: number, min: number, max: number): TextInputBuilder {
  return new TextInputBuilder().setCustomId(id).setLabel(`${label} (${min}-${max})`).setStyle(TextInputStyle.Short)
    .setRequired(true).setValue(String(value)).setMaxLength(String(max).length);
}

function settingsActionAdapter(
  interaction: ModalSubmitInteraction,
  commandName: string,
  values: Record<string, string | undefined>,
): ChatInputCommandInteraction {
  const editReply = async (value: string | object) => {
    if (!interaction.deferred && !interaction.replied) {
      return interaction.reply(typeof value === "string"
        ? { ...responseWithEmbed(value, "Command Result", "info"), ephemeral: true }
        : { ...value, ephemeral: true });
    }
    return interaction.editReply(value);
  };
  // This deliberately exposes only the small command-shaped contract consumed
  // by established moderation handlers. Values are created from named modal
  // fields here, rather than accepting a command name or arbitrary options
  // from a component custom ID.
  return {
    guild: interaction.guild,
    guildId: interaction.guildId,
    user: interaction.user,
    commandName,
    options: {
      getString: (name: string, required?: boolean) => {
        const value = values[name];
        if (required && !value) throw new Error(`Missing ${name}.`);
        return value ?? null;
      },
      getUser: () => null,
    },
    editReply,
  } as unknown as ChatInputCommandInteraction;
}

async function renderSecurityStatus(
  interaction: { guild: Guild | null; user: { id: string }; editReply(value: string | object): Promise<unknown> },
  setup?: GuildSetup,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new Error("Status is only available in a server.");
  await requireCurrentAdministrator(guild, interaction.user.id, setup, "/settings status");
  const state = await getSecurityState(guild.id);
  const settings = setup ? securitySettingsFor(setup) : defaultSecuritySettings();
  const trello = getTrelloReadiness();
  const recentActions = state.destructiveActions.filter(
    (entry) => Date.parse(entry.at) >= Date.now() - settings.windowMinutes * 60_000,
  ).length;
  const operationalState = state.maintenance.active
    ? `Maintenance: ENABLED${state.maintenance.reason ? ` — ${state.maintenance.reason}` : ""}`
    : state.lockdown.active
      ? `Security lockdown: LOCKED${state.lockdown.reason ? ` — ${state.lockdown.reason}` : ""}`
      : !setup || !guildSetupComplete || !commandsRegistered
        ? "Bot state: SETUP REQUIRED OR COMMANDS UNREGISTERED"
        : !trello.ready ? `Trello: UNAVAILABLE${trello.error ? ` — ${trello.error}` : ""}` : "Bot state: ENABLED";
  const blacklistState = state.maintenance.active ? "DISABLED — MAINTENANCE"
    : state.lockdown.active ? "DISABLED — SECURITY LOCKDOWN"
      : !setup || !guildSetupComplete || !commandsRegistered ? "DISABLED — SETUP/REGISTRATION"
        : !trello.ready ? "DISABLED — TRELLO UNAVAILABLE" : "ENABLED";
  await interaction.editReply({
    embeds: [outcomeEmbed("System Status", "Current command availability and protection state.", state.maintenance.active || state.lockdown.active ? "warning" : "success", [
      { name: "Operational State", value: safePresentationText(operationalState) },
      { name: "Security", value: `${state.lockdown.active ? "Locked" : "Unlocked"}; ${recentActions}/${settings.globalLimit} destructive actions in the current ${settings.windowMinutes}-minute window.` },
      { name: "Maintenance", value: state.maintenance.active
        ? `Enabled since ${readableDate(state.maintenance.startedAt)}${state.maintenance.reason ? ` — ${safePresentationText(state.maintenance.reason)}` : ""}`
        : "Disabled", },
      { name: "Blacklist Commands", value: blacklistState },
      { name: "Trello Readiness", value: trello.ready ? "Ready" : trello.status.toUpperCase() },
    ])],
  });
}

function settingsCategoryForAction(id: string): SettingsCategory | undefined {
  if (
    id === "setup:blacklist" ||
    id === "settings-action:group" ||
    id === "settings-action:note" ||
    id === "settings-action:identity-lookup"
  ) return "moderation";
  if (id === "setup:trello" || id === "settings-action:sync") return "integrations";
  if (
    id === "setup:security" ||
    id === "setup:lockdown" ||
    id === "setup:identity" ||
    id === "settings-action:lockdown" ||
    id === "settings-action:unlock"
  ) return "security";
  if (id === "setup:audit" || id === "setup:discord") return "logs";
  if (
    id === "setup:bot-state" ||
    id === "setup:view" ||
    id === "settings-action:status" ||
    id === "settings-action:initial-audit" ||
    id === "settings-action:maintenance-enable" ||
    id === "settings-action:maintenance-disable"
  ) return "system";
  return undefined;
}

function settingsNavigationId(id: string): boolean {
  return id.startsWith("settings:back:") || id.startsWith("settings-category:");
}

function setSettingsPage(
  session: SetupSession,
  id: string,
  category = settingsCategoryForAction(id),
): void {
  if (!category) return;
  const categoryLocation = settingsCategoryLocation(category);
  const current = settingsNavigation(session).at(-1);
  if (current?.kind === "page" && current.id === id) return;
  session.navigation = [
    settingsRootLocation(),
    categoryLocation,
    settingsPageLocation(id, categoryLocation),
  ];
}

async function renderSettingsBack(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  session: SetupSession,
  setup: GuildSetup | undefined,
  target: string,
): Promise<void> {
  const guild = interaction.guild!;
  if (target === "root") {
    const state = await getSecurityState(guild.id);
    session.navigation = [settingsRootLocation()];
    await interaction.update(settingsMenu(session.nonce, Boolean(setup), state.maintenance.active));
    return;
  }
  if (target.startsWith("category:")) {
    const category = target.slice("category:".length) as SettingsCategory;
    if (!settingsCategories.some((candidate) => candidate.id === category)) {
      throw new Error("That settings category is not available.");
    }
    const state = await getSecurityState(guild.id);
    if (!settingsRootCategories(Boolean(setup), state.maintenance.active)
      .some((candidate) => candidate.id === category)) {
      throw new Error(maintenanceMessage);
    }
    session.navigation = [settingsRootLocation(), settingsCategoryLocation(category)];
    await interaction.update(settingsCategoryMenu(
      session.nonce,
      category,
      Boolean(setup),
      state.maintenance.active,
    ));
    return;
  }
  // The only currently nested settings page is Security Lockdown. Keep this
  // explicit rather than allowing an arbitrary page ID to become a renderer.
  // This is also what prevents a stale Back control from bypassing a modal or
  // confirmation flow.
  if (target === "page:setup:security") {
    if (!setup) throw new Error("Complete first-time setup before changing these settings.");
    const state = await getSecurityState(guild.id);
    if (state.maintenance.active) throw new Error(maintenanceMessage);
    const categoryLocation = settingsCategoryLocation("security");
    session.navigation = [
      settingsRootLocation(),
      categoryLocation,
      settingsPageLocation("setup:security", categoryLocation),
    ];
    const payload = {
      embeds: [securityEmbed(setup, state)],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("setup:rates").setLabel("Edit Rate Limits").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("setup:lockdown").setLabel("Lockdown Settings").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("setup:protected-users").setLabel("Protected Users").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("setup:protected-roles").setLabel("Protected Roles").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("setup:confirmation").setLabel("Toggle Confirmation").setStyle(ButtonStyle.Secondary),
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("setup:escalation-protection").setLabel("Permission Escalation Guard").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("setup:security-reset").setLabel("Reset Security Defaults").setStyle(ButtonStyle.Secondary),
        ),
      ],
    };
    await interaction.update(sealSettingsComponents(
      withSettingsBack(payload, session),
      session.nonce,
    ) as never);
    return;
  }
  throw new Error("That settings page is no longer available. Run /settings again.");
}

async function handleSettingsComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  const { session, setup } = await requireSettingsSession(interaction);
  const raw = interaction.isStringSelectMenu() ? interaction.values[0]! : interaction.customId;
  const id = raw.replace(/:([a-f0-9]{32})$/, "");
  const state = await getSecurityState(interaction.guild!.id);
  const emergency = new Set([
    "settings-action:status", "settings-action:maintenance-enable", "settings-action:maintenance-disable",
    "settings-action:lockdown", "settings-action:unlock",
  ]);
  if (id === "settings:back:root") {
    const current = settingsNavigation(session).at(-1);
    if (current?.kind !== "category") {
      throw new Error("This settings control is stale. Return to /settings and choose a category again.");
    }
    await renderSettingsBack(interaction, session, setup, "root");
    return;
  }
  if (id.startsWith("settings:back:category:")) {
    const targetCategory = id.slice("settings:back:category:".length) as SettingsCategory;
    const expected = settingsCurrentParent(session);
    if (expected.kind !== "category" || expected.category !== targetCategory) {
      throw new Error("This settings control is stale. Return to /settings and choose a category again.");
    }
    await renderSettingsBack(interaction, session, setup, `category:${targetCategory}`);
    return;
  }
  if (id.startsWith("settings:back:page:")) {
    const targetPage = id.slice("settings:back:page:".length);
    const expected = settingsCurrentParent(session);
    if (expected.kind !== "page" || expected.id !== targetPage) {
      throw new Error("This settings control is stale. Return to /settings and choose a page again.");
    }
    await renderSettingsBack(interaction, session, setup, `page:${targetPage}`);
    return;
  }
  if (id.startsWith("settings-category:")) {
    const category = id.slice("settings-category:".length) as SettingsCategory;
    if (!settingsCategories.some((candidate) => candidate.id === category)) {
      throw new Error("That settings category is not available.");
    }
    if (!settingsRootCategories(Boolean(setup), state.maintenance.active)
      .some((candidate) => candidate.id === category)) {
      throw new Error(maintenanceMessage);
    }
    session.navigation = [settingsRootLocation(), settingsCategoryLocation(category)];
    await interaction.update(settingsCategoryMenu(
      session.nonce,
      category,
      Boolean(setup),
      state.maintenance.active,
    ));
    return;
  }
  if (state.maintenance.active && !emergency.has(id) && !settingsNavigationId(id)) {
    throw new Error(maintenanceMessage);
  }
  const category = settingsCategoryForAction(id);
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("settings:option:")) {
    const selectedCategory = interaction.customId.split(":")[2] as SettingsCategory | undefined;
    if (!category || category !== selectedCategory) {
      throw new Error("That settings option does not belong to this category.");
    }
  }
  // Modal and report actions leave the category message in place; its
  // existing Back control must remain valid while the modal/confirmation is
  // being completed. A setup:* selection renders a deeper page and therefore
  // advances the explicit navigation stack.
  if (category && id.startsWith("setup:")) setSettingsPage(session, id, category);
  if (id.startsWith("setup:")) {
    if (!setup) throw new Error("Complete first-time setup before changing these settings.");
    // Existing category handlers contain the durable validation and audit
    // behavior. The selected, nonce-bound value is their sole input.
    await handleSetupComponent(interaction);
    return;
  }
  if (id === "settings-action:status") {
    await renderSecurityStatus({
      guild: interaction.guild,
      user: interaction.user,
      // A select must be acknowledged with update/deferUpdate, not editReply
      // before its initial response.
      editReply: async (payload) => interaction.update(
        sealSettingsComponents(withSettingsBack(payload, session), session.nonce) as never,
      ),
    }, setup);
    return;
  }
  if (id === "settings-action:maintenance-disable") {
    await interaction.deferUpdate();
    await createMaintenanceConfirmation(interaction as unknown as ChatInputCommandInteraction, false, "Administrator requested maintenance completion");
    return;
  }
  const modal = (name: string, title: string, fields: TextInputBuilder[]) =>
    interaction.showModal(new ModalBuilder().setCustomId(scopedSetupModalId(
      interaction.guild!.id, interaction.user.id, `settings-modal:${name}`,
    )).setTitle(title).addComponents(...fields.map((field) =>
      new ActionRowBuilder<TextInputBuilder>().addComponents(field),
    )));
  if (id === "settings-action:initial-audit") {
    if (setup) throw new Error("Setup is already complete. Use Audit Settings to update the audit channel.");
    await modal("initial-audit", "Complete Quartermaster setup", [
      new TextInputBuilder().setCustomId("audit_channel_id").setLabel("Audit text-channel ID").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(25),
    ]);
    return;
  }
  if (id === "settings-action:group") {
    await modal("group", "Blacklist a Roblox group", [
      new TextInputBuilder().setCustomId("id").setLabel("Roblox group ID").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20),
      new TextInputBuilder().setCustomId("reason").setLabel("Reason").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
    ]);
    return;
  }
  if (id === "settings-action:note") {
    await modal("note", "Record blacklist note", [
      new TextInputBuilder().setCustomId("username").setLabel("Roblox username (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(50),
      new TextInputBuilder().setCustomId("note").setLabel("Note").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
    ]);
    return;
  }
  if (id === "settings-action:identity-lookup") {
    await modal("identity-lookup", "Identity association lookup", [
      new TextInputBuilder().setCustomId("discord_id").setLabel("Discord user ID (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(25),
      new TextInputBuilder().setCustomId("roblox_id").setLabel("Roblox numeric ID (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20),
    ]);
    return;
  }
  if (id === "settings-action:lockdown" || id === "settings-action:maintenance-enable") {
    await modal(
      id.endsWith("lockdown") ? "lockdown" : "maintenance-enable",
      id.endsWith("lockdown") ? "Enable security lockdown" : "Enable maintenance mode",
      [new TextInputBuilder().setCustomId("reason").setLabel("Reason").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)],
    );
    return;
  }
  if (id === "settings-action:unlock") {
    await modal("unlock", "Unlock security lockdown", [
      new TextInputBuilder().setCustomId("reason").setLabel("Reason (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500),
    ]);
    return;
  }
  if (id === "settings-action:sync") {
    if (!setup) throw new Error("Complete first-time setup before requesting monitoring reports.");
    await interaction.deferUpdate();
    await runGuildBlacklistSync(interaction.guild!, "manual");
    const sync = getBlacklistSyncStatus();
    await interaction.editReply(sealSettingsComponents(withSettingsBack({
      embeds: [outcomeEmbed("Trello Monitoring", "Report-only synchronization is complete. Manual Trello changes never modify Discord state.", sync.counts.issues ? "warning" : "success", [
        { name: "State", value: titleCaseHeading(sync.state), inline: true },
        { name: "Indexed", value: String(sync.counts.indexed), inline: true },
        { name: "Issues", value: String(sync.counts.issues), inline: true },
      ])],
      allowedMentions: noMentions,
      components: [],
    }, session), session.nonce) as never);
    await auditBestEffort(interaction.guild!, setup, {
      action: "Blacklist sync report requested", status: "success", actorId: interaction.user.id,
      fields: [{ name: "Mode", value: "Monitoring-only" }],
    });
  }
}

async function handleSetupComponent(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
  const setup = await requireSetupSession(interaction);
  const guild = interaction.guild!;
  const activeSession = setupSessions.get(setupSessionId(guild.id, interaction.user.id));
  if (activeSession?.nonceRequired) {
    // The legacy category renderer is reused by `/settings`. Seal every
    // generated child button/select centrally so no future category control
    // can accidentally omit the user/guild-bound nonce.
    const update = interaction.update.bind(interaction);
    const showModal = interaction.showModal.bind(interaction);
    Object.defineProperties(interaction, {
      update: {
        value: (payload: unknown) => update(
          sealSettingsComponents(
            withSettingsBack(payload, activeSession),
            activeSession.nonce,
          ) as never,
        ),
      },
      showModal: {
        value: (modal: unknown) => showModal(sealSettingsComponents(modal, activeSession.nonce) as ModalBuilder),
      },
    });
  }
  const componentId = interaction.customId.replace(/:([a-f0-9]{32})$/, "");
  const rawId = interaction.isStringSelectMenu() ? interaction.values[0]! : interaction.customId;
  const id = rawId.replace(/:([a-f0-9]{32})$/, "");
  const nonce = rawId.match(/:([a-f0-9]{32})$/)?.[1];
  if (nonce && activeSession?.nonce !== nonce) {
    throw new Error("This settings control belongs to an expired settings session. Run /settings again.");
  }
  if (activeSession?.nonceRequired && id.startsWith("setup:")) {
    const pageIds = new Set([
      "setup:blacklist", "setup:trello", "setup:security", "setup:lockdown",
      "setup:audit", "setup:discord", "setup:identity", "setup:bot-state", "setup:view",
    ]);
    if (pageIds.has(id)) {
      const current = settingsNavigation(activeSession).at(-1);
      if (current?.kind === "page" && current.id === id) {
        // The category select has already established this page.
      } else if (current?.kind === "page" && id === "setup:security") {
        const categoryLocation = settingsCategoryLocation("security");
        activeSession.navigation = [
          settingsRootLocation(),
          categoryLocation,
          settingsPageLocation(id, categoryLocation),
        ];
      } else {
        const category = settingsCategoryForAction(id);
        if (category) {
          const categoryLocation = settingsCategoryLocation(category);
          const parent = current?.kind === "page"
            ? current
            : categoryLocation;
          activeSession.navigation = [
            settingsRootLocation(),
            categoryLocation,
            settingsPageLocation(id, parent),
          ];
        }
      }
    }
  }
  const lockdown = await getSecurityState(guild.id);
  if (
    lockdown.lockdown.active &&
    [
      "setup:rates",
      "setup:threshold",
      "setup:toggle-auto-lockdown",
      "setup:confirmation",
      "setup:protected-users",
      "setup:protected-roles",
      "setup:security-reset",
      "setup:escalation-protection",
      "setup:trello-toggle",
      "setup:trello-desync",
      "setup:trello-monitoring-reset",
      "setup:trello-interval",
    ].includes(id) ||
    (lockdown.lockdown.active && id.startsWith("setup:identity-"))
  ) {
    throw new Error("Security lockdown is active. Security settings cannot be weakened until it is unlocked.");
  }
  if (id === "setup:security") {
    const state = await getSecurityState(guild.id);
    await interaction.update({
      embeds: [securityEmbed(setup, state)],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("setup:rates").setLabel("Edit Rate Limits").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("setup:lockdown").setLabel("Lockdown Settings").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("setup:protected-users").setLabel("Protected Users").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("setup:protected-roles").setLabel("Protected Roles").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("setup:confirmation").setLabel("Toggle Confirmation").setStyle(ButtonStyle.Secondary),
      ), new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("setup:escalation-protection").setLabel("Permission Escalation Guard").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("setup:security-reset").setLabel("Reset Security Defaults").setStyle(ButtonStyle.Secondary),
      )],
    });
    return;
  }
  if (id === "setup:bot-state") {
    const state = await getSecurityState(guild.id);
    await interaction.update({
      embeds: [outcomeEmbed("Bot State", "Emergency availability and protection state.", state.maintenance.active || state.lockdown.active ? "warning" : "success", [
        { name: "Maintenance", value: state.maintenance.active ? "Enabled" : "Disabled" },
        ...(state.maintenance.active && state.maintenance.reason
          ? [{ name: "Reason", value: safePresentationText(state.maintenance.reason) }]
          : []),
        { name: "Security Lockdown", value: state.lockdown.active ? "Enabled" : "Disabled" },
      ])],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("setup:enable-maintenance").setLabel("Enable Maintenance").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("setup:security").setLabel("Security Settings").setStyle(ButtonStyle.Secondary),
      )],
    });
    return;
  }
  if (id === "setup:enable-maintenance") {
    await interaction.showModal(new ModalBuilder()
      .setCustomId(scopedSetupModalId(guild.id, interaction.user.id, "setup-modal:maintenance-reason"))
      .setTitle("Enable maintenance mode")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("reason").setLabel("Maintenance reason").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
      )));
    return;
  }
  if (id === "setup:rates") {
    const settings = securitySettingsFor(setup);
    await interaction.showModal(new ModalBuilder().setCustomId(scopedSetupModalId(guild.id, interaction.user.id, "setup-modal:rates")).setTitle("Edit blacklist rate limits")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(numberInput("per_admin", "Per-admin actions", settings.perAdminLimit, 1, 100)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(numberInput("global", "Global actions", settings.globalLimit, 1, 500)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(numberInput("window", "Window minutes", settings.windowMinutes, 1, 1440)),
      ));
    return;
  }
  if (id === "setup:lockdown") {
    const state = await getSecurityState(guild.id);
    await interaction.update({
      embeds: [outcomeEmbed("Automatic Security Lockdown", "Automatic and manual controls for stopping destructive actions.", state.lockdown.active ? "warning" : "info", [
        { name: "Automatic Lockdown", value: securitySettingsFor(setup).automaticLockdown ? "Enabled" : "Disabled", inline: true },
        { name: "Current State", value: state.lockdown.active ? "Locked" : "Not locked", inline: true },
      ])],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("setup:toggle-auto-lockdown").setLabel("Enable / Disable").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("setup:threshold").setLabel("Change Threshold").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("setup:lock-now").setLabel("Lock Down Now").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("setup:unlock-now").setLabel("Unlock").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("setup:security").setLabel("Back").setStyle(ButtonStyle.Secondary),
      )],
    });
    return;
  }
  if (id === "setup:toggle-auto-lockdown" || id === "setup:confirmation") {
    const current = securitySettingsFor(setup);
    const security = {
      ...current,
      ...(id === "setup:toggle-auto-lockdown"
        ? { automaticLockdown: !current.automaticLockdown }
        : { confirmationsRequired: !current.confirmationsRequired }),
    };
    const updated = await saveSetupChange(guild, { ...setup, security }, interaction.user.id,
      id === "setup:confirmation" ? "Confirmation requirement" : "Automatic lockdown",
      String(id === "setup:confirmation" ? current.confirmationsRequired : current.automaticLockdown),
      String(id === "setup:confirmation" ? security.confirmationsRequired : security.automaticLockdown));
    await interaction.update({ embeds: [securityEmbed(updated, await getSecurityState(guild.id))], components: [] });
    return;
  }
  if (id === "setup:security-reset") {
    const current = securitySettingsFor(setup);
    const security = defaultSecuritySettings();
    await saveSetupChange(guild, { ...setup, security }, interaction.user.id, "Security settings reset", JSON.stringify(current), JSON.stringify(security));
    await interaction.update({ embeds: [securityEmbed({ ...setup, security }, await getSecurityState(guild.id))], components: [] });
    return;
  }
  if (id === "setup:escalation-protection") {
    const current = securitySettingsFor(setup);
    const security = {
      ...current,
      recentPermissionEscalationProtection: !current.recentPermissionEscalationProtection,
    };
    await saveSetupChange(guild, { ...setup, security }, interaction.user.id, "Recent permission escalation protection", String(current.recentPermissionEscalationProtection), String(security.recentPermissionEscalationProtection));
    await interaction.update({ embeds: [securityEmbed({ ...setup, security }, await getSecurityState(guild.id))], components: [] });
    return;
  }
  if (id === "setup:threshold") {
    const settings = securitySettingsFor(setup);
    await interaction.showModal(new ModalBuilder().setCustomId(scopedSetupModalId(guild.id, interaction.user.id, "setup-modal:threshold")).setTitle("Automatic lockdown threshold")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
        numberInput("threshold", "Actions before lockdown", settings.automaticLockdownThreshold, 1, 500),
      )));
    return;
  }
  if (id === "setup:unlock-now") {
    await interaction.update({
      ...responseWithEmbed(
        "Confirm unlocking security lockdown. Your current Administrator permission will be checked again.",
        "Confirm Security Unlock",
        "warning",
      ),
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("setup:confirm-unlock").setLabel("Confirm Unlock").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("setup:lockdown").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      )],
    });
    return;
  }
  if (id === "setup:confirm-unlock") {
    await completeSecurityUnlock(guild, interaction.user.id, setup, "Setup control confirmation");
    await interaction.update({
      ...responseWithEmbed("Security lockdown has been unlocked.", "Security Lockdown Unlocked", "success"),
      components: [],
    });
    return;
  }
  if (id === "setup:lock-now") {
    const active = id === "setup:lock-now";
    await mutateSecurityState(guild.id, (state) => {
      state.lockdown = active
        ? { active: true, automatic: false, reason: "Manual setup lockdown", startedAt: new Date().toISOString(), startedBy: interaction.user.id }
        : { active: false, automatic: false, reason: "", startedAt: null, startedBy: null };
    });
    await auditBestEffort(guild, setup, {
      action: active ? "Security lockdown enabled" : "Security lockdown unlocked",
      status: "success", actorId: interaction.user.id,
    });
    await interaction.update({ embeds: [securityEmbed(setup, await getSecurityState(guild.id))], components: [] });
    return;
  }
  if (id === "setup:protected-users" || id === "setup:protected-roles") {
    const role = id.endsWith("roles");
    await interaction.showModal(new ModalBuilder().setCustomId(role ? "setup-modal:protected-roles" : "setup-modal:protected-users")
      .setTitle(role ? "Protected role IDs" : "Protected user IDs")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("ids").setLabel("Comma-separated Discord IDs").setStyle(TextInputStyle.Paragraph).setRequired(false)
          .setValue((role ? securitySettingsFor(setup).protectedRoleIds : securitySettingsFor(setup).protectedUserIds).join(", ")),
      )));
    return;
  }
  if (id === "setup:audit") {
    const audit = auditSettingsFor(setup);
    await interaction.update({ embeds: [outcomeEmbed("Audit Settings", "Destinations and retained audit categories.", "info", [
      { name: "Main Channel", value: `<#${setup.auditChannelId}>`, inline: true },
      { name: "Security Channel", value: setup.securityAlertChannelId ? `<#${setup.securityAlertChannelId}>` : "Main channel", inline: true },
      { name: "Trello Channel", value: setup.trelloAlertChannelId ? `<#${setup.trelloAlertChannelId}>` : "Main channel", inline: true },
      { name: "Trello Alerts", value: audit.trelloAlerts ? "Enabled" : "Disabled", inline: true },
      { name: "Blacklist Logs", value: audit.blacklistLogs ? "Enabled" : "Disabled", inline: true },
      { name: "Role Logs", value: audit.roleEnforcementLogs ? "Enabled" : "Disabled", inline: true },
      { name: "Join/Leave Logs", value: audit.joinLeaveBlacklistLogs ? "Enabled" : "Disabled", inline: true },
    ])], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("setup:audit-channels").setLabel("Change Channels").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("setup:audit-toggle-trello").setLabel("Trello Alerts").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:audit-toggle-blacklist").setLabel("Blacklist Logs").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:audit-toggle-roles").setLabel("Role Logs").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:audit-toggle-joins").setLabel("Join/Leave Logs").setStyle(ButtonStyle.Secondary),
    ), new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("setup:audit-test").setLabel("Test Logging").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("setup:audit-reset").setLabel("Reset Defaults").setStyle(ButtonStyle.Secondary),
    )] });
    return;
  }
  if (id === "setup:audit-channels") {
    await interaction.showModal(new ModalBuilder().setCustomId(scopedSetupModalId(guild.id, interaction.user.id, "setup-modal:audit")).setTitle("Audit settings").addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("main").setLabel("Main audit channel ID").setStyle(TextInputStyle.Short).setValue(setup.auditChannelId).setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("security").setLabel("Security alert channel ID (optional)").setStyle(TextInputStyle.Short).setValue(setup.securityAlertChannelId ?? "").setRequired(false)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("trello").setLabel("Trello alert channel ID (optional)").setStyle(TextInputStyle.Short).setValue(setup.trelloAlertChannelId ?? "").setRequired(false)),
    ));
    return;
  }
  if (id.startsWith("setup:audit-toggle-") || id === "setup:audit-reset") {
    const current = auditSettingsFor(setup);
    const field = id.replace("setup:audit-toggle-", "") as "trello" | "blacklist" | "roles" | "joins";
    const property = ({
      trello: "trelloAlerts",
      blacklist: "blacklistLogs",
      roles: "roleEnforcementLogs",
      joins: "joinLeaveBlacklistLogs",
    } as const)[field];
    const audit = id === "setup:audit-reset"
      ? defaultAuditSettings()
      : { ...current, [property]: !current[property] };
    await saveSetupChange(guild, { ...setup, audit }, interaction.user.id, "Audit category settings", JSON.stringify(current), JSON.stringify(audit));
    await interaction.update({
      ...responseWithEmbed("Audit category settings saved. Security and configuration audits are always retained.", "Audit Settings Saved", "success"),
      components: [],
    });
    return;
  }
  if (id === "setup:audit-test") {
    await sendAuditEvent(guild, setup, {
      action: "Audit logging test",
      status: "success",
      actorId: interaction.user.id,
      fields: [{ name: "Result", value: "Audit destination and permissions are working." }],
    });
    await interaction.update({
      ...responseWithEmbed("A test audit event was sent.", "Audit Test Sent", "success"),
      components: [],
    });
    return;
  }
  if (id === "setup:blacklist") {
    const mapping = trelloMappingsFor(setup);
    await interaction.update({ embeds: [outcomeEmbed("Blacklist Settings", "Discord role and Trello list mappings used by moderation.", "info", [
      { name: "Blacklisted Discord Role", value: setup.blacklistRoleId ? `<@&${setup.blacklistRoleId}>` : "Not configured" },
      { name: "Appealable List", value: safePresentationText(mapping.lists.appealable), inline: true },
      { name: "Conditional List", value: safePresentationText(mapping.lists.conditional), inline: true },
      { name: "Permanent List", value: safePresentationText(mapping.lists.permanent), inline: true },
      { name: "Group Blacklist List", value: safePresentationText(mapping.lists.group), inline: true },
      { name: "Revoked List", value: safePresentationText(mapping.lists.revoked), inline: true },
    ])], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("setup:blacklist-role").setLabel("Blacklisted Role").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("setup:trello-lists").setLabel("Trello Lists").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:trello-labels").setLabel("Trello Labels 1–5").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:trello-group-label").setLabel("Group Label").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:trello-reset").setLabel("Reset Mapping").setStyle(ButtonStyle.Secondary),
    )] });
    return;
  }
  if (id === "setup:blacklist-role") {
    await interaction.showModal(new ModalBuilder().setCustomId(scopedSetupModalId(guild.id, interaction.user.id, "setup-modal:blacklist")).setTitle("Blacklist settings").addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("role").setLabel("Blacklisted role ID (optional)").setStyle(TextInputStyle.Short).setValue(setup.blacklistRoleId ?? "").setRequired(false)),
    ));
    return;
  }
  if (id === "setup:trello-lists") {
    const lists = trelloMappingsFor(setup).lists;
    await interaction.showModal(new ModalBuilder().setCustomId(scopedSetupModalId(guild.id, interaction.user.id, "setup-modal:trello-lists")).setTitle("Trello blacklist list mappings").addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("appealable").setLabel("Appealable list").setStyle(TextInputStyle.Short).setValue(lists.appealable).setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("conditional").setLabel("Conditional list").setStyle(TextInputStyle.Short).setValue(lists.conditional).setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("permanent").setLabel("Permanent list").setStyle(TextInputStyle.Short).setValue(lists.permanent).setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("group").setLabel("Group blacklist list").setStyle(TextInputStyle.Short).setValue(lists.group).setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("revoked").setLabel("Revoked list").setStyle(TextInputStyle.Short).setValue(lists.revoked).setRequired(true)),
    ));
    return;
  }
  if (id === "setup:trello-labels") {
    const labels = trelloMappingsFor(setup).labels;
    await interaction.showModal(new ModalBuilder().setCustomId(scopedSetupModalId(guild.id, interaction.user.id, "setup-modal:trello-labels")).setTitle("Trello label mappings 1–5").addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("blacklisted").setLabel("BLACKLISTED label").setStyle(TextInputStyle.Short).setValue(labels.blacklisted).setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("appealable").setLabel("APPEALABLE label").setStyle(TextInputStyle.Short).setValue(labels.appealable).setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("conditional").setLabel("CONDITIONAL label").setStyle(TextInputStyle.Short).setValue(labels.conditional).setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("permanent").setLabel("PERMANENT label").setStyle(TextInputStyle.Short).setValue(labels.permanent).setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("revoked").setLabel("REVOKED label").setStyle(TextInputStyle.Short).setValue(labels.revoked).setRequired(true)),
    ));
    return;
  }
  if (id === "setup:trello-group-label") {
    const labels = trelloMappingsFor(setup).labels;
    await interaction.showModal(new ModalBuilder().setCustomId(scopedSetupModalId(guild.id, interaction.user.id, "setup-modal:trello-group-label")).setTitle("Trello group label mapping").addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("group").setLabel("GROUP BLACKLIST label").setStyle(TextInputStyle.Short).setValue(labels.group).setRequired(true)),
    ));
    return;
  }
  if (id === "setup:trello-reset") {
    const mapping = defaultTrelloMappings();
    await validateTrelloMappings(mapping);
    await saveSetupChange(guild, { ...setup, trello: mapping }, interaction.user.id, "Trello mappings", JSON.stringify(trelloMappingsFor(setup)), JSON.stringify(mapping));
    await interaction.update({
      ...responseWithEmbed("Default Trello mappings were validated against the board and saved.", "Trello Mappings Saved", "success"),
      components: [],
    });
    return;
  }
  if (id === "setup:trello") {
    const monitoring = { ...defaultMonitoringSettings(), ...setup.monitoring };
    await interaction.update({ embeds: [outcomeEmbed("Trello Monitoring", "Monitoring is report-only for manual Trello edits; Discord state changes require approved bot actions.", "info", [
      { name: "Manual Change Alerts", value: monitoring.manualChangeDetection ? "Enabled" : "Disabled", inline: true },
      { name: "Database Sync Checks", value: monitoring.desyncDetection ? "Enabled" : "Disabled", inline: true },
      { name: "Polling Interval", value: `${monitoring.pollingIntervalSeconds} seconds`, inline: true },
      { name: "Discord Role Changes", value: "Approved bot actions only", inline: true },
    ])], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("setup:trello-toggle").setLabel("Toggle manual alerts").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:trello-desync").setLabel("Toggle desync checks").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:trello-interval").setLabel("Polling interval").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:trello-monitoring-reset").setLabel("Reset Defaults").setStyle(ButtonStyle.Secondary),
    )] });
    return;
  }
  if (id === "setup:trello-toggle") {
    const current = { ...defaultMonitoringSettings(), ...setup.monitoring };
    const monitoring = { ...current, manualChangeDetection: !current.manualChangeDetection };
    await saveSetupChange(guild, { ...setup, monitoring }, interaction.user.id, "Manual Trello change detection", String(current.manualChangeDetection), String(monitoring.manualChangeDetection));
    await interaction.update({
      ...responseWithEmbed("Trello monitoring saved. Manual Trello edits never modify Discord blacklist state.", "Trello Monitoring Saved", "success"),
      components: [],
    });
    return;
  }
  if (id === "setup:trello-desync" || id === "setup:trello-monitoring-reset") {
    const current = { ...defaultMonitoringSettings(), ...setup.monitoring };
    const monitoring = id === "setup:trello-monitoring-reset"
      ? defaultMonitoringSettings()
      : { ...current, desyncDetection: !current.desyncDetection };
    await saveSetupChange(guild, { ...setup, monitoring }, interaction.user.id, "Trello monitoring settings", JSON.stringify(current), JSON.stringify(monitoring));
    if (id === "setup:trello-monitoring-reset") scheduleBlacklistSync(guild, { ...setup, monitoring });
    await interaction.update({
      ...responseWithEmbed("Trello monitoring settings saved.", "Trello Monitoring Saved", "success"),
      components: [],
    });
    return;
  }
  if (id === "setup:trello-interval") {
    const monitoring = { ...defaultMonitoringSettings(), ...setup.monitoring };
    await interaction.showModal(new ModalBuilder().setCustomId(scopedSetupModalId(guild.id, interaction.user.id, "setup-modal:trello-interval")).setTitle("Trello polling interval").addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(numberInput("seconds", "Seconds", monitoring.pollingIntervalSeconds, 15, 3600)),
    ));
    return;
  }
  if (id === "setup:identity") {
    const identity = { ...defaultIdentitySettings(), ...setup.identity };
    await interaction.update({ embeds: [outcomeEmbed("Identity and Alt Detection", "Association checks surface warnings only. Automatic punishment remains disabled.", "info", [
      { name: "Same Roblox, Different Discord", value: identity.sameRobloxDifferentDiscord ? "Enabled" : "Disabled" },
      { name: "Same Discord, Different Roblox", value: identity.sameDiscordDifferentRoblox ? "Enabled" : "Disabled" },
      { name: "Historical Warnings", value: identity.historicalAssociationWarnings ? "Enabled" : "Disabled" },
      { name: "Enforcement", value: "Warnings only" },
    ])], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("setup:identity-roblox").setLabel("Same Roblox toggle").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:identity-discord").setLabel("Same Discord toggle").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:identity-history").setLabel("Historical warnings").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:identity-reset").setLabel("Reset Defaults").setStyle(ButtonStyle.Secondary),
    )] });
    return;
  }
  if (id.startsWith("setup:identity-")) {
    const current = { ...defaultIdentitySettings(), ...setup.identity };
    const identity = id === "setup:identity-reset"
      ? defaultIdentitySettings()
      : id === "setup:identity-roblox"
        ? { ...current, sameRobloxDifferentDiscord: !current.sameRobloxDifferentDiscord }
        : id === "setup:identity-discord"
          ? { ...current, sameDiscordDifferentRoblox: !current.sameDiscordDifferentRoblox }
          : { ...current, historicalAssociationWarnings: !current.historicalAssociationWarnings };
    await saveSetupChange(guild, { ...setup, identity }, interaction.user.id, "Identity / alt detection settings", JSON.stringify(current), JSON.stringify(identity));
    await interaction.update({
      ...responseWithEmbed("Identity settings saved. Possible alts remain warnings only.", "Identity Settings Saved", "success"),
      components: [],
    });
    return;
  }
  if (id === "setup:view" || id === "setup:discord") {
    await interaction.update({ embeds: [outcomeEmbed(id === "setup:view" ? "Configuration" : "Discord Settings", "Saved server configuration and authorization policy.", "info", [
      { name: "Audit Channel", value: `<#${setup.auditChannelId}>` },
      { name: "Blacklist Role", value: setup.blacklistRoleId ? `<@&${setup.blacklistRoleId}>` : "Not configured" },
      { name: "Authorization", value: "Current Administrator permission only" },
    ])], components: [] });
  }
}

async function handleSetupModal(interaction: ModalSubmitInteraction): Promise<void> {
  const setup = await requireSetupSession(interaction);
  const guild = interaction.guild!;
  const rawId = interaction.customId;
  const id = rawId.replace(/:([a-f0-9]{32})$/, "");
  const nonce = rawId.match(/:([a-f0-9]{32})$/)?.[1];
  const session = setupSessions.get(setupSessionId(guild.id, interaction.user.id));
  if (!nonce || session?.nonce !== nonce) {
    throw new Error("This settings modal belongs to an expired session. Run /settings again.");
  }
  if (id === "setup-modal:maintenance-reason") {
    const reason = cleanText(interaction.fields.getTextInputValue("reason"), "Maintenance reason");
    await createMaintenanceConfirmation(interaction, true, reason);
    return;
  }
  if (
    (id === "setup-modal:rates" ||
      id === "setup-modal:threshold" ||
      id === "setup-modal:trello-interval" ||
      id === "setup-modal:protected-users" ||
      id === "setup-modal:protected-roles") &&
    (await getSecurityState(guild.id)).lockdown.active
  ) {
    throw new Error("Security lockdown is active. Security settings cannot be weakened until it is unlocked.");
  }
  if (id === "setup-modal:threshold") {
    const current = securitySettingsFor(setup);
    const threshold = Number(interaction.fields.getTextInputValue("threshold"));
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 500) {
      throw new Error("Lockdown threshold must be a whole number from 1 to 500.");
    }
    const security = { ...current, automaticLockdownThreshold: threshold };
    await saveSetupChange(guild, { ...setup, security }, interaction.user.id, "Automatic lockdown threshold", String(current.automaticLockdownThreshold), String(threshold));
    await interaction.reply({ ...responseWithEmbed("Automatic lockdown threshold saved and audited.", "Threshold Saved", "success"), ephemeral: true });
    return;
  }
  if (id === "setup-modal:rates") {
    const parse = (name: string, maximum: number) => {
      const value = Number(interaction.fields.getTextInputValue(name));
      if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Rate limit values must be whole numbers from 1 to ${maximum}.`);
      return value;
    };
    const current = securitySettingsFor(setup);
    const security = { ...current, perAdminLimit: parse("per_admin", 100), globalLimit: parse("global", 500), windowMinutes: parse("window", 1440) };
    if (security.globalLimit < security.perAdminLimit) throw new Error("Global limit must be at least the per-administrator limit.");
    await saveSetupChange(guild, { ...setup, security }, interaction.user.id, "Blacklist rate limits", JSON.stringify(current), JSON.stringify(security));
    await interaction.reply({ ...responseWithEmbed("Rate limits saved and audited.", "Rate Limits Saved", "success"), ephemeral: true });
    return;
  }
  if (id === "setup-modal:protected-users" || id === "setup-modal:protected-roles") {
    const ids = interaction.fields.getTextInputValue("ids").split(",").map((value) => value.trim()).filter(Boolean);
    if (ids.some((value) => !/^\d{5,25}$/.test(value))) throw new Error("Protected entries must be Discord IDs only.");
    const current = securitySettingsFor(setup);
    const isRole = id.endsWith("roles");
    if (isRole) {
      for (const roleId of ids) if (!await guild.roles.fetch(roleId)) throw new Error(`Role ${roleId} does not exist in this server.`);
    }
    const security = { ...current, ...(isRole ? { protectedRoleIds: ids } : { protectedUserIds: ids }) };
    await saveSetupChange(guild, { ...setup, security }, interaction.user.id, isRole ? "Protected roles" : "Protected users",
      (isRole ? current.protectedRoleIds : current.protectedUserIds).join(", ") || "None", ids.join(", ") || "None");
    await interaction.reply({ ...responseWithEmbed("Protected identities saved and audited.", "Protected Identities Saved", "success"), ephemeral: true });
    return;
  }
  if (id === "setup-modal:audit") {
    const main = interaction.fields.getTextInputValue("main").trim();
    const security = interaction.fields.getTextInputValue("security").trim();
    const trello = interaction.fields.getTextInputValue("trello").trim();
    if (!/^\d{5,25}$/.test(main) || (security && !/^\d{5,25}$/.test(security)) || (trello && !/^\d{5,25}$/.test(trello))) throw new Error("Channel IDs must contain only digits.");
    const candidate = { ...setup, auditChannelId: main, securityAlertChannelId: security || undefined, trelloAlertChannelId: trello || undefined };
    await requireAuditChannel(guild, candidate);
    if (security) await requireAuditChannel(guild, { ...candidate, auditChannelId: security });
    if (trello) await requireAuditChannel(guild, { ...candidate, auditChannelId: trello });
    await saveSetupChange(guild, candidate, interaction.user.id, "Audit channels", `${setup.auditChannelId}/${setup.securityAlertChannelId ?? "main"}/${setup.trelloAlertChannelId ?? "main"}`, `${main}/${security || "main"}/${trello || "main"}`);
    await interaction.reply({ ...responseWithEmbed("Audit channels saved and verified.", "Audit Channels Saved", "success"), ephemeral: true });
    return;
  }
  if (id === "setup-modal:blacklist") {
    const roleId = interaction.fields.getTextInputValue("role").trim();
    if (roleId && !/^\d{5,25}$/.test(roleId)) throw new Error("The role ID must contain only digits.");
    if (roleId) {
      const role = await guild.roles.fetch(roleId);
      if (!role) throw new Error("The selected blacklist role does not exist in this server.");
      validateModeratorRole(guild, role);
    }
    await saveSetupChange(guild, { ...setup, blacklistRoleId: roleId || undefined }, interaction.user.id, "Blacklisted Discord role", setup.blacklistRoleId ?? "None", roleId || "None");
    await interaction.reply({ ...responseWithEmbed("Blacklist role mapping saved and audited.", "Blacklist Role Saved", "success"), ephemeral: true });
    return;
  }
  if (id === "setup-modal:trello-interval") {
    const seconds = Number(interaction.fields.getTextInputValue("seconds"));
    if (!Number.isInteger(seconds) || seconds < 15 || seconds > 3600) {
      throw new Error("Polling interval must be a whole number from 15 to 3600 seconds.");
    }
    const current = { ...defaultMonitoringSettings(), ...setup.monitoring };
    const monitoring = { ...current, pollingIntervalSeconds: seconds };
    await saveSetupChange(guild, { ...setup, monitoring }, interaction.user.id, "Trello polling interval", String(current.pollingIntervalSeconds), String(seconds));
    scheduleBlacklistSync(guild, { ...setup, monitoring });
    await interaction.reply({ ...responseWithEmbed("Trello polling interval saved and applied.", "Polling Interval Saved", "success"), ephemeral: true });
    return;
  }
  if (id === "setup-modal:trello-lists" || id === "setup-modal:trello-labels" || id === "setup-modal:trello-group-label") {
    const current = trelloMappingsFor(setup);
    const lists = { ...current.lists };
    const labels = { ...current.labels };
    if (id === "setup-modal:trello-lists") {
      for (const key of ["appealable", "conditional", "permanent", "group", "revoked"] as const) {
        lists[key] = cleanText(interaction.fields.getTextInputValue(key), "Trello list name", 100);
      }
    } else if (id === "setup-modal:trello-labels") {
      for (const key of ["blacklisted", "appealable", "conditional", "permanent", "revoked"] as const) {
        labels[key] = cleanText(interaction.fields.getTextInputValue(key), "Trello label name", 100);
      }
    } else {
      labels.group = cleanText(interaction.fields.getTextInputValue("group"), "Trello label name", 100);
    }
    const trello = { lists, labels };
    await validateTrelloMappings(trello);
    await saveSetupChange(guild, { ...setup, trello }, interaction.user.id, "Trello list and label mappings", JSON.stringify(current), JSON.stringify(trello));
    await interaction.reply({ ...responseWithEmbed("Trello mapping was verified against the board, saved, and will be used by subsequent operations.", "Trello Mapping Saved", "success"), ephemeral: true });
  }
}

async function handleSettingsModal(interaction: ModalSubmitInteraction): Promise<void> {
  const { setup } = await requireSettingsSession(interaction);
  const guild = interaction.guild!;
  const id = interaction.customId.replace(/:([a-f0-9]{32})$/, "");
  const state = await getSecurityState(guild.id);
  const emergency = new Set([
    "settings-modal:maintenance-enable",
    "settings-modal:lockdown", "settings-modal:unlock",
  ]);
  if (state.maintenance.active && !emergency.has(id)) throw new Error(maintenanceMessage);

  if (id === "settings-modal:initial-audit") {
    if (setup) throw new Error("Setup is already complete.");
    const auditChannelId = interaction.fields.getTextInputValue("audit_channel_id").trim();
    if (!/^\d{5,25}$/.test(auditChannelId)) throw new Error("The audit channel ID must contain only numbers.");
    const initial: GuildSetup = {
      guildId: guild.id, moderatorRoleId: guild.id, auditChannelId,
      security: defaultSecuritySettings(), monitoring: defaultMonitoringSettings(),
      trello: defaultTrelloMappings(), audit: defaultAuditSettings(),
      identity: defaultIdentitySettings(),
      updatedBy: interaction.user.id, updatedAt: new Date().toISOString(),
    };
    await requireAuditChannel(guild, initial);
    await saveGuildSetup(initial);
    await sendAuditEvent(guild, initial, {
      action: "Bot setup completed", status: "success", actorId: interaction.user.id,
      fields: [{ name: "Audit channel", value: `<#${auditChannelId}> (${auditChannelId})` }],
    });
    await registerGuildCommands(guild, true);
    commandsRegistered = true;
    setupCommandRegistered = true;
    guildSetupComplete = true;
    setRecoveryStatus("successful");
    await interaction.reply({
      embeds: [outcomeEmbed("Setup Complete", "Audit logging is verified. /settings now contains all Quartermaster administration controls.", "success", [
        { name: "Audit Channel", value: `<#${auditChannelId}>` },
      ])],
      allowedMentions: noMentions,
      ephemeral: true,
    });
    await runGuildBlacklistSync(guild, "setup");
    return;
  }
  if (id === "settings-modal:maintenance-enable") {
    await createMaintenanceConfirmation(
      interaction,
      true,
      cleanText(interaction.fields.getTextInputValue("reason"), "Maintenance reason"),
    );
    return;
  }
  if (id === "settings-modal:lockdown") {
    const reason = cleanText(interaction.fields.getTextInputValue("reason"), "Reason");
    await requireCurrentAdministrator(guild, interaction.user.id, setup, "/settings lockdown");
    await mutateSecurityState(guild.id, (current) => {
      current.lockdown = { active: true, automatic: false, reason, startedAt: new Date().toISOString(), startedBy: interaction.user.id };
    });
    if (setup) await auditBestEffort(guild, setup, {
      action: "Security lockdown enabled", status: "success", actorId: interaction.user.id,
      fields: [{ name: "Reason", value: reason }],
    });
    await interaction.reply({
      embeds: [outcomeEmbed("Security Lockdown", "Security lockdown enabled. Monitoring and enforcement of existing records continue.", "warning")],
      allowedMentions: noMentions,
      ephemeral: true,
    });
    return;
  }
  if (id === "settings-modal:unlock") {
    const adapter = settingsActionAdapter(interaction, "security_unlock", {
      reason: interaction.fields.getTextInputValue("reason").trim() || "None",
    });
    await createConfirmation(adapter, "security_unlock");
    return;
  }
  if (!setup) throw new Error("Complete first-time setup before using this action.");
  if (id === "settings-modal:group") {
    const adapter = settingsActionAdapter(interaction, "group_blacklist", {
      id: cleanText(interaction.fields.getTextInputValue("id"), "Roblox group ID", 20),
      reason: cleanText(interaction.fields.getTextInputValue("reason"), "Reason"),
    });
    const security = securitySettingsFor(setup);
    if (security.confirmationsRequired) {
      await createConfirmation(adapter, "group_blacklist");
    } else {
      await reserveDestructiveAction(guild, interaction.user.id, setup, "group_blacklist");
      await requireTrelloReadiness(trelloMappingsFor(setup));
      await handleGroupBlacklist(adapter, setup);
    }
    return;
  }
  if (id === "settings-modal:note") {
    const note = cleanText(interaction.fields.getTextInputValue("note"), "Note");
    const username = interaction.fields.getTextInputValue("username").trim();
    const robloxUser = username ? await findRobloxUser(username) : undefined;
    await saveBlacklistNote({
      id: `${guild.id}:${interaction.user.id}:${Date.now()}`, guildId: guild.id,
      robloxUserId: robloxUser?.id, robloxUsername: robloxUser?.name,
      actorId: interaction.user.id, text: note, createdAt: new Date().toISOString(),
    });
    await auditBestEffort(guild, setup, {
      action: "Blacklist note recorded", status: "success", actorId: interaction.user.id,
      fields: [{ name: "Note", value: note }, { name: "Roblox username", value: robloxUser ? `${robloxUser.name} | ${robloxUser.id}` : "Not specified" }],
    });
    await interaction.reply({
      embeds: [outcomeEmbed("Blacklist Note", "Blacklist note durably recorded.", "success", [
        { name: "Roblox User", value: robloxUser ? `${safePresentationText(robloxUser.name)} (${displayId(robloxUser.id)})` : "Not specified" },
      ])],
      allowedMentions: noMentions,
      ephemeral: true,
    });
    return;
  }
  if (id === "settings-modal:identity-lookup") {
    const discordId = interaction.fields.getTextInputValue("discord_id").trim();
    const rawRoblox = interaction.fields.getTextInputValue("roblox_id").trim();
    const robloxId = rawRoblox ? Number(rawRoblox) : undefined;
    if (!discordId && !rawRoblox) throw new Error("Provide a Discord user ID or Roblox ID.");
    if (discordId && !/^\d{5,25}$/.test(discordId)) throw new Error("Discord user ID must contain only digits.");
    if (rawRoblox && (!Number.isSafeInteger(robloxId) || robloxId! <= 0)) throw new Error("Roblox ID must be a positive whole number.");
    const ledger = (await getSecurityState(guild.id)).identityLedger;
    const matches = ledger.filter((entry) => (!discordId || entry.discordUserId === discordId) &&
      (!robloxId || entry.robloxUserId === robloxId));
    await interaction.reply({
      embeds: [outcomeEmbed("Identity Lookup", matches.length ? "Recorded identity associations found." : "No recorded identity associations found.", "info", matches.slice(0, 25).map((entry) => ({
        name: `${displayId(entry.discordUserId)} ↔ ${displayId(entry.robloxUserId)}`,
        value: `Observed ${readableDate(entry.observedAt)}`,
      })))],
      allowedMentions: noMentions,
      ephemeral: true,
    });
  }
}

async function createConfirmation(
  interaction: ChatInputCommandInteraction,
  command: "blacklist" | "group_blacklist" | "revoke_blacklist" | "security_unlock",
): Promise<void> {
  let target: { discordUserId: string; robloxUserId: number; robloxUsername: string; cardId?: string } | undefined;
  if (command === "blacklist" || command === "revoke_blacklist") {
    const username = interaction.options.getString(command === "blacklist" ? "user" : "username", true);
    const robloxUser = await findRobloxUser(username);
    const snapshot = command === "revoke_blacklist"
      ? await findPendingOrActiveSnapshot(interaction.guild!.id, robloxUser.id)
      : undefined;
    const member = snapshot
      ? undefined
      : await resolveMember(interaction, robloxUser.name);
    target = {
      discordUserId: snapshot?.discordUserId ?? member!.id,
      robloxUserId: robloxUser.id,
      robloxUsername: robloxUser.name,
    };
    if (command === "revoke_blacklist") {
      const setup = await getGuildSetup(interaction.guild!.id);
      if (!setup) throw new Error("Complete setup before revoking a blacklist.");
      if (snapshot?.status === "revocation_pending" && snapshot.cardId) {
        target.cardId = snapshot.cardId;
      } else {
        const card = await findBlacklistCardByRobloxId(robloxUser.id, trelloMappingsFor(setup));
        if (!card || card.listType === "revoked") throw new Error("No active Trello blacklist card was found for this Roblox user.");
        target.cardId = card.id;
      }
    }
  }
  const id = crypto.randomUUID().replaceAll("-", "");
  confirmations.set(id, { userId: interaction.user.id, guildId: interaction.guild!.id, command, original: interaction, target, expiresAt: Date.now() + setupSessionLifetimeMs });
  await interaction.editReply({
    content: "",
    embeds: [outcomeEmbed("Confirm Action", `Review the requested /${command} operation. Your current Administrator permission will be checked again before execution.`, "warning", target ? [
      { name: "Roblox User", value: `${safePresentationText(target.robloxUsername)} (${displayId(target.robloxUserId)})` },
      { name: "Discord Member", value: displayId(target.discordUserId) },
    ] : undefined)],
    allowedMentions: noMentions,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`confirm:${id}`).setLabel("Confirm").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`cancel:${id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    )],
  });
}

async function createMaintenanceConfirmation(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  active: boolean,
  reason: string,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new Error("Maintenance is only available in a server.");
  const state = await getSecurityState(guild.id);
  if (state.maintenance.active !== !active) {
    throw new Error(active
      ? "Maintenance mode is already enabled."
      : "Maintenance mode is already disabled.");
  }
  // Discord custom IDs are limited to 100 characters; compact the internal
  // token while retaining a cryptographically random, user/guild-bound nonce.
  const id = crypto.randomUUID().replaceAll("-", "");
  maintenanceConfirmations.set(id, {
    userId: interaction.user.id,
    guildId: guild.id,
    active,
    revision: state.maintenance.revision,
    reason,
    expiresAt: Date.now() + setupSessionLifetimeMs,
    original: interaction,
  });
  const payload = {
    content: "",
    embeds: [outcomeEmbed(
      active ? "Enable Maintenance" : "Disable Maintenance",
      `${active
        ? "Normal commands will be disabled while background blacklist protection continues."
        : "Normal command operation will be restored."}\n\nYour current Administrator permission will be checked again.`,
      "warning",
      [{ name: "Reason", value: safePresentationText(reason || "None") }],
    )],
    allowedMentions: noMentions,
    ephemeral: true,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`maintenance-confirm:${id}`).setLabel(
        active ? "Enable Maintenance" : "Disable Maintenance",
      ).setStyle(active ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`maintenance-cancel:${id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    )],
  };
  if ("isModalSubmit" in interaction && interaction.isModalSubmit()) await interaction.reply(payload);
  else await interaction.editReply(payload);
}

async function completeMaintenanceChange(
  guild: Guild,
  actorId: string,
  active: boolean,
  revision: number,
  reason: string,
  setup?: GuildSetup,
): Promise<void> {
  let priorStartedAt: string | null = null;
  let durationSeconds: number | null = null;
  await withGuildBlacklistLifecycleLock(guild.id, async () => {
    // This check is deliberately inside the action queue: a user who loses
    // Administrator while waiting behind a blacklist lifecycle action cannot
    // commit a maintenance transition afterward.
    await requireCurrentAdministrator(guild, actorId, setup, "/maintenance confirmation");
    await mutateSecurityState(guild.id, (state) => {
      if (state.maintenance.revision !== revision || state.maintenance.active === active) {
        throw new Error("This maintenance confirmation is stale because maintenance state has changed.");
      }
      priorStartedAt = state.maintenance.startedAt;
      durationSeconds = active
        ? 0
        : priorStartedAt
          ? Math.max(0, Math.round((Date.now() - Date.parse(priorStartedAt)) / 1000))
          : null;
      const at = new Date().toISOString();
      state.maintenance = {
        active,
        reason: active ? reason : "",
        startedAt: active ? at : null,
        startedBy: active ? actorId : null,
        revision: state.maintenance.revision + 1,
      };
      state.maintenanceAudit.push({
        active,
        actorId,
        reason: reason || "None",
        at,
        durationSeconds,
      });
      state.maintenanceAudit = state.maintenanceAudit.slice(-100);
    });
  });
  invalidateGuildInteractiveState(guild.id);
  if (setup) {
    const duration = durationSeconds !== null
      ? active ? "0 seconds (started)" : `${durationSeconds} seconds`
      : "Unknown";
    await auditBestEffort(guild, setup, {
      action: active ? "Maintenance mode enabled" : "Maintenance mode disabled",
      status: "success",
      actorId,
      fields: [
        { name: "Reason", value: reason || "None" },
        { name: "Duration", value: duration },
      ],
    });
  }
}

async function handleMaintenanceConfirmation(interaction: ButtonInteraction): Promise<void> {
  const [, id] = interaction.customId.split(/:(.+)/);
  const pending = id ? maintenanceConfirmations.get(id) : undefined;
  if (!pending || pending.expiresAt <= Date.now() || pending.userId !== interaction.user.id ||
      pending.guildId !== interaction.guildId || !interaction.guild) {
    throw new Error("This maintenance confirmation has expired or belongs to another administrator.");
  }
  maintenanceConfirmations.delete(id!);
  if (interaction.customId.startsWith("maintenance-cancel:")) {
    await interaction.update({
      ...responseWithEmbed("Maintenance change cancelled.", "Maintenance Change Cancelled", "info"),
      components: [],
    });
    return;
  }
  const setup = await getGuildSetup(pending.guildId);
  await interaction.deferUpdate();
  await completeMaintenanceChange(
    interaction.guild,
    interaction.user.id,
    pending.active,
    pending.revision,
    pending.reason,
    setup,
  );
  await pending.original.editReply({
    content: "",
    embeds: [outcomeEmbed(
      pending.active ? "Maintenance Enabled" : "Maintenance Disabled",
      pending.active
        ? "Normal commands are now unavailable. Background blacklist protection continues."
        : "Normal command operation has been restored.",
      "success",
      [{ name: "Reason", value: safePresentationText(pending.reason || "None") }],
    )],
    allowedMentions: noMentions,
    components: [],
  });
}

async function completeSecurityUnlock(
  guild: Guild,
  actorId: string,
  setup: GuildSetup | undefined,
  reason: string,
): Promise<void> {
  await requireCurrentAdministrator(guild, actorId, setup, "/security_unlock confirmation");
  const prior = await getSecurityState(guild.id);
  await mutateSecurityState(guild.id, (state) => {
    state.lockdown = { active: false, automatic: false, reason: "", startedAt: null, startedBy: null };
  });
  if (setup) await auditBestEffort(guild, setup, {
    action: "Security lockdown unlocked", status: "success", actorId,
    fields: [
      { name: "Duration", value: prior.lockdown.startedAt ? `${Math.max(0, Math.round((Date.now() - Date.parse(prior.lockdown.startedAt)) / 1000))} seconds` : "Unknown" },
      { name: "Reason", value: reason || "None" },
    ],
  });
}

async function handleConfirmation(interaction: ButtonInteraction): Promise<void> {
  const [, id] = interaction.customId.split(/:(.+)/);
  const pending = id ? confirmations.get(id) : undefined;
  if (!pending || pending.expiresAt <= Date.now() || pending.userId !== interaction.user.id || pending.guildId !== interaction.guildId) {
    throw new Error("This confirmation has expired or belongs to another administrator.");
  }
  confirmations.delete(id!);
  if (interaction.customId.startsWith("cancel:")) {
    await interaction.update({
      ...responseWithEmbed("Action cancelled.", "Action Cancelled", "info"),
      components: [],
    });
    return;
  }
  const setup = await getGuildSetup(pending.guildId);
  if (!interaction.guild) throw new Error("Bot setup is unavailable.");
  await requireCurrentAdministrator(interaction.guild, interaction.user.id, setup, `/${pending.command} confirmation`);
  await interaction.deferUpdate();
  if (pending.command === "security_unlock") {
    await completeSecurityUnlock(
      interaction.guild,
      interaction.user.id,
      setup,
      pending.original.options.getString("reason")?.trim() || "None",
    );
    await pending.original.editReply({
      ...responseWithEmbed("Security lockdown has been unlocked.", "Security Lockdown Unlocked", "success"),
      components: [],
    });
    return;
  }
  if (!setup) throw new Error("Complete first-time setup before this moderation action.");
  await reserveDestructiveAction(interaction.guild, interaction.user.id, setup, pending.command);
  await requireTrelloReadiness(trelloMappingsFor(setup));
  if (pending.command === "blacklist") await handleBlacklist(pending.original, setup, pending.target);
  else if (pending.command === "group_blacklist") await handleGroupBlacklist(pending.original, setup);
  else await handleRevoke(pending.original, setup, pending.target);
}

export async function handleSetup(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild!;
  const member = await interactionMember(interaction);
  if (
    guild.ownerId !== member.id &&
    !member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    throw new Error(
      "Only the server owner or an administrator can run /settings.",
    );
  }

  const previous = await getGuildSetup(guild.id);
  const selectedRole = interaction.options.getRole("role");
  const selectedAuditChannel = interaction.options.getString("audit_channel_id");
  if (!selectedRole && !selectedAuditChannel && previous) {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const response = await interaction.editReply(setupMenu(nonce));
    setupSessions.set(setupSessionId(guild.id, interaction.user.id), {
      userId: interaction.user.id,
      guildId: guild.id,
      expiresAt: Date.now() + setupSessionLifetimeMs,
      messageId: response?.id,
      nonce,
    });
    return;
  }
  if (!selectedAuditChannel && !previous) {
    throw new Error("Choose an audit channel ID for first-time setup, then use /setup to open the interactive settings.");
  }
  const role = selectedRole ? await guild.roles.fetch(selectedRole.id) : null;
  if (role) validateModeratorRole(guild, role);
  const auditChannelId = (selectedAuditChannel ?? previous?.auditChannelId ?? "").trim();
  if (!/^\d{5,25}$/.test(auditChannelId)) throw new Error("The audit channel ID must contain only numbers.");
  const setup: GuildSetup = {
    guildId: guild.id,
    moderatorRoleId: role?.id ?? previous?.moderatorRoleId ?? guild.id,
    auditChannelId,
    security: previous?.security ?? defaultSecuritySettings(),
    monitoring: previous?.monitoring ?? defaultMonitoringSettings(),
    trello: previous?.trello ?? defaultTrelloMappings(),
    audit: previous?.audit ?? defaultAuditSettings(),
    identity: previous?.identity ?? defaultIdentitySettings(),
    updatedBy: interaction.user.id,
    updatedAt: new Date().toISOString(),
  };

  await requireAuditChannel(guild, setup);
  await saveGuildSetup(setup);
  await sendAuditEvent(guild, setup, {
    action: previous ? "Bot setup updated" : "Bot setup completed",
    status: "success",
    actorId: interaction.user.id,
    fields: [
      {
        name: "Authorization",
        value: "Current Discord Administrator permission required",
      },
      {
        name: "Audit channel",
        value: `<#${auditChannelId}> (${auditChannelId})`,
      },
      ...(previous
        ? [
            {
              name: "Previous configuration",
              value: `Role: ${previous.moderatorRoleId}\nChannel: ${previous.auditChannelId}`,
            },
          ]
        : []),
    ],
  });

  await registerGuildCommands(guild, true);
  commandsRegistered = true;
  setupCommandRegistered = true;
  guildSetupComplete = true;
  setRecoveryStatus("successful");
  await interaction.editReply(
      responseWithEmbed(
        `Setup complete. Only current Discord Administrators can use administrative commands. Audits will be sent to <#${auditChannelId}>.`,
        "Setup Complete",
        "success",
        "Quartermaster is ready for administration in this server.",
        [
          { name: "Audit Channel", value: `<#${auditChannelId}>` },
          { name: "Authorization", value: "Current Discord Administrator permission only" },
        ],
      ),
  );
  await runGuildBlacklistSync(guild, "setup");
}

async function handleBlacklistUnlocked(
  interaction: ChatInputCommandInteraction,
  setup?: GuildSetup,
  boundTarget?: { discordUserId: string; robloxUserId: number; robloxUsername: string },
): Promise<void> {
  const username = interaction.options.getString("user", true);
  const type = interaction.options.getString("type", true) as BlacklistType;
  const reason = interaction.options.getString("reason", true).trim();
  const robloxUser = boundTarget
    ? { id: boundTarget.robloxUserId, name: boundTarget.robloxUsername }
    : await findRobloxUser(username);
  const member = boundTarget
    ? await interaction.guild!.members.fetch(boundTarget.discordUserId)
    : await resolveMember(interaction, robloxUser.name);
  if (setup) await protectTarget(interaction.guild!, member, setup);
  if (setup) await validateBlacklistRoleForAction(interaction.guild!, setup);
  const existing = await findPendingOrActiveSnapshot(
    interaction.guild!.id,
    robloxUser.id,
  );

  if (existing) {
    throw new Error(`${robloxUser.name} already has an active blacklist snapshot.`);
  }

  const plannedRoleIds = getRemovableRoleIds(member).changed;
  const roleSummary = describeRoles(member, plannedRoleIds);
  const key = keyFor(interaction.guild!.id, robloxUser.id);
  const mappings = setup ? trelloMappingsFor(setup) : undefined;
  const matchingCards = await findBlacklistCardsByRobloxId(
    robloxUser.id,
    mappings,
  );
  const activeCards = matchingCards.filter((card) => card.listType !== "revoked");
  if (activeCards.length > 0) {
    throw new Error(
      `${robloxUser.name} already has an active Trello blacklist card for Roblox account ${robloxUser.id}.`,
    );
  }
  if (matchingCards.length > 1) {
    throw new Error(
      `Multiple revoked Trello blacklist cards match Roblox account ${robloxUser.id}; resolve the duplicate cards before blacklisting again.`,
    );
  }
  const revokedCard = matchingCards[0];
  let createdCard:
    | Awaited<ReturnType<typeof createBlacklistCard>>
    | undefined;
  const reusedRevokedCard = Boolean(revokedCard);

  try {
    createdCard = revokedCard
      ? await reactivateBlacklistCardById(revokedCard.id, {
          robloxId: robloxUser.id,
          robloxUsername: robloxUser.name,
          type,
          reason,
          mappings,
        })
      : await createBlacklistCard({
          name: `${robloxUser.name} | ${robloxUser.id}`,
          type,
          reason,
          mappings,
        });
    await saveRoleSnapshot({
      key,
      guildId: interaction.guild!.id,
      discordUserId: member.id,
      robloxUserId: robloxUser.id,
      robloxUsername: robloxUser.name,
      roleIds: plannedRoleIds,
      cardId: createdCard.id,
      cardUrl: createdCard.url,
      blacklistType: type,
      blacklistReason: reason,
      source: "command",
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    if (setup) {
      await auditBestEffort(interaction.guild!, setup, {
        action: reusedRevokedCard
          ? "Revoked Trello blacklist card reactivated"
          : "Trello blacklist card created",
        status: "success",
        actorId: interaction.user.id,
        target: `<@${member.id}> (${member.id})`,
        fields: [
          { name: "Roblox user", value: `${robloxUser.name} | ${robloxUser.id}` },
          { name: "Blacklist type", value: type, inline: true },
          { name: "Reason", value: reason },
          {
            name: "Trello card",
            value: `${createdCard.id}\n${createdCard.url}`,
          },
        ],
      });
    }

    const roleIds = await withMemberRoleLock(interaction.guild!.id, member.id, async () => {
      const removed = (await removeAssignableRoles(member)).changed;
      if (setup?.blacklistRoleId) {
        const blacklistRole = await interaction.guild!.roles.fetch(setup.blacklistRoleId);
        if (!blacklistRole) throw new Error("The configured blacklisted role no longer exists.");
        const botMember = interaction.guild!.members.me;
        if (blacklistRole.managed || !botMember || blacklistRole.position >= botMember.roles.highest.position) {
          throw new Error("The configured blacklisted role is not assignable by the bot.");
        }
        if (!member.roles.cache.has(blacklistRole.id)) {
          await member.roles.add(blacklistRole, "Roblox blacklist");
        }
      }
      return removed;
    });
    const associations = await recordIdentityAssociation(interaction.guild!.id, member.id, robloxUser.id);
    const identity = { ...defaultIdentitySettings(), ...setup?.identity };
    const warnings = associations.warnings.filter((warning) =>
      identity.historicalAssociationWarnings &&
      ((warning === "same_discord_different_roblox" && identity.sameDiscordDifferentRoblox) ||
        (warning === "same_roblox_different_discord" && identity.sameRobloxDifferentDiscord)),
    );
    if (warnings.length && setup) {
      await auditBestEffort(interaction.guild!, setup, {
        action: "Identity association warning",
        status: "failed",
        actorId: interaction.user.id,
        target: `<@${member.id}> (${member.id})`,
        fields: [{ name: "Result", value: warnings.map((warning) =>
          warning === "same_discord_different_roblox"
            ? "Same Discord account is associated with another Roblox identity."
            : "Same Roblox identity is associated with another Discord account.",
        ).join("\n") }],
      });
    }
    if (setup) {
      await auditBestEffort(interaction.guild!, setup, {
        action: "Discord roles removed",
        status: "success",
        actorId: interaction.user.id,
        target: `<@${member.id}> (${member.id})`,
        fields: [
          {
            name: "Roblox user",
            value: `${robloxUser.name} | ${robloxUser.id}`,
          },
          { name: "Roles removed", value: describeRoles(member, roleIds) },
        ],
      });
    }
    await saveRoleSnapshot({
      key,
      guildId: interaction.guild!.id,
      discordUserId: member.id,
      robloxUserId: robloxUser.id,
      robloxUsername: robloxUser.name,
      // Retain the original snapshot, even when a later enforcement attempt
      // could only remove part of the member's current roles.
      roleIds: plannedRoleIds,
      cardId: createdCard.id,
      cardUrl: createdCard.url,
      blacklistType: type,
      blacklistReason: reason,
      source: "command",
      blacklistNotificationAttemptedAt: new Date().toISOString(),
      status: "active",
      createdAt: new Date().toISOString(),
    });

    try {
      await member.send({
        content: "",
        embeds: [presentationEmbed(
          "Blacklist Notice",
          "Your access to this server has been restricted and a Trello record was created.",
          "warning",
          botAvatarUrl(),
          [
            { name: "Roblox User", value: `${safePresentationText(robloxUser.name)} (${displayId(robloxUser.id)})` },
            { name: "Trello Record", value: `[Open card](${createdCard.url})\n${displayId(createdCard.id)}` },
          ],
        )],
        allowedMentions: noMentions,
      });
    } catch {
      if (setup) {
        await auditBestEffort(interaction.guild!, setup, {
          action: "Blacklist DM could not be delivered",
          status: "failed",
          actorId: interaction.user.id,
          target: `<@${member.id}> (${member.id})`,
          fields: [
            {
              name: "Trello card",
              value: `${createdCard.id}\n${createdCard.url}`,
            },
          ],
        });
      }
    }

    if (setup) {
      await auditBestEffort(interaction.guild!, setup, {
        action: "User blacklist completed",
        status: "success",
        actorId: interaction.user.id,
        target: `<@${member.id}> (${member.id})`,
        fields: [
          { name: "Roblox user", value: `${robloxUser.name} | ${robloxUser.id}` },
          { name: "Roles removed", value: roleSummary },
          {
            name: "Trello card",
            value: `${createdCard.id}\n${createdCard.url}`,
          },
        ],
      });
    }
    await interaction.editReply({
      content: "",
      embeds: [outcomeEmbed("Blacklist Completed", "The Roblox user was recorded and Discord role enforcement completed.", "success", [
        { name: "Roblox User", value: `${safePresentationText(robloxUser.name)} (${displayId(robloxUser.id)})`, inline: true },
        { name: "Roles Removed", value: String(roleIds.length), inline: true },
        { name: "Trello Card", value: `[Open card](${createdCard.url})\n${displayId(createdCard.id)}` },
      ])],
      allowedMentions: noMentions,
    });
  } catch (error) {
    if (setup) {
      await auditBestEffort(interaction.guild!, setup, {
        action: "Blacklist command did not finish",
        status: "failed",
        actorId: interaction.user.id,
        target: `<@${member.id}> (${member.id})`,
        fields: [
          { name: "Roblox user", value: `${robloxUser.name} | ${robloxUser.id}` },
          {
            name: "Result",
            value: createdCard
              ? reusedRevokedCard
                ? "The existing Trello card was updated; synchronization will retry role enforcement."
                : "The Trello card exists and synchronization will retry role enforcement."
              : "No Trello blacklist card was created and no roles were changed.",
          },
        ],
      });
    }
    throw error;
  }
}

export function handleBlacklist(
  interaction: ChatInputCommandInteraction,
  setup?: GuildSetup,
  boundTarget?: { discordUserId: string; robloxUserId: number; robloxUsername: string },
): Promise<void> {
  return withGuildBlacklistLifecycleLock(interaction.guild!.id, async () => {
    if (await maintenanceActive(interaction.guild!.id)) {
      throw new Error("Bot maintenance mode is active. Commands are temporarily unavailable.");
    }
    return handleBlacklistUnlocked(interaction, setup, boundTarget);
  });
}

async function handleGroupBlacklistUnlocked(
  interaction: ChatInputCommandInteraction,
  setup: GuildSetup,
): Promise<void> {
  const groupId = interaction.options.getString("id", true);
  const reason = interaction.options.getString("reason", true).trim();
  await validateBlacklistRoleForAction(interaction.guild!, setup);
  const groupUrl = getRobloxGroupUrl(groupId);
  const card = await createGroupBlacklistCard({
    groupUrl,
    reason,
    mappings: trelloMappingsFor(setup),
  });

  await auditBestEffort(interaction.guild!, setup, {
    action: "Group blacklist card created",
    status: "success",
    actorId: interaction.user.id,
    target: groupUrl,
    fields: [
      { name: "Reason", value: reason },
      { name: "Trello card", value: `${card.id}\n${card.url}` },
    ],
  });
  await interaction.editReply({
    content: "",
    embeds: [outcomeEmbed("Group Blacklist Completed", "The Roblox group was recorded in Trello.", "success", [
      { name: "Group", value: `[Open group](${groupUrl})` },
      { name: "Trello Card", value: `[Open card](${card.url})\n${displayId(card.id)}` },
    ])],
    allowedMentions: noMentions,
  });
}

function handleGroupBlacklist(
  interaction: ChatInputCommandInteraction,
  setup: GuildSetup,
): Promise<void> {
  return withGuildBlacklistLifecycleLock(interaction.guild!.id, async () => {
    if (await maintenanceActive(interaction.guild!.id)) {
      throw new Error("Bot maintenance mode is active. Commands are temporarily unavailable.");
    }
    return handleGroupBlacklistUnlocked(interaction, setup);
  });
}

async function handleRevokeUnlocked(
  interaction: ChatInputCommandInteraction,
  setup: GuildSetup,
  boundTarget?: { discordUserId: string; robloxUserId: number; robloxUsername: string; cardId?: string },
): Promise<void> {
  const username = interaction.options.getString("username", true);
  const robloxUser = boundTarget
    ? { id: boundTarget.robloxUserId, name: boundTarget.robloxUsername }
    : await findRobloxUser(username);
  const guild = interaction.guild!;
  const snapshot = await findPendingOrActiveSnapshot(guild.id, robloxUser.id);
  // A role snapshot is an immutable account binding. A departed member does
  // not invalidate a revocation approval: role restoration completes on join.
  const member = snapshot
    ? await guild.members.fetch(snapshot.discordUserId).catch(() => undefined)
    : undefined;
  await validateBlacklistRoleForAction(interaction.guild!, setup);
  const mappings = trelloMappingsFor(setup);
  let pending = snapshot;
  if (pending?.status !== "revocation_pending") {
    const card = await findBlacklistCardByRobloxId(robloxUser.id, mappings);
    if (!card || card.listType === "revoked" || (boundTarget?.cardId && card.id !== boundTarget.cardId)) {
      throw new Error(
        `No active Trello blacklist card was found for ${robloxUser.name} (${robloxUser.id}).`,
      );
    }
    if (!pending) {
      await revokeBlacklistCardById(card.id, mappings);
      await auditBestEffort(guild, setup, {
        action: "Trello blacklist card moved to revoked",
        status: "success",
        actorId: interaction.user.id,
        fields: [{ name: "Trello card", value: `${card.id}\n${card.url}` }],
      });
      await interaction.editReply({
        content: "",
        embeds: [outcomeEmbed("Blacklist Revoked", "The Trello record was revoked. No saved Discord role snapshot was available.", "success", [
          { name: "Roblox User", value: `${safePresentationText(robloxUser.name)} (${displayId(robloxUser.id)})` },
          { name: "Roles Restored", value: "None; no saved snapshot" },
        ])],
        allowedMentions: noMentions,
      });
      return;
    }
    // Persist the administrator's approval and exact card before contacting
    // Trello. A provider failure consequently leaves Discord restrictions on.
    pending = {
      ...pending,
      cardId: card.id,
      cardUrl: card.url,
      cardUpdatedAt: card.dateLastActivity,
      status: "revocation_pending",
    };
    await saveRoleSnapshot(pending);
  }
  if (!pending.cardId || (boundTarget?.cardId && pending.cardId !== boundTarget.cardId)) {
    throw new Error("The saved revocation approval no longer matches the selected Trello card.");
  }
  const result = await processApprovedRevocation(guild, setup, pending, member);
  await auditBestEffort(interaction.guild!, setup, {
    action: "Trello blacklist card moved to revoked",
    status: "success",
    actorId: interaction.user.id,
    target: `<@${pending.discordUserId}> (${pending.discordUserId})`,
    fields: [
      { name: "Roblox user", value: `${robloxUser.name} | ${robloxUser.id}` },
      { name: "Trello card", value: pending.cardId },
    ],
  });
  if (result.completed && member) {
    await auditBestEffort(interaction.guild!, setup, {
      action: "Discord roles restored",
      status: "success",
      actorId: interaction.user.id,
      target: `<@${member.id}> (${member.id})`,
      fields: [
        {
          name: "Roles restored",
          value: describeRoles(member, result.restored),
        },
      ],
    });
  }
  await auditBestEffort(interaction.guild!, setup, {
    action: "User blacklist revoked",
    status: "success",
    actorId: interaction.user.id,
    target: `<@${pending.discordUserId}> (${pending.discordUserId})`,
    fields: [
      { name: "Roblox user", value: `${robloxUser.name} | ${robloxUser.id}` },
      {
        name: "Roles restored",
        value: member ? describeRoles(member, result.restored) : "Member absent; pending join",
      },
      { name: "Trello card", value: pending.cardId },
    ],
  });
  await interaction.editReply({
    content: "",
    embeds: [outcomeEmbed(
      result.completed ? "Blacklist Revoked" : "Revocation Pending",
      result.completed
        ? "The blacklist was revoked and saved roles were restored."
        : "The revocation is approved, but Discord role restoration is still pending.",
      result.completed ? "success" : "warning",
      [
        { name: "Roblox User", value: `${safePresentationText(robloxUser.name)} (${displayId(robloxUser.id)})` },
        { name: "Roles Restored", value: member ? String(result.restored.length) : "Pending member availability" },
        { name: "Trello Card", value: displayId(pending.cardId) },
      ],
    )],
    allowedMentions: noMentions,
  });
}

function handleRevoke(
  interaction: ChatInputCommandInteraction,
  setup: GuildSetup,
  boundTarget?: { discordUserId: string; robloxUserId: number; robloxUsername: string; cardId?: string },
): Promise<void> {
  return withGuildBlacklistLifecycleLock(interaction.guild!.id, async () => {
    if (await maintenanceActive(interaction.guild!.id)) {
      throw new Error("Bot maintenance mode is active. Commands are temporarily unavailable.");
    }
    return handleRevokeUnlocked(interaction, setup, boundTarget);
  });
}

async function handleInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({
      content: "",
      embeds: [outcomeEmbed("Server Only", "Quartermaster commands can only be used inside the configured server.", "error")],
      allowedMentions: noMentions,
      ephemeral: true,
    });
    return;
  }
  if (config.discordGuildId && interaction.guild.id !== config.discordGuildId) {
    await interaction.reply({
      ...errorResponse("This command is only available in the configured server.", "Wrong Server"),
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // This is intentionally the first command decision after acknowledging the
  // interaction. It precedes setup reads, provider calls, audit writes, and
  // destructive rate reservations, so a locked command cannot have side
  // effects or consume a rate-limit slot.
  let initialSecurityState: SecurityState;
  try {
    initialSecurityState = await getSecurityState(interaction.guild.id);
  } catch (error) {
    const message = `Could not complete the command: ${error instanceof Error ? error.message : "Security state is unavailable."}`;
    await interaction.editReply(errorResponse(message, "Security State Unavailable"));
    return;
  }
  if (
    initialSecurityState.maintenance.active &&
    !maintenanceAllowedCommands.has(interaction.commandName)
  ) {
    await interaction.editReply(responseWithEmbed(
      maintenanceMessage,
      "Maintenance Active",
      "warning",
      "Normal commands are temporarily unavailable. Background blacklist protection continues.",
    ));
    return;
  }

  if (interaction.commandName === "settings") {
    try {
      await handleSettings(interaction);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not open settings.";
      await interaction.editReply(errorResponse(message, "Settings Unavailable"));
    }
    return;
  }

  if (interaction.commandName === "maintenance") {
    try {
      const setup = await getGuildSetup(interaction.guild.id);
      await requireCurrentAdministrator(interaction.guild, interaction.user.id, setup, "/maintenance");
      const mode = interaction.options.getString("mode", true);
      if (mode !== "enable" && mode !== "disable") throw new Error("Maintenance mode must be enable or disable.");
      const rawReason = interaction.options.getString("reason")?.trim() ?? "";
      if (mode === "enable" && !rawReason) {
        throw new Error("A maintenance reason is required when enabling maintenance mode.");
      }
      const reason = rawReason ? cleanText(rawReason, "Reason") : "";
      await createMaintenanceConfirmation(interaction, mode === "enable", reason);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not prepare maintenance mode.";
      await interaction.editReply(errorResponse(message, "Maintenance Request Failed"));
    }
    return;
  }

  if (interaction.commandName === "security_status") {
    try {
      const setup = await getGuildSetup(interaction.guild.id);
      await requireCurrentAdministrator(interaction.guild, interaction.user.id, setup, "/security_status");
      const state = await getSecurityState(interaction.guild.id);
      const settings = setup ? securitySettingsFor(setup) : defaultSecuritySettings();
      const trello = getTrelloReadiness();
      const recentActions = state.destructiveActions.filter(
        (entry) => Date.parse(entry.at) >= Date.now() - settings.windowMinutes * 60_000,
      ).length;
      const operationalState = state.maintenance.active
        ? `Maintenance: ENABLED${state.maintenance.reason ? ` — ${state.maintenance.reason}` : ""}`
        : state.lockdown.active
          ? `Security lockdown: LOCKED${state.lockdown.reason ? ` — ${state.lockdown.reason}` : ""}`
          : !setup || !guildSetupComplete || !commandsRegistered
            ? "Bot state: SETUP REQUIRED OR COMMANDS UNREGISTERED"
            : !trello.ready
              ? `Trello: UNAVAILABLE${trello.error ? ` — ${trello.error}` : ""}`
              : "Bot state: ENABLED";
      const blacklistCommandState = state.maintenance.active
        ? "DISABLED — MAINTENANCE"
        : state.lockdown.active
          ? "DISABLED — SECURITY LOCKDOWN"
          : !setup || !guildSetupComplete || !commandsRegistered
            ? "DISABLED — SETUP/REGISTRATION"
            : !trello.ready
              ? "DISABLED — TRELLO UNAVAILABLE"
              : "ENABLED";
      await interaction.editReply({
        content: "",
        embeds: [outcomeEmbed("System Status", "Current command availability and protection state.", state.maintenance.active || state.lockdown.active ? "warning" : "success", [
          { name: "Operational State", value: safePresentationText(operationalState) },
          { name: "Security", value: `${state.lockdown.active ? "Locked" : "Unlocked"}; ${recentActions}/${settings.globalLimit} actions in ${settings.windowMinutes} minutes.` },
          { name: "Maintenance", value: state.maintenance.active ? `Enabled since ${readableDate(state.maintenance.startedAt)}` : "Disabled" },
          { name: "Blacklist Commands", value: blacklistCommandState },
          { name: "Trello Readiness", value: trello.ready ? "Ready" : trello.status.toUpperCase() },
        ])],
        allowedMentions: noMentions,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not read security status.";
      await interaction.editReply(errorResponse(message, "Security Status Unavailable"));
    }
    return;
  }

  if (interaction.commandName === "setup") {
    try {
      await handleSetup(interaction);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The setup command failed unexpectedly.";
      const previousSetup = await getGuildSetup(interaction.guild.id).catch(
        () => undefined,
      );
      if (previousSetup) {
        await auditBestEffort(interaction.guild, previousSetup, {
          action: "Bot setup failed",
          status: "failed",
          actorId: interaction.user.id,
          fields: [
            {
              name: "Result",
              value: "Setup was not activated. Check the private command reply.",
            },
          ],
        });
      }
      logger.error(
        { err: error, guildId: interaction.guild.id },
        "Bot setup command failed",
      );
      await interaction.editReply(errorResponse(`Could not complete setup: ${message}`, "Setup Failed"));
    }
    return;
  }

  const setup = await getGuildSetup(interaction.guild.id).catch(() => undefined);
  if (!setup) {
    await interaction.editReply(errorResponse(
      "This server has not completed bot setup. Ask the server owner or an administrator to run /settings first.",
      "Setup Required",
    ));
    return;
  }

  try {
    await validateGuildSetup(interaction.guild, setup);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The saved setup is invalid.";
    await interaction.editReply(errorResponse(`Moderation commands are disabled: ${message}`, "Moderation Unavailable"));
    return;
  }

  try {
    await requireCurrentAdministrator(interaction.guild, interaction.user.id, setup, `/${interaction.commandName}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Administrative access denied.";
    await interaction.editReply(errorResponse(message, "Administrative Access Denied"));
    return;
  }

  try {
    await sendAuditEvent(interaction.guild, setup, {
      action: "Moderation command started",
      status: "started",
      actorId: interaction.user.id,
      fields: [{ name: "Command", value: `/${interaction.commandName}` }],
    });
    if (destructiveCommands.has(interaction.commandName)) {
      const command = interaction.commandName as "blacklist" | "group_blacklist" | "revoke_blacklist";
      const security = securitySettingsFor(setup);
      if (security.confirmationsRequired) {
        await createConfirmation(interaction, command);
        return;
      }
      await reserveDestructiveAction(interaction.guild, interaction.user.id, setup, command);
      await requireTrelloReadiness(trelloMappingsFor(setup));
      if (command === "blacklist") await handleBlacklist(interaction, setup);
      else if (command === "group_blacklist") await handleGroupBlacklist(interaction, setup);
      else await handleRevoke(interaction, setup);
    } else if (interaction.commandName === "security_status") {
      const state = await getSecurityState(interaction.guild.id);
      const settings = securitySettingsFor(setup);
      await interaction.editReply(responseWithEmbed(
        `Security: ${state.lockdown.active ? "LOCKED" : "unlocked"}; ${state.destructiveActions.length}/${settings.globalLimit} destructive actions in the current ${settings.windowMinutes}-minute window.`,
        "Security Status",
        state.lockdown.active ? "warning" : "success",
        "Current security lockdown and destructive-action usage.",
        [
          { name: "Lockdown", value: state.lockdown.active ? "Locked" : "Unlocked", inline: true },
          { name: "Action Window", value: `${state.destructiveActions.length}/${settings.globalLimit} actions in ${settings.windowMinutes} minutes`, inline: true },
        ],
      ));
    } else if (interaction.commandName === "security_lockdown") {
      const reason = cleanText(interaction.options.getString("reason", true), "Reason");
      await mutateSecurityState(interaction.guild.id, (state) => {
        state.lockdown = { active: true, automatic: false, reason, startedAt: new Date().toISOString(), startedBy: interaction.user.id };
      });
      await auditBestEffort(interaction.guild, setup, { action: "Security lockdown enabled", status: "success", actorId: interaction.user.id, fields: [{ name: "Reason", value: reason }] });
      await interaction.editReply(responseWithEmbed(
        "Security lockdown enabled. Monitoring and enforcement of approved existing records continue.",
        "Security Lockdown Enabled",
        "warning",
      ));
    } else if (interaction.commandName === "security_unlock") {
      await createConfirmation(interaction, "security_unlock");
    } else if (interaction.commandName === "blacklist_sync") {
      await runGuildBlacklistSync(interaction.guild, "manual");
      const sync = getBlacklistSyncStatus();
      await auditBestEffort(interaction.guild, setup, { action: "Blacklist sync report requested", status: "success", actorId: interaction.user.id,
        fields: [{ name: "Mode", value: "Monitoring-only: manual Trello changes never modify Discord state." }] });
      await interaction.editReply(responseWithEmbed(
        `Trello monitoring report: ${sync.state}; indexed ${sync.counts.indexed}, issues ${sync.counts.issues}. This command is report-only and does not enforce manual Trello changes.`,
        "Trello Monitoring Report",
        sync.counts.issues ? "warning" : "success",
        "Manual Trello changes never modify Discord state.",
        [
          { name: "State", value: titleCaseHeading(sync.state), inline: true },
          { name: "Indexed", value: String(sync.counts.indexed), inline: true },
          { name: "Issues", value: String(sync.counts.issues), inline: true },
        ],
      ));
    } else if (interaction.commandName === "blacklist_note") {
      const note = cleanText(interaction.options.getString("note", true), "Note");
      const username = interaction.options.getString("username")?.trim();
      const robloxUser = username ? await findRobloxUser(username) : undefined;
      await saveBlacklistNote({
        id: `${interaction.guild.id}:${interaction.user.id}:${Date.now()}`,
        guildId: interaction.guild.id,
        robloxUserId: robloxUser?.id,
        robloxUsername: robloxUser?.name,
        actorId: interaction.user.id,
        text: note,
        createdAt: new Date().toISOString(),
      });
      await auditBestEffort(interaction.guild, setup, { action: "Blacklist note recorded", status: "success", actorId: interaction.user.id,
        fields: [{ name: "Note", value: note }, { name: "Roblox username", value: robloxUser ? `${robloxUser.name} | ${robloxUser.id}` : "Not specified" }] });
      await interaction.editReply(responseWithEmbed("Blacklist note durably recorded.", "Blacklist Note Recorded", "success"));
    } else if (interaction.commandName === "blacklist_lookup") {
      const user = await findRobloxUser(interaction.options.getString("username", true));
      const mappings = trelloMappingsFor(setup);
      await requireTrelloReadiness(mappings);
      const card = await findBlacklistCardByRobloxId(user.id, mappings);
      await interaction.editReply({
        content: "",
        embeds: [outcomeEmbed("Blacklist Lookup", card ? "A matching Trello blacklist record was found." : "No Trello blacklist record was found.", card ? "success" : "info", [
          { name: "Roblox User", value: `${safePresentationText(user.name)} (${displayId(user.id)})` },
          ...(card ? [
            { name: "List", value: titleCaseHeading(card.listType), inline: true },
            { name: "Trello Card", value: `[Open card](${card.url})\n${displayId(card.id)}`, inline: true },
          ] : []),
        ])],
        allowedMentions: noMentions,
      });
    } else if (interaction.commandName === "identity_lookup") {
      const state = await getSecurityState(interaction.guild.id);
      const discordId = interaction.options.getUser("discord_user")?.id;
      const rawRoblox = interaction.options.getString("roblox_id")?.trim();
      const robloxId = rawRoblox ? Number(rawRoblox) : undefined;
      if (!discordId && !robloxId) throw new Error("Provide a Discord user or Roblox ID.");
      if (rawRoblox && (!Number.isSafeInteger(robloxId) || robloxId! <= 0)) throw new Error("Roblox ID must be a positive whole number.");
      const matches = state.identityLedger.filter((entry) => (!discordId || entry.discordUserId === discordId) && (!robloxId || entry.robloxUserId === robloxId));
      await interaction.editReply({
        content: "",
        embeds: [outcomeEmbed("Identity Lookup", matches.length ? "Recorded identity associations found." : "No recorded identity associations found.", "info", matches.slice(0, 25).map((entry) => ({
          name: `${displayId(entry.discordUserId)} ↔ ${displayId(entry.robloxUserId)}`,
          value: `Observed ${readableDate(entry.observedAt)}`,
        })))],
        allowedMentions: noMentions,
      });
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The command failed unexpectedly.";
    await auditBestEffort(interaction.guild, setup, {
      action: "Moderation command failed",
      status: "failed",
      actorId: interaction.user.id,
      fields: [
        { name: "Command", value: `/${interaction.commandName}` },
        {
          name: "Result",
          value: "The operation failed. Check the private command reply and bot logs.",
        },
      ],
    });
    logger.error({ err: error, command: interaction.commandName }, "Blacklist command failed");
    await interaction.editReply(errorResponse(`Could not complete the command: ${message}`, "Command Failed"));
  }
}

export function getBotStatus() {
  const trello = getTrelloReadiness();
  return {
    configured: getMissingConfiguration().length === 0,
    missing: getMissingConfiguration(),
    commandsEnabled: commandsRegistered,
    setupCommandAvailable: setupCommandRegistered,
    setupComplete: guildSetupComplete,
    discordConnected: discordClient?.isReady() ?? false,
    recoveryStatus: recovery.status,
    recovery: {
      ...recovery,
    },
    blacklistSync: getBlacklistSyncStatus(),
    trelloReady: trello.ready,
  };
}

function setRecoveryStatus(
  status: BotRecoveryStatus,
  error: string | null = null,
): void {
  recovery.status = status;
  recovery.error = error;
  if (status === "successful") {
    recovery.lastSuccessfulAt = new Date().toISOString();
  }
}

function refreshResult(): BotRefreshResult {
  const bot = getBotStatus();
  return {
    ...bot,
    trello: getTrelloReadiness(),
    error: recovery.error,
  };
}

async function registerGuildCommands(
  guild: Guild,
  expectedSetup = false,
): Promise<boolean> {
  const setup = await getGuildSetup(guild.id);
  let setupValid = false;

  if (setup) {
    try {
      await validateGuildSetup(guild, setup);
      setupValid = true;
    } catch (error) {
      logger.warn(
        {
          guildId: guild.id,
          reason:
            error instanceof Error ? error.message : "Stored setup is invalid",
        },
        "Stored Discord setup must be updated",
      );
    }
  }

  if (expectedSetup && !setupValid) {
    throw new Error("The saved setup could not be validated.");
  }

  const commandData = setupValid ? enabledCommands : setupOnlyCommands;
  commandsRegistered = false;
  setupCommandRegistered = false;
  guildSetupComplete = setupValid;
  await guild.commands.set(commandData);
  setupCommandRegistered = true;
  commandsRegistered = setupValid;
  logger.info(
    {
      guildId: guild.id,
      commandCount: commandData.length,
      moderationCommandsEnabled: setupValid,
    },
    setupValid
      ? "Setup and moderation commands registered for guild"
      : "Setup command registered for guild",
  );
  return setupValid;
}

async function registerCommands(readyClient: Client<true>): Promise<boolean> {
  if (!config.discordGuildId) {
    throw new Error("DISCORD_GUILD_ID is required for guild setup.");
  }
  const guild = await readyClient.guilds.fetch(config.discordGuildId);
  return registerGuildCommands(guild);
}

async function observeExistingAdministrators(guild: Guild): Promise<void> {
  // GuildManager fixtures and very early partial guilds may not expose a
  // member fetcher yet. Live configured guilds do; defer observation rather
  // than treating every established administrator as newly escalated.
  if (typeof guild.members.list !== "function") return;
  const members = await fetchGuildMembers(guild);
  await mutateSecurityState(guild.id, (state) => {
    for (const member of members.values()) {
      if (member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator)) {
        // Do not timestamp established administrators as a fresh escalation
        // after a process restart.
        state.observedAdministrators[member.id] ??= "1970-01-01T00:00:00.000Z";
      }
    }
  });
}

async function replyInteractionError(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : "The interaction failed unexpectedly.";
  const payload = errorResponse(message, "Interaction Error");
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ ...payload, ephemeral: true }).catch(() => undefined);
  } else {
    await interaction.reply({ ...payload, ephemeral: true }).catch(() => undefined);
  }
}

async function connectDiscord(): Promise<void> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  discordClient = client;
  commandsRegistered = false;
  setupCommandRegistered = false;
  guildSetupComplete = false;

  const ready = new Promise<void>((resolve, reject) => {
    client.once(Events.ClientReady, (readyClient) => {
      void (async () => {
        try {
          const moderationEnabled = await registerCommands(readyClient);
            if (moderationEnabled) {
              setRecoveryStatus("successful");
              const guild = await readyClient.guilds.fetch(
                config.discordGuildId!,
              );
              await observeExistingAdministrators(guild);
              await runGuildBlacklistSync(guild, "startup");
            } else {
              clearBlacklistSyncTimer();
              setRecoveryStatus(
                "blocked",
                "Discord setup is required. Run /settings in the configured server.",
              );
            }
            logger.info(
              { user: readyClient.user.tag },
              "Discord blacklist bot is online",
            );
            resolve();
        } catch (error) {
          reject(error);
        }
      })();
    });
  });

  client.on("interactionCreate", (interaction) => {
    if (interaction.isChatInputCommand()) {
      void handleInteraction(interaction);
    } else if (interaction.isButton()) {
      void (async () => {
        if (interaction.customId.startsWith("maintenance-confirm:") ||
            interaction.customId.startsWith("maintenance-cancel:")) {
          await handleMaintenanceConfirmation(interaction);
          return;
        }
        const [, confirmationId] = interaction.customId.split(/:(.+)/);
        const existingConfirmation = confirmationId ? confirmations.get(confirmationId) : undefined;
        // The command form of emergency unlock remains usable in maintenance;
        // ordinary blacklist confirmations deliberately do not.
        if (
          existingConfirmation?.command === "security_unlock" &&
          (interaction.customId.startsWith("confirm:") || interaction.customId.startsWith("cancel:"))
        ) {
          await handleConfirmation(interaction);
          return;
        }
        if (interaction.customId.startsWith("settings:")) {
          await handleSettingsComponent(interaction);
          return;
        }
        if (interaction.guildId && await maintenanceActive(interaction.guildId)) {
          await interaction.reply({
            ...responseWithEmbed(maintenanceMessage, "Maintenance Active", "warning"),
            ephemeral: true,
          });
          return;
        }
        if (interaction.customId.startsWith("confirm:") || interaction.customId.startsWith("cancel:")) {
          await handleConfirmation(interaction);
        } else {
          await handleSetupComponent(interaction);
        }
      })().catch((error) => replyInteractionError(interaction, error));
    } else if (interaction.isStringSelectMenu()) {
      void (async () => {
        if (interaction.customId.startsWith("settings:")) {
          await handleSettingsComponent(interaction);
          return;
        }
        if (interaction.guildId && await maintenanceActive(interaction.guildId)) {
          await interaction.reply({
            ...responseWithEmbed(maintenanceMessage, "Maintenance Active", "warning"),
            ephemeral: true,
          });
          return;
        }
        await handleSetupComponent(interaction);
      })().catch((error) => replyInteractionError(interaction, error));
    } else if (interaction.isModalSubmit()) {
      void (async () => {
        if (interaction.customId.startsWith("settings-modal:")) {
          await handleSettingsModal(interaction);
          return;
        }
        if (interaction.guildId && await maintenanceActive(interaction.guildId)) {
          await interaction.reply({
            ...responseWithEmbed(maintenanceMessage, "Maintenance Active", "warning"),
            ephemeral: true,
          });
          return;
        }
        await handleSetupModal(interaction);
      })().catch((error) => replyInteractionError(interaction, error));
    }
  });

  client.on(Events.GuildMemberUpdate, (before, after) => {
    if (after.guild.id !== config.discordGuildId) return;
    const hadAdministrator = before.permissions.has(PermissionFlagsBits.Administrator);
    const hasAdministrator = after.permissions.has(PermissionFlagsBits.Administrator);
    if (!hadAdministrator && hasAdministrator) {
      void mutateSecurityState(after.guild.id, (state) => {
        state.observedAdministrators[after.id] = new Date().toISOString();
      });
    } else if (hadAdministrator && !hasAdministrator) {
      void mutateSecurityState(after.guild.id, (state) => {
        delete state.observedAdministrators[after.id];
      });
    }
  });

  client.on(Events.GuildMemberAdd, (member) => {
    if (member.guild.id !== config.discordGuildId) return;
    void getGuildSetup(member.guild.id)
      .then((setup) =>
        setup ? enforceBlacklistForJoinedMember(member, setup) : undefined,
      )
      .catch(() => {
        logger.warn(
          { guildId: member.guild.id, discordUserId: member.id },
          "Joined member blacklist check failed",
        );
      });
  });

  client.on("error", (error) => {
    logger.error({ err: error }, "Discord client error");
  });

  try {
    await client.login(config.discordToken);
    await ready;
  } catch (error) {
    commandsRegistered = false;
    setupCommandRegistered = false;
    guildSetupComplete = false;
    clearBlacklistSyncTimer();
    if (discordClient === client) {
      discordClient = null;
    }
    client.destroy();
    throw error;
  }
}

export interface BotRefreshResult {
  configured: boolean;
  missing: string[];
  commandsEnabled: boolean;
  setupCommandAvailable: boolean;
  setupComplete: boolean;
  discordConnected: boolean;
  recoveryStatus: BotRecoveryStatus;
  recovery: BotRecoveryState;
  blacklistSync: ReturnType<typeof getBlacklistSyncStatus>;
  trelloReady: boolean;
  trello: TrelloReadiness;
  error: string | null;
}

export async function refreshBot(
  trigger: "manual" | "automatic" = "manual",
): Promise<BotRefreshResult> {
  if (recoveryAttempt) {
    return recoveryAttempt;
  }

  if (trigger === "manual") {
    clearTrelloRetry();
  }

  recoveryAttempt = (async () => {
    recovery.lastAttemptAt = new Date().toISOString();
    if (trigger === "automatic") {
      recovery.lastRetryAt = recovery.lastAttemptAt;
      recovery.lastRetryOutcome = "pending";
    }
    setRecoveryStatus("pending");

    try {
      const persistedSetup = config.discordGuildId
        ? await getGuildSetup(config.discordGuildId)
        : undefined;
      const trello = await checkTrelloReadiness(
        persistedSetup ? trelloMappingsFor(persistedSetup) : defaultTrelloMappings(),
      );
      if (!trello.ready) {
        commandsRegistered = false;
        clearBlacklistSyncTimer();
        setRecoveryStatus("blocked", trello.error);
        if (trigger === "automatic") {
          recovery.lastRetryOutcome = "blocked";
        }
        if (trello.status === "unavailable") {
          scheduleTrelloRetry();
        } else {
          clearTrelloRetry();
        }
        logger.warn(
          {
            readiness: trello.status,
            missingLists: trello.missingLists,
            error: trello.error,
          },
          "Blacklist bot is waiting for Trello board readiness",
        );
        return refreshResult();
      }

      resetTrelloRetry();
      if (trigger === "automatic") {
        recovery.lastRetryOutcome = "successful";
      }

      const missing = getMissingConfiguration();
      if (missing.length > 0) {
        commandsRegistered = false;
        clearBlacklistSyncTimer();
        const error = `Bot configuration is incomplete: ${missing.join(", ")}.`;
        setRecoveryStatus("blocked", error);
        logger.warn({ missing }, "Blacklist bot is waiting for configuration");
        return refreshResult();
      }

      if (discordClient?.isReady()) {
        const moderationEnabled = await registerCommands(
          discordClient as Client<true>,
        );
        if (moderationEnabled) {
          setRecoveryStatus("successful");
          const guild = await (
            discordClient as Client<true>
          ).guilds.fetch(config.discordGuildId!);
          await runGuildBlacklistSync(guild, "manual");
        } else {
          clearBlacklistSyncTimer();
          setRecoveryStatus(
            "blocked",
            "Discord setup is required. Run /settings in the configured server.",
          );
        }
        return refreshResult();
      }

      await connectDiscord();
      return refreshResult();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The bot could not be started.";
      setRecoveryStatus("blocked", message);
      if (trigger === "automatic") {
        recovery.lastRetryOutcome = "blocked";
      }
      logger.error({ err: error }, "Blacklist bot recovery failed");
      return refreshResult();
    }
  })();

  try {
    return await recoveryAttempt;
  } finally {
    recoveryAttempt = null;
  }
}

export async function startBot(): Promise<void> {
  if (!shutdownHooksInstalled) {
    shutdownHooksInstalled = true;
    const shutdown = () => {
      clearTrelloRetry();
      clearBlacklistSyncTimer();
      discordClient?.destroy();
      discordClient = null;
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }
  const result = await refreshBot();
  if (!result.commandsEnabled) {
    logger.warn(
      {
        recoveryStatus: result.recoveryStatus,
        trello: result.trello,
        error: result.error,
      },
      "Blacklist bot is not online after recovery attempt",
    );
  }
}

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
  findBlacklistCardByRobloxId,
  getTrelloReadiness,
  requireTrelloReadiness,
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
  presenceSettingsFor,
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
import {
  applyPresenceSettings,
  DEFAULT_PRESENCE_SETTINGS,
  stopPresenceRotation,
  validatePresenceSettings,
  type PresenceSettings,
} from "./presence";
import {
  enforceBlacklistForJoinedMember,
  getBlacklistSyncStatus,
  processApprovedRevocation,
  setNextBlacklistSyncAt,
  synchronizeBlacklists,
  type BlacklistSyncTrigger,
} from "./blacklist-sync";

const setupCommand = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Configure blacklist, security, audit, and bot settings.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addRoleOption((option) =>
    option
      .setName("role")
      .setDescription("Legacy migration field; authorization uses Administrator.")
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName("audit_channel_id")
      .setDescription("The ID of the text channel that receives audit logs.")
      .setRequired(false),
  );

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
    .setName("group_blacklist")
    .setDescription("Add a Roblox group to the group blacklist.")
    .addStringOption((option) =>
      option
        .setName("id")
        .setDescription("The Roblox group id.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why the group is being blacklisted.")
        .setRequired(true),
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
    .setName("blacklist_note")
    .setDescription("Record an audit note against a blacklist lookup.")
    .addStringOption((option) => option.setName("note").setDescription("Note text").setRequired(true))
    .addStringOption((option) => option.setName("username").setDescription("Optional Roblox username")),
  new SlashCommandBuilder()
    .setName("blacklist_lookup")
    .setDescription("Look up an active or revoked blacklist record.")
    .addStringOption((option) => option.setName("username").setDescription("Roblox username").setRequired(true)),
  new SlashCommandBuilder()
    .setName("blacklist_sync")
    .setDescription("Report Trello monitoring status; does not change Discord state."),
  new SlashCommandBuilder()
    .setName("identity_lookup")
    .setDescription("Look up recorded Discord and Roblox identity associations.")
    .addUserOption((option) => option.setName("discord_user").setDescription("Discord user"))
    .addStringOption((option) => option.setName("roblox_id").setDescription("Roblox numeric ID")),
  new SlashCommandBuilder()
    .setName("security_status")
    .setDescription("View current rate-limit and lockdown status."),
  new SlashCommandBuilder()
    .setName("security_lockdown")
    .setDescription("Immediately stop new destructive blacklist actions.")
    .addStringOption((option) => option.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder()
    .setName("security_unlock")
    .setDescription("Unlock destructive blacklist actions after confirmation.")
    .addStringOption((option) => option.setName("reason").setDescription("Optional reason")),
];

const setupOnlyCommands = [setupCommand.toJSON()];
const enabledCommands = [setupCommand, ...moderationCommands].map((command) =>
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
const setupSessions = new Map<string, {
  userId: string;
  guildId: string;
  expiresAt: number;
  nonce: string;
  /** The one ephemeral setup message this session is authorized to operate. */
  messageId?: string;
}>();
const confirmations = new Map<string, {
  userId: string;
  guildId: string;
  command: "blacklist" | "group_blacklist" | "revoke_blacklist" | "security_unlock";
  original: ChatInputCommandInteraction;
  target?: { discordUserId: string; robloxUserId: number; robloxUsername: string; cardId?: string };
  expiresAt: number;
}>();

const destructiveCommands = new Set(["blacklist", "group_blacklist", "revoke_blacklist"]);
const setupSessionLifetimeMs = 10 * 60_000;
const permissionEscalationWindowMs = 10 * 60_000;

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

  const members = await interaction.guild!.members.fetch();
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

function scopedSetupModalId(guildId: string, userId: string, id: string): string {
  const session = setupSessions.get(setupSessionId(guildId, userId));
  if (!session) throw new Error("This setup session has expired. Run /setup again.");
  return `${id}:${session.nonce}`;
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
    ["presence", "Presence Settings"],
    ["identity", "Identity / Alt Detection"],
    ["view", "View Configuration"],
  ] as const;
  return {
    embeds: [new EmbedBuilder().setTitle("⚙️ BOT SETUP").setDescription(
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

function securityEmbed(setup: GuildSetup, state: SecurityState): EmbedBuilder {
  const settings = securitySettingsFor(setup);
  return new EmbedBuilder().setTitle("SECURITY SETTINGS").setDescription([
    "Administrator Access: Administrator permission required",
    `Per-Admin Limit: ${settings.perAdminLimit} actions / ${settings.windowMinutes} minutes`,
    `Global Limit: ${settings.globalLimit} actions / ${settings.windowMinutes} minutes`,
    `Automatic Lockdown: ${settings.automaticLockdown ? "Enabled" : "Disabled"}`,
    `Confirmation: ${settings.confirmationsRequired ? "Enabled" : "Disabled"}`,
    `Recent Permission Escalation Guard: ${settings.recentPermissionEscalationProtection ? "Enabled" : "Disabled"}`,
    `Current State: ${state.lockdown.active ? `LOCKED — ${state.lockdown.reason}` : "Not locked"}`,
    `Protected Users: ${settings.protectedUserIds.length}; Protected Roles: ${settings.protectedRoleIds.length}`,
  ].join("\n"));
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
  if (discordClient?.isReady()) applyPresenceSettings(discordClient, presenceSettingsFor(updated));
  return updated;
}

async function requireSetupSession(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
): Promise<GuildSetup> {
  if (!interaction.guild) throw new Error("Setup is only available in the configured server.");
  const session = setupSessions.get(setupSessionId(interaction.guild.id, interaction.user.id));
  if (!session || session.expiresAt <= Date.now()) {
    throw new Error("This setup session has expired. Run /setup again.");
  }
  if (
    interaction.isButton?.() || interaction.isStringSelectMenu?.()
  ) {
    const messageId = interaction.message?.id;
    if (session.messageId && messageId !== session.messageId) {
      throw new Error("This setup control belongs to an older setup message. Run /setup again.");
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

async function handleSetupComponent(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
  const setup = await requireSetupSession(interaction);
  const guild = interaction.guild!;
  const rawId = interaction.isStringSelectMenu() ? interaction.values[0]! : interaction.customId;
  const id = rawId.replace(/:([a-f0-9]{32})$/, "");
  const nonce = rawId.match(/:([a-f0-9]{32})$/)?.[1];
  const session = setupSessions.get(setupSessionId(guild.id, interaction.user.id));
  if (nonce && session?.nonce !== nonce) {
    throw new Error("This setup control belongs to an expired setup session. Run /setup again.");
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
      embeds: [new EmbedBuilder().setTitle("AUTOMATIC SECURITY LOCKDOWN").setDescription(
        `Status: ${securitySettingsFor(setup).automaticLockdown ? "Enabled" : "Disabled"}\nCurrent State: ${state.lockdown.active ? "Locked" : "Not locked"}`,
      )],
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
      content: "Confirm unlocking security lockdown. Your current Administrator permission will be checked again.",
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("setup:confirm-unlock").setLabel("Confirm Unlock").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("setup:lockdown").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      )],
    });
    return;
  }
  if (id === "setup:confirm-unlock") {
    await completeSecurityUnlock(guild, interaction.user.id, setup, "Setup control confirmation");
    await interaction.update({ content: "Security lockdown has been unlocked.", components: [] });
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
  if (id === "setup:presence") {
    const presence = presenceSettingsFor(setup);
    await interaction.update({ embeds: [new EmbedBuilder().setTitle("PRESENCE SETTINGS").setDescription(
      `Enabled: ${presence.enabled ? "Yes" : "No"}\nRotation: ${presence.rotationEnabled ? "Enabled" : "Disabled"}\nInterval: ${presence.minIntervalMinutes}–${presence.maxIntervalMinutes} minutes\nActivities:\n${presence.activities.map((x) => `Watching ${x}`).join("\n")}`,
    )], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("setup:presence-toggle").setLabel("Enable / Disable").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:presence-rotation").setLabel("Toggle Rotation").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:presence-edit").setLabel("Edit Activities").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("setup:presence-reset").setLabel("Reset Defaults").setStyle(ButtonStyle.Secondary),
    )] });
    return;
  }
  if (id === "setup:presence-edit") {
    const presence = presenceSettingsFor(setup);
    await interaction.showModal(new ModalBuilder().setCustomId(scopedSetupModalId(guild.id, interaction.user.id, "setup-modal:presence")).setTitle("Presence settings").addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("activities").setLabel("Activities, one per line").setStyle(TextInputStyle.Paragraph).setValue(presence.activities.join("\n")).setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(numberInput("min", "Minimum minutes", presence.minIntervalMinutes, 1, 1440)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(numberInput("max", "Maximum minutes", presence.maxIntervalMinutes, 1, 1440)),
    ));
    return;
  }
  if (id === "setup:presence-toggle" || id === "setup:presence-rotation" || id === "setup:presence-reset") {
    const current = presenceSettingsFor(setup);
    const presence = id === "setup:presence-reset"
      ? { ...DEFAULT_PRESENCE_SETTINGS, activities: [...DEFAULT_PRESENCE_SETTINGS.activities] }
      : id === "setup:presence-toggle"
        ? { ...current, enabled: !current.enabled }
        : { ...current, rotationEnabled: !current.rotationEnabled };
    const updated = await saveSetupChange(guild, { ...setup, presence }, interaction.user.id, "Presence settings", JSON.stringify(current), JSON.stringify(presence));
    await interaction.update({ embeds: [new EmbedBuilder().setTitle("PRESENCE SETTINGS").setDescription(`Saved. ${updated.presence?.enabled ? "Enabled" : "Disabled"}.`)], components: [] });
    return;
  }
  if (id === "setup:audit") {
    const audit = auditSettingsFor(setup);
    await interaction.update({ embeds: [new EmbedBuilder().setTitle("AUDIT SETTINGS").setDescription(
      `Main: <#${setup.auditChannelId}>\nSecurity: ${setup.securityAlertChannelId ? `<#${setup.securityAlertChannelId}>` : "Main"}\nTrello: ${setup.trelloAlertChannelId ? `<#${setup.trelloAlertChannelId}>` : "Main"}\nTrello alerts: ${audit.trelloAlerts}\nBlacklist logs: ${audit.blacklistLogs}\nRole logs: ${audit.roleEnforcementLogs}\nJoin/leave logs: ${audit.joinLeaveBlacklistLogs}`,
    )], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
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
    await interaction.update({ content: "Audit category settings saved. Security and configuration audits are always retained.", embeds: [], components: [] });
    return;
  }
  if (id === "setup:audit-test") {
    await sendAuditEvent(guild, setup, {
      action: "Audit logging test",
      status: "success",
      actorId: interaction.user.id,
      fields: [{ name: "Result", value: "Audit destination and permissions are working." }],
    });
    await interaction.update({ content: "A test audit event was sent.", components: [] });
    return;
  }
  if (id === "setup:blacklist") {
    const mapping = trelloMappingsFor(setup);
    await interaction.update({ embeds: [new EmbedBuilder().setTitle("BLACKLIST SETTINGS").setDescription(
      `Blacklisted Discord Role: ${setup.blacklistRoleId ? `<@&${setup.blacklistRoleId}>` : "Not configured"}\nAppealable: ${mapping.lists.appealable}\nConditional: ${mapping.lists.conditional}\nPermanent: ${mapping.lists.permanent}\nGroup Blacklist: ${mapping.lists.group}\nRevoked: ${mapping.lists.revoked}`,
    )], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
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
    await interaction.update({ content: "Default Trello mappings were validated against the board and saved.", components: [] });
    return;
  }
  if (id === "setup:trello") {
    const monitoring = { ...defaultMonitoringSettings(), ...setup.monitoring };
    await interaction.update({ embeds: [new EmbedBuilder().setTitle("TRELLO MONITORING").setDescription(
      `Manual Changes: ${monitoring.manualChangeDetection ? "Enabled" : "Disabled"}\nDatabase Sync Check: ${monitoring.desyncDetection ? "Enabled" : "Disabled"}\nPolling: ${monitoring.pollingIntervalSeconds} seconds\nManual changes modify Discord state: NEVER`,
    )], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
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
    await interaction.update({ content: "Trello monitoring saved. Manual Trello edits never modify Discord blacklist state.", embeds: [], components: [] });
    return;
  }
  if (id === "setup:trello-desync" || id === "setup:trello-monitoring-reset") {
    const current = { ...defaultMonitoringSettings(), ...setup.monitoring };
    const monitoring = id === "setup:trello-monitoring-reset"
      ? defaultMonitoringSettings()
      : { ...current, desyncDetection: !current.desyncDetection };
    await saveSetupChange(guild, { ...setup, monitoring }, interaction.user.id, "Trello monitoring settings", JSON.stringify(current), JSON.stringify(monitoring));
    if (id === "setup:trello-monitoring-reset") scheduleBlacklistSync(guild, { ...setup, monitoring });
    await interaction.update({ content: "Trello monitoring settings saved.", components: [] });
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
    await interaction.update({ embeds: [new EmbedBuilder().setTitle("IDENTITY / ALT DETECTION").setDescription(
      `Same Roblox → Different Discord: ${identity.sameRobloxDifferentDiscord ? "Enabled" : "Disabled"}\nSame Discord → Different Roblox: ${identity.sameDiscordDifferentRoblox ? "Enabled" : "Disabled"}\nWarnings only; automatic punishment is permanently disabled.`,
    )], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
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
    await interaction.update({ content: "Identity settings saved. Possible alts remain warnings only.", components: [] });
    return;
  }
  if (id === "setup:view" || id === "setup:discord") {
    await interaction.update({ embeds: [new EmbedBuilder().setTitle(id === "setup:view" ? "CONFIGURATION" : "DISCORD SETTINGS").setDescription(
      `Audit: <#${setup.auditChannelId}>\nBlacklist role: ${setup.blacklistRoleId ? `<@&${setup.blacklistRoleId}>` : "Not configured"}\nAuthorization: current Administrator permission only`,
    )], components: [] });
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
    throw new Error("This setup modal belongs to an expired setup session. Run /setup again.");
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
    await interaction.reply({ content: "Automatic lockdown threshold saved and audited.", ephemeral: true });
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
    await interaction.reply({ content: "Rate limits saved and audited.", ephemeral: true });
    return;
  }
  if (id === "setup-modal:presence") {
    const current = presenceSettingsFor(setup);
    const proposed: PresenceSettings = {
      ...current,
      activities: interaction.fields.getTextInputValue("activities").split("\n").map((value) => value.trim()).filter(Boolean),
      minIntervalMinutes: Number(interaction.fields.getTextInputValue("min")),
      maxIntervalMinutes: Number(interaction.fields.getTextInputValue("max")),
    };
    const presence = validatePresenceSettings(proposed);
    await saveSetupChange(guild, { ...setup, presence }, interaction.user.id, "Presence settings", JSON.stringify(current), JSON.stringify(presence));
    await interaction.reply({ content: "Presence settings saved and applied.", ephemeral: true });
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
    await interaction.reply({ content: "Protected identities saved and audited.", ephemeral: true });
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
    await interaction.reply({ content: "Audit channels saved and verified.", ephemeral: true });
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
    await interaction.reply({ content: "Blacklist role mapping saved and audited.", ephemeral: true });
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
    await interaction.reply({ content: "Trello polling interval saved and applied.", ephemeral: true });
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
    await interaction.reply({ content: "Trello mapping was verified against the board, saved, and will be used by subsequent operations.", ephemeral: true });
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
  const id = `${interaction.guild!.id}:${interaction.user.id}:${command}:${Date.now()}`;
  confirmations.set(id, { userId: interaction.user.id, guildId: interaction.guild!.id, command, original: interaction, target, expiresAt: Date.now() + setupSessionLifetimeMs });
  await interaction.editReply({
    content: `Confirm /${command}. Your current Administrator permission will be checked again before execution.`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`confirm:${id}`).setLabel("Confirm").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`cancel:${id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    )],
  });
}

async function completeSecurityUnlock(
  guild: Guild,
  actorId: string,
  setup: GuildSetup,
  reason: string,
): Promise<void> {
  await requireCurrentAdministrator(guild, actorId, setup, "/security_unlock confirmation");
  const prior = await getSecurityState(guild.id);
  await mutateSecurityState(guild.id, (state) => {
    state.lockdown = { active: false, automatic: false, reason: "", startedAt: null, startedBy: null };
  });
  await auditBestEffort(guild, setup, {
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
    await interaction.update({ content: "Action cancelled.", components: [] });
    return;
  }
  const setup = await getGuildSetup(pending.guildId);
  if (!setup || !interaction.guild) throw new Error("Bot setup is unavailable.");
  await requireCurrentAdministrator(interaction.guild, interaction.user.id, setup, `/${pending.command} confirmation`);
  await interaction.deferUpdate();
  if (pending.command === "security_unlock") {
    await completeSecurityUnlock(
      interaction.guild,
      interaction.user.id,
      setup,
      pending.original.options.getString("reason")?.trim() || "None",
    );
    await pending.original.editReply({ content: "Security lockdown has been unlocked.", components: [] });
    return;
  }
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
      "Only the server owner or an administrator can run /setup.",
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
    presence: previous?.presence ?? { ...DEFAULT_PRESENCE_SETTINGS, activities: [...DEFAULT_PRESENCE_SETTINGS.activities] },
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
      `Setup complete. Only current Discord Administrators can use administrative commands. Audits will be sent to <#${auditChannelId}>.`,
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
  let createdCard:
    | Awaited<ReturnType<typeof createBlacklistCard>>
    | undefined;

  try {
    createdCard = await createBlacklistCard({
      name: `${robloxUser.name} | ${robloxUser.id}`,
      type,
      reason,
      mappings: setup ? trelloMappingsFor(setup) : undefined,
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
        action: "Trello blacklist card created",
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
        content: `You have been blacklisted from this server. Trello record: ${createdCard.url}`,
        embeds: [],
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
    await interaction.editReply(
      `Blacklisted **${robloxUser.name}** (${robloxUser.id}). Removed ${roleIds.length} role(s) and created the Trello card: ${createdCard.url}`,
    );
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
              ? "The Trello card exists and synchronization will retry role enforcement."
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
  return withGuildBlacklistLifecycleLock(interaction.guild!.id, () =>
    handleBlacklistUnlocked(interaction, setup, boundTarget),
  );
}

async function handleGroupBlacklist(
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
  await interaction.editReply(
    `Blacklisted group ${groupUrl}. Created the Trello card: ${card.url}`,
  );
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
      await interaction.editReply(
        `Revoked the Trello blacklist for **${robloxUser.name}**. No saved Discord role snapshot was found, so no roles were restored.`,
      );
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
  await interaction.editReply(
    result.completed
      ? `Revoked the blacklist for **${robloxUser.name}** and restored ${result.restored.length} saved role(s).`
      : result.moved
        ? `Revocation for **${robloxUser.name}** is approved. Discord role restoration is pending and will complete when the member is available.`
        : `Revocation for **${robloxUser.name}** remains pending. Discord restrictions remain in place until the exact Trello card can be moved.`,
  );
}

function handleRevoke(
  interaction: ChatInputCommandInteraction,
  setup: GuildSetup,
  boundTarget?: { discordUserId: string; robloxUserId: number; robloxUsername: string; cardId?: string },
): Promise<void> {
  return withGuildBlacklistLifecycleLock(interaction.guild!.id, () =>
    handleRevokeUnlocked(interaction, setup, boundTarget),
  );
}

async function handleInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({
      content: "These commands can only be used inside the configured server.",
      ephemeral: true,
    });
    return;
  }
  if (config.discordGuildId && interaction.guild.id !== config.discordGuildId) {
    await interaction.reply({ content: "This command is only available in the configured server.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

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
      await interaction.editReply(`Could not complete setup: ${message}`);
    }
    return;
  }

  const setup = await getGuildSetup(interaction.guild.id).catch(() => undefined);
  if (!setup) {
    await interaction.editReply(
      "This server has not completed bot setup. Ask the server owner or an administrator to run /setup first.",
    );
    return;
  }

  try {
    await validateGuildSetup(interaction.guild, setup);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The saved setup is invalid.";
    await interaction.editReply(`Moderation commands are disabled: ${message}`);
    return;
  }

  try {
    await requireCurrentAdministrator(interaction.guild, interaction.user.id, setup, `/${interaction.commandName}`);
  } catch (error) {
    await interaction.editReply(error instanceof Error ? error.message : "Administrative access denied.");
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
      await interaction.editReply(`Security: ${state.lockdown.active ? "LOCKED" : "unlocked"}; ${state.destructiveActions.length}/${settings.globalLimit} destructive actions in the current ${settings.windowMinutes}-minute window.`);
    } else if (interaction.commandName === "security_lockdown") {
      const reason = cleanText(interaction.options.getString("reason", true), "Reason");
      await mutateSecurityState(interaction.guild.id, (state) => {
        state.lockdown = { active: true, automatic: false, reason, startedAt: new Date().toISOString(), startedBy: interaction.user.id };
      });
      await auditBestEffort(interaction.guild, setup, { action: "Security lockdown enabled", status: "success", actorId: interaction.user.id, fields: [{ name: "Reason", value: reason }] });
      await interaction.editReply("Security lockdown enabled. Monitoring and enforcement of approved existing records continue.");
    } else if (interaction.commandName === "security_unlock") {
      await createConfirmation(interaction, "security_unlock");
    } else if (interaction.commandName === "blacklist_sync") {
      await runGuildBlacklistSync(interaction.guild, "manual");
      const sync = getBlacklistSyncStatus();
      await auditBestEffort(interaction.guild, setup, { action: "Blacklist sync report requested", status: "success", actorId: interaction.user.id,
        fields: [{ name: "Mode", value: "Monitoring-only: manual Trello changes never modify Discord state." }] });
      await interaction.editReply(`Trello monitoring report: ${sync.state}; indexed ${sync.counts.indexed}, issues ${sync.counts.issues}. This command is report-only and does not enforce manual Trello changes.`);
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
      await interaction.editReply("Blacklist note durably recorded.");
    } else if (interaction.commandName === "blacklist_lookup") {
      const user = await findRobloxUser(interaction.options.getString("username", true));
      const mappings = trelloMappingsFor(setup);
      await requireTrelloReadiness(mappings);
      const card = await findBlacklistCardByRobloxId(user.id, mappings);
      await interaction.editReply(card
        ? `Blacklist record for **${user.name}** (${user.id}): ${card.listType} — ${card.url}`
        : `No Trello blacklist record was found for **${user.name}** (${user.id}).`);
    } else if (interaction.commandName === "identity_lookup") {
      const state = await getSecurityState(interaction.guild.id);
      const discordId = interaction.options.getUser("discord_user")?.id;
      const rawRoblox = interaction.options.getString("roblox_id")?.trim();
      const robloxId = rawRoblox ? Number(rawRoblox) : undefined;
      if (!discordId && !robloxId) throw new Error("Provide a Discord user or Roblox ID.");
      if (rawRoblox && (!Number.isSafeInteger(robloxId) || robloxId! <= 0)) throw new Error("Roblox ID must be a positive whole number.");
      const matches = state.identityLedger.filter((entry) => (!discordId || entry.discordUserId === discordId) && (!robloxId || entry.robloxUserId === robloxId));
      await interaction.editReply(matches.length ? `Recorded associations:\n${matches.map((entry) => `Discord ${entry.discordUserId} ↔ Roblox ${entry.robloxUserId} (${entry.observedAt})`).join("\n")}` : "No recorded identity associations found.");
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
    await interaction.editReply(`Could not complete the command: ${message}`);
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
  if (typeof guild.members.fetch !== "function") return;
  const members = await guild.members.fetch();
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
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content: message, ephemeral: true }).catch(() => undefined);
  } else {
    await interaction.reply({ content: message, ephemeral: true }).catch(() => undefined);
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
      void registerCommands(readyClient)
        .then((moderationEnabled) => {
          void (async () => {
            try {
              const setup = config.discordGuildId
                ? await getGuildSetup(config.discordGuildId)
                : undefined;
              const presence = setup ? presenceSettingsFor(setup) : DEFAULT_PRESENCE_SETTINGS;
              applyPresenceSettings(readyClient, presence);
              logger.info(
                { enabled: presence.enabled, activity: presence.enabled ? presence.activities[0] : null },
                "Discord presence applied",
              );
            } catch (error) {
              logger.warn({ err: error }, "Could not apply Discord presence settings");
            }
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
                "Discord setup is required. Run /setup in the configured server.",
              );
            }
            logger.info(
              { user: readyClient.user.tag },
              "Discord blacklist bot is online",
            );
            resolve();
          })().catch(reject);
        })
        .catch(reject);
    });
  });

  client.on("interactionCreate", (interaction) => {
    if (interaction.isChatInputCommand()) {
      void handleInteraction(interaction);
    } else if (interaction.isButton()) {
      void (interaction.customId.startsWith("confirm:") || interaction.customId.startsWith("cancel:")
        ? handleConfirmation(interaction)
        : handleSetupComponent(interaction)
      ).catch((error) => replyInteractionError(interaction, error));
    } else if (interaction.isStringSelectMenu()) {
      void handleSetupComponent(interaction).catch((error) => replyInteractionError(interaction, error));
    } else if (interaction.isModalSubmit()) {
      void handleSetupModal(interaction).catch((error) => replyInteractionError(interaction, error));
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
    stopPresenceRotation();
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
            "Discord setup is required. Run /setup in the configured server.",
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

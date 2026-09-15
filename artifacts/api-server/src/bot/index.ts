import {
  Client,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ComponentType,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";
import { logger } from "../lib/logger";
import { config, getMissingConfiguration, type BlacklistType } from "./config";
import {
  mapDiscordPresenceToPublicStatus,
  type PublicBotStatus,
} from "./public-status";
import { acquireBotRuntimeLease, type BotRuntimeLease } from "./runtime-lease";
import { isFileBotStorage } from "./persistent-store";
import {
  readPersistedRecoveryState,
  savePersistedRecoveryState,
  type PersistedRecoveryState,
} from "./runtime-state-store";
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
  listSnapshotsForMember,
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
  uniformSettingsFor,
  type GuildSetup,
} from "./setup-store";
import {
  administratorInEscalationWindow,
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
import {
  handleUniformCommand,
  handleUniformAssistanceModal,
  handleUniformCancelButton,
  handleUniformCustomerButton,
  handleUniformSettingsComponent,
  handleUniformSettingsModal,
  handleUniformRecoveryModal,
  handleUniformRelogCommand,
  handleUniformRelogSelection,
  handleUniformSpreadsheetSettingsModal,
  handleUniformSubmitButton,
  handleUniformRetryButton,
  handleUniformUserSelection,
  UniformDeliveryRecoveryError,
  UniformNotificationError,
  renderUniformSettings,
  uniformDeliveryRecoveryResponse,
  uniformCommandNames,
  uniformRelogCommandName,
  uniformCommands,
} from "./uniforms";
import { normalizeUniformSpreadsheetConfig, withPayoutAwareUniformActivity } from "./google-sheets";
import {
  archivePayoutPreview,
  acknowledgeUncertainPayoutReport,
  confirmArchivedPayout,
  googlePayoutSheetsClient,
  readPayoutSnapshot,
  recoverUnknownPayoutClear,
} from "./payout";
import { activePayoutRunForGuild, getPayoutRun, payoutLockForWorkbook, type PayoutRun } from "./payout-store";

const setupCommand = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Open the private Quartermaster setup wizard.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const settingsCommand = new SlashCommandBuilder()
  .setName("settings")
  .setDescription("Quartermaster administration, setup, security, and records.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const payoutCommand = new SlashCommandBuilder()
  .setName("payout")
  .setDescription("Preview and confirm the current uniform payout reset.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const moderationCommands = [
  new SlashCommandBuilder()
    .setName("blacklist")
    .setDescription("Blacklist a Roblox user and remove their server roles.")
    .addStringOption((option) =>
      option
        .setName("username")
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
    ),
  new SlashCommandBuilder()
    .setName("revoke_blacklist")
    .setDescription("Move a user blacklist card to revoked and restore roles.")
    .addStringOption((option) =>
      option
        .setName("username")
        .setDescription("The exact Roblox username.")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("blacklist_lookup")
    .setDescription("Look up an active or revoked blacklist record.")
    .addStringOption((option) => option.setName("username").setDescription("Roblox username").setRequired(true)),
];

// These recovery controls must remain reachable before first-time setup. In
// particular, maintenance must never make a partially configured guild stuck.
const setupOnlyCommands = [setupCommand, settingsCommand].map((command) => command.toJSON());
const enabledCommands = [setupCommand, settingsCommand, payoutCommand, ...moderationCommands].map((command) =>
  command.toJSON(),
);
const enabledUniformCommands = uniformCommands.map((command) => command.toJSON());
const allEnabledCommands = [...enabledCommands, ...enabledUniformCommands];

/** Snapshot of the exact command contract sent to Discord. */
export function getRegisteredCommandDefinitions() {
  return allEnabledCommands.map((command) => ({
    ...command,
    options: command.options?.map((option) => ({ ...option })),
  }));
}

export type BotRecoveryStatus = "pending" | "successful" | "blocked";
export type BotRetryOutcome = "pending" | "successful" | "blocked";

interface BotRecoveryState extends PersistedRecoveryState {}

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
let runtimeLease: BotRuntimeLease | null = null;
let recoveryPersistence: Promise<void> = Promise.resolve();
let leadershipLost = false;
let leadershipGeneration = 0;
type BotExitHandler = (code: number) => never | void;
let botExit: BotExitHandler = (code) => process.exit(code);

/** Test-only injection point; production immediately terminates on lease loss. */
export function setBotExitForTests(handler?: BotExitHandler): void {
  botExit = handler ?? ((code) => process.exit(code));
}

/**
 * The one lease-holder serializes these writes locally; the document row lock
 * also makes an accidental second process unable to lose retry history.
 */
function persistRecoveryState(): void {
  const snapshot = structuredClone(recovery);
  const generation = leadershipGeneration;
  recoveryPersistence = recoveryPersistence
    .catch(() => undefined)
    .then(() => {
      // Do not let an already queued telemetry write survive a lost leadership
      // lease in an injected test environment. Production exits immediately.
      if (leadershipLost || generation !== leadershipGeneration) return;
      return savePersistedRecoveryState(snapshot);
    });
  void recoveryPersistence.catch((error) => {
    logger.error({ err: error }, "Could not persist bot recovery state");
  });
}
type SettingsCategory = "uploading" | "blacklisting" | "global";

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
  /** Unsaved, server-native first-time setup selections. */
  initialSetup?: {
    auditChannelId?: string;
    seniorQuartermasterRoleId?: string;
    quartermasterRoleId?: string;
    securityOwnerId?: string;
  };
}
const setupSessions = new Map<string, SetupSession>();
interface ModerationTarget {
  discordUserId: string;
  robloxUserId: number;
  robloxUsername: string;
  /** Whether the bound Discord account is currently a guild member. */
  memberPresent?: boolean;
  cardId?: string;
}

interface DiscordIdentityPrompt {
  userId: string;
  guildId: string;
  command: "blacklist" | "revoke_blacklist";
  original: ChatInputCommandInteraction;
  robloxUserId: number;
  robloxUsername: string;
  expiresAt: number;
  nonce: string;
  phase?: "button" | "modal" | "resolving";
  cardId?: string;
}

const identityPrompts = new Map<string, DiscordIdentityPrompt>();
const confirmations = new Map<string, {
  userId: string;
  guildId: string;
  command: "blacklist" | "group_blacklist" | "revoke_blacklist" | "security_unlock";
  original: ChatInputCommandInteraction;
  target?: ModerationTarget;
  expiresAt: number;
  claimed?: boolean;
}>();
const maintenanceConfirmations = new Map<string, {
  userId: string;
  guildId: string;
  active: boolean;
  revision: number;
  reason: string;
  expiresAt: number;
  original: ChatInputCommandInteraction | ModalSubmitInteraction;
  claimed?: boolean;
}>();
interface PayoutConfirmation {
  userId: string;
  guildId: string;
  runId: string;
  expiresAt: number;
  original: ChatInputCommandInteraction;
  messageId?: string;
  claimed?: boolean;
  mode?: "confirm" | "resume" | "acknowledge" | "recover-clear";
}
const payoutConfirmations = new Map<string, PayoutConfirmation>();

const destructiveCommands = new Set(["blacklist", "group_blacklist", "revoke_blacklist"]);
const ownerOnlySecurityControls = new Set([
  "setup:confirmation",
  "setup:escalation-protection",
  "setup:security-reset",
  "setup:toggle-auto-lockdown",
  "setup-modal:rates",
  "setup-modal:threshold",
  "setup-modal:protected-users",
  "setup-modal:protected-roles",
  "setup:security-owner",
]);
const setupSessionLifetimeMs = 10 * 60_000;

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
  for (const [id, prompt] of identityPrompts) {
    if (prompt.guildId === guildId) identityPrompts.delete(id);
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
  persistRecoveryState();
}

function resetTrelloRetry(): void {
  clearTrelloRetry();
  recovery.retryCount = 0;
  persistRecoveryState();
}

function scheduleTrelloRetry(): void {
  if (trelloRetryTimer) return;

  const delay = Math.min(
    config.trelloRetryBaseDelayMs * 2 ** recovery.retryCount,
    config.trelloRetryMaxDelayMs,
  );
  recovery.retryCount += 1;
  recovery.nextRetryAt = new Date(Date.now() + delay).toISOString();
  persistRecoveryState();

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

async function requireServerOwner(
  guild: Guild,
  userId: string,
  setup?: GuildSetup,
  command?: string,
): Promise<void> {
  if (guild.ownerId === userId) return;
  if (setup) {
    await auditBestEffort(guild, setup, {
      action: "Server-owner-only command denied",
      status: "failed",
      actorId: userId,
      fields: command ? [{ name: "Command", value: command }] : [],
    });
  }
  throw new Error("Only the Discord server owner may use this command.");
}

async function requireConfiguredSecurityOwner(
  guild: Guild,
  userId: string,
  setup: GuildSetup,
  command?: string,
): Promise<void> {
  if (
    (setup.securityOwnerId && setup.securityOwnerId === userId) ||
    (!setup.securityOwnerId && guild.ownerId === userId)
  ) return;
  await auditBestEffort(guild, setup, {
    action: "Configured security owner authorization denied",
    status: "failed",
    actorId: userId,
    fields: command ? [{ name: "Command", value: command }] : [],
  });
  throw new Error(
    setup.securityOwnerId
      ? "Only the configured Security / Payout Owner may use this command."
      : "Select a Security / Payout Owner in setup before using this command.",
  );
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

function trelloBoardIdFromInput(value: string): string {
  const input = value.trim();
  if (!input) throw new Error("Provide a Trello board ID or https://trello.com/b/ board URL.");
  let boardId = input;
  if (/^https?:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new Error("Provide a valid Trello board URL.");
    }
    if (!/(^|\.)trello\.com$/i.test(url.hostname)) {
      throw new Error("The board URL must be on trello.com.");
    }
    const match = /^\/b\/([^/]+)/.exec(url.pathname);
    if (!match) throw new Error("Use a Trello board URL in the form https://trello.com/b/BOARD_ID/...");
    boardId = match[1]!;
  }
  if (!/^[A-Za-z0-9_-]{5,100}$/.test(boardId)) {
    throw new Error("The Trello board ID must contain 5–100 letters, numbers, underscores, or hyphens.");
  }
  return boardId;
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
    if (
      settings.recentPermissionEscalationProtection &&
      administratorInEscalationWindow(state, actorId, now)
    ) {
      return {
        lockdownActivated: false,
        denial: "This administrator permission was granted recently or has not previously been observed. Destructive commands are delayed for 10 minutes.",
      };
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
      action: "Destructive action denied by security policy",
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
  return protectTargetIdentity(guild, member.id, member, setup);
}

async function protectTargetIdentity(
  guild: Guild,
  discordUserId: string,
  member: GuildMember | undefined,
  setup: GuildSetup,
): Promise<void> {
  const settings = securitySettingsFor(setup);
  const protectedTarget = discordUserId === guild.ownerId ||
    discordUserId === guild.members.me?.id ||
    settings.protectedUserIds.includes(discordUserId) ||
    Boolean(member?.roles.cache.some((role) => settings.protectedRoleIds.includes(role.id)));
  if (!protectedTarget) return;
  await auditBestEffort(guild, setup, {
    action: "Protected blacklist target denied", status: "failed", actorId: guild.client.user?.id ?? setup.updatedBy,
    target: `<@${discordUserId}> (${discordUserId})`,
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

class DiscordIdentityRequiredError extends Error {
  cardId?: string;

  constructor(message: string, cardId?: string) {
    super(message);
    this.name = "DiscordIdentityRequiredError";
    this.cardId = cardId;
  }
}

function moderationRobloxUsername(interaction: ChatInputCommandInteraction): string {
  const username = interaction.options.getString("username") ??
    interaction.options.getString("user");
  if (!username) throw new Error("A Roblox username is required.");
  return username;
}

function memberIdentityNames(member: GuildMember): Set<string> {
  const user = member.user as typeof member.user & { tag?: string };
  return new Set(
    [user.username, user.globalName, member.nickname, user.tag]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.trim().toLowerCase()),
  );
}

function identityMatches(member: GuildMember, input: string): boolean {
  return memberIdentityNames(member).has(input.trim().toLowerCase());
}

function memberResults(value: unknown): GuildMember[] {
  if (!value || typeof value !== "object") return [];
  const candidate = value as {
    id?: string;
    values?: () => Iterable<GuildMember>;
  };
  if (typeof candidate.id === "string") return [value as GuildMember];
  if (typeof candidate.values === "function") return [...candidate.values()];
  return [];
}

async function resolveMember(
  interaction: ChatInputCommandInteraction,
  robloxUsername: string,
): Promise<GuildMember> {
  const normalized = robloxUsername.trim().toLowerCase();
  const guild = interaction.guild!;
  // The option is intentionally not registered anymore. This compatibility
  // path only accepts stale interaction fixtures/old payloads during command
  // rollout; newly registered slash commands can only use the identity prompt.
  try {
    const legacyUser = interaction.options.getUser("discord_user");
    if (legacyUser?.id) {
      const fetched = await guild.members.fetch(legacyUser.id);
      const member = memberResults(fetched).find((candidate) => candidate.id === legacyUser.id);
      if (member) return member;
    }
  } catch {
    // Ignore absent legacy options and use cached/server identity resolution.
  }
  const cached = guild.members.cache
    ? [...guild.members.cache.values()].filter((member) => identityMatches(member, normalized))
    : [];
  let matches = cached;

  // Discord has no global username lookup. A query fetch is limited to
  // server identities and avoids a full member scan on every continuation.
  if (matches.length === 0 && typeof guild.members.fetch === "function") {
    try {
      const fetched = await guild.members.fetch({ query: robloxUsername.trim(), limit: 10 });
      matches = memberResults(fetched).filter((member) => identityMatches(member, normalized));
    } catch {
      // The account prompt below gives administrators the numeric-ID path when
      // Discord cannot search the server identity.
    }
  }

  if (matches.length === 0) {
    throw new DiscordIdentityRequiredError(
      `I could not match Roblox username "${robloxUsername}" to a Discord member. Provide a Discord tag/username or numeric user ID to continue.`,
    );
  }
  if (matches.length > 1) {
    throw new DiscordIdentityRequiredError(
      `More than one Discord member matches "${robloxUsername}". Provide the matching Discord tag or numeric user ID to continue.`,
    );
  }

  return matches[0]!;
}

interface ResolvedDiscordIdentity {
  userId: string;
  member?: GuildMember;
}

function discordIdFromInput(input: string): string | undefined {
  const mention = /^<@!?(\d{5,25})>$/.exec(input.trim());
  if (mention) return mention[1];
  if (/^\d{5,25}$/.test(input.trim())) return input.trim();
  return undefined;
}

async function resolveDiscordIdentity(
  guild: Guild,
  rawInput: string,
): Promise<ResolvedDiscordIdentity> {
  const input = rawInput.trim();
  if (!input || input.length > 100 || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new Error("Provide a Discord tag, username, or numeric user ID.");
  }
  const explicitId = discordIdFromInput(input);
  if (explicitId) {
    const users = guild.client?.users;
    if (!users || typeof users.fetch !== "function") {
      throw new Error("Discord account lookup is unavailable. Retry with a numeric ID later.");
    }
    let user: { id?: string };
    try {
      user = await users.fetch(explicitId);
    } catch {
      throw new Error(`Discord user ID ${explicitId} could not be fetched. Check the ID and retry.`);
    }
    if (!user || user.id !== explicitId) {
      throw new Error(`Discord user ID ${explicitId} could not be validated. Check the ID and retry.`);
    }
    let member: GuildMember | undefined;
    try {
      const fetched = await guild.members.fetch(explicitId);
      member = memberResults(fetched).find((candidate) => candidate.id === explicitId);
    } catch {
      // A valid Discord user need not be a member of this server.
    }
    return { userId: explicitId, member };
  }

  const normalized = input.toLowerCase();
  const cached = guild.members.cache
    ? [...guild.members.cache.values()].filter((member) => identityMatches(member, normalized))
    : [];
  let matches = cached;
  if (matches.length === 0 && typeof guild.members.fetch === "function") {
    try {
      const fetched = await guild.members.fetch({ query: input, limit: 10 });
      matches = memberResults(fetched).filter((member) => identityMatches(member, normalized));
    } catch {
      // No server identity was available for this username/tag.
    }
  }
  if (matches.length === 1) return { userId: matches[0]!.id, member: matches[0] };
  if (matches.length > 1) {
    throw new Error(
      `That Discord username/tag matches more than one server identity. Retry with the numeric Discord user ID.`,
    );
  }
  throw new Error(
    "Discord cannot globally look up arbitrary usernames. No unambiguous server identity matched; retry with the numeric Discord user ID.",
  );
}

function setupSessionId(guildId: string, userId: string): string {
  return `setup:${guildId}:${userId}`;
}

function sealSettingsComponents(payload: unknown, nonce: string): unknown {
  const seal = (component: unknown) => {
    const candidate = component as {
      data?: { custom_id?: string; type?: number };
      components?: unknown[];
      setCustomId?: (id: string) => unknown;
    };
    const id = candidate.data?.custom_id;
    // The modal carries the session nonce. Its input IDs are stable field keys
    // read by getTextInputValue(), not independently actionable controls.
    if (id && candidate.data?.type !== ComponentType.TextInput &&
        !id.endsWith(`:${nonce}`) && typeof candidate.setCustomId === "function") {
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
  { id: "uploading", label: "Uploading", description: "Uniform destinations, spreadsheets, and submitter access" },
  { id: "blacklisting", label: "Blacklisting", description: "Blacklist rules, records, Trello, and identity lookup" },
  { id: "global", label: "Global", description: "Payout owner, security, audit, and essential bot controls" },
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
    return settingsCategories.filter((category) => category.id === "global");
  }
  return settingsCategories;
}

function settingsCategoryOptions(
  category: SettingsCategory,
  configured: boolean,
  maintenance: boolean,
): SettingsOption[] {
  if (maintenance) {
    if (category === "global") {
      return [
        { label: "System Status", value: "settings-action:status", description: "View current emergency and command status" },
        { label: "Security Lockdown", value: "settings-action:lockdown", description: "Immediately stop destructive actions" },
        { label: "Security Unlock", value: "settings-action:unlock", description: "Unlock after confirmation" },
        { label: "Disable Maintenance", value: "settings-action:maintenance-disable", description: "Restore normal administration" },
      ];
    }
    return [];
  }

  if (!configured) {
    if (category === "global") {
      return [
        { label: "Complete First-time Setup", value: "settings-action:initial-audit", description: "Select required audit and Quartermaster roles" },
        { label: "System Status", value: "settings-action:status", description: "View setup and command registration status" },
        { label: "Security Lockdown", value: "settings-action:lockdown", description: "Immediately stop destructive actions" },
        { label: "Security Unlock", value: "settings-action:unlock", description: "Unlock after confirmation" },
        { label: "Enable Maintenance", value: "settings-action:maintenance-enable", description: "Temporarily lock normal administration" },
        { label: "Disable Maintenance", value: "settings-action:maintenance-disable", description: "Restore normal administration" },
      ];
    }
    return [];
  }

  switch (category) {
    case "uploading":
      return [
        { label: "Uniform Uploading", value: "setup:uniforms", description: "Channels, spreadsheet, recovery, and submitter access" },
      ];
    case "blacklisting":
      return [
        { label: "Blacklist Rules", value: "setup:blacklist", description: "Discord role and Trello list mappings" },
        { label: "Trello Configuration", value: "setup:trello", description: "Blacklist monitoring and polling configuration" },
        { label: "Sync Monitoring Report", value: "settings-action:sync", description: "Run a monitoring-only Trello report" },
        { label: "Blacklist a Group", value: "settings-action:group", description: "Create a group blacklist record" },
        { label: "Add Blacklist Note", value: "settings-action:note", description: "Record a durable moderation note" },
        { label: "Identity Lookup", value: "settings-action:identity-lookup", description: "Search recorded associations" },
      ];
    case "global":
      return [
        { label: "Payout Owner & Discord Roles", value: "setup:discord", description: "Set the payout owner and named Quartermaster roles" },
        { label: "Security Configuration", value: "setup:security", description: "Limits, protections, and confirmations" },
        { label: "Security Lockdown", value: "settings-action:lockdown", description: "Immediately stop destructive actions" },
        { label: "Security Unlock", value: "settings-action:unlock", description: "Unlock after confirmation" },
        { label: "Identity Detection", value: "setup:identity", description: "Warning-only association controls" },
        { label: "Audit Configuration", value: "setup:audit", description: "Destinations and retained log categories" },
        { label: "System Status", value: "settings-action:status", description: "View command, Trello, and security status" },
        { label: "Enable Maintenance", value: "settings-action:maintenance-enable", description: "Temporarily lock normal administration" },
        { label: "Disable Maintenance", value: "settings-action:maintenance-disable", description: "Restore normal administration" },
        { label: "Bot State", value: "setup:bot-state", description: "View emergency availability and controls" },
        { label: "View Configuration", value: "setup:view", description: "Review active server configuration" },
      ];
  }
}

function settingsMenu(
  nonce: string,
  configured: boolean,
  maintenance = false,
  setup?: GuildSetup,
): {
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
          ? `**Core setup: ${setup?.auditChannelId && setup?.seniorQuartermasterRoleId && setup?.quartermasterRoleId && setup?.securityOwnerId ? "complete" : "incomplete—review Payout Owner & Discord Roles"}**\n` +
            `**Optional locations: ${setup?.uniforms?.spreadsheet ? "spreadsheet configured" : "spreadsheet not configured"}; ${setup?.uniforms?.logChannelId || setup?.uniforms?.moderatedChannelId ? "uniform channel configured" : "uniform channels not configured"}**\n\n` +
            "Choose a category to manage Quartermaster. Controls are private, expire after 10 minutes, and re-check your current Administrator permission. **Uploading** contains uniform channels, spreadsheet, recovery, and access settings. **Blacklisting** contains blacklist rules, Trello monitoring, records, and identity lookup. **Global** contains the payout owner, security, audit, maintenance, and essential bot controls."
          : "Initial setup is required. Open Global to select the audit channel, Senior Quartermaster, Quartermaster, and Security / Payout Owner. Emergency status and security controls remain available.",
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

type SettingsSelectInteraction =
  | StringSelectMenuInteraction
  | RoleSelectMenuInteraction
  | ChannelSelectMenuInteraction
  | UserSelectMenuInteraction;
type SettingsComponentInteraction = ButtonInteraction | SettingsSelectInteraction;

function selectedSettingsValue(interaction: SettingsSelectInteraction): string {
  const value = interaction.values[0];
  if (!value) throw new Error("Select one server role or channel and try again.");
  return value;
}

function initialSetupPanel(session: SetupSession): {
  embeds: EmbedBuilder[];
  components: Array<
    | ActionRowBuilder<ChannelSelectMenuBuilder>
    | ActionRowBuilder<RoleSelectMenuBuilder>
    | ActionRowBuilder<UserSelectMenuBuilder>
    | ActionRowBuilder<ButtonBuilder>
  >;
} {
  const selected = session.initialSetup ?? {};
  const ready = Boolean(
    selected.auditChannelId &&
    selected.seniorQuartermasterRoleId &&
    selected.quartermasterRoleId &&
    selected.securityOwnerId,
  );
  const status = (value: string | undefined, prefix: "#" | "@&" | "@") =>
    value ? `<${prefix}${value}> — selected` : "Required — not selected";
  return {
    embeds: [brandedEmbed(
      "Complete Quartermaster Setup",
      "Select the required server resources, then save. Each selector is limited to this server. " +
      "Senior Quartermaster and Quartermaster roles authorize **uniform logging only**; " +
      "Discord Administrator permission remains required for settings, payouts, and blacklists.",
    ).addFields(
      { name: "Audit Channel", value: status(selected.auditChannelId, "#"), inline: true },
      { name: "Senior Quartermaster", value: status(selected.seniorQuartermasterRoleId, "@&"), inline: true },
      { name: "Quartermaster", value: status(selected.quartermasterRoleId, "@&"), inline: true },
      { name: "Security / Payout Owner", value: status(selected.securityOwnerId, "@"), inline: true },
      { name: "Next step", value: ready ? "All required selections are ready. Choose **Save Core Setup**." : "Choose all four required selections before saving." },
    )],
    components: [
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`settings:initial-audit:${session.nonce}`)
          .setPlaceholder("Select the audit text channel")
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(1)
          .setMaxValues(1),
      ),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`settings:initial-senior-quartermaster:${session.nonce}`)
          .setPlaceholder("Select the Senior Quartermaster role")
          .setMinValues(1)
          .setMaxValues(1),
      ),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`settings:initial-quartermaster:${session.nonce}`)
          .setPlaceholder("Select the Quartermaster role")
          .setMinValues(1)
          .setMaxValues(1),
      ),
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`settings:initial-security-owner:${session.nonce}`)
          .setPlaceholder("Select the security and payout owner")
          .setMinValues(1)
          .setMaxValues(1),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`settings:initial-save:${session.nonce}`)
          .setLabel("Save Core Setup")
          .setStyle(ButtonStyle.Success)
          .setDisabled(!ready),
        new ButtonBuilder()
          .setCustomId(`settings:back:root:${session.nonce}`)
          .setLabel("Back to Categories")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function discordRolePanel(setup: GuildSetup, nonce: string): {
  embeds: EmbedBuilder[];
  components: Array<
    | ActionRowBuilder<RoleSelectMenuBuilder>
    | ActionRowBuilder<UserSelectMenuBuilder>
    | ActionRowBuilder<ButtonBuilder>
  >;
} {
  const role = (id: string | undefined) => id ? `<@&${id}>` : "Not configured";
  const member = (id: string | undefined) => id ? `<@${id}>` : "Not configured";
  return {
    embeds: [outcomeEmbed(
      "Payout Owner & Discord Roles",
      "The Security / Payout Owner is the only configured member allowed to run payouts or change destructive-action security limits, and only the Discord server owner can replace that member. " +
      "The named Quartermaster roles are persistent, narrowly scoped uniform submitter access. " +
      "They do not grant Discord Administrator access, settings access, payout access, or blacklist privileges. " +
      "The moderator-role record remains separate and also does not replace current Discord Administrator checks. " +
      "Choose a replacement role to save it immediately.",
      "info",
      [
        { name: "Moderation role record", value: role(setup.moderatorRoleId === setup.guildId ? undefined : setup.moderatorRoleId), inline: true },
        { name: "Senior Quartermaster", value: role(setup.seniorQuartermasterRoleId), inline: true },
        { name: "Quartermaster", value: role(setup.quartermasterRoleId), inline: true },
        { name: "Security / Payout Owner", value: member(setup.securityOwnerId), inline: true },
        { name: "Administrative authorization", value: "Current Discord Administrator or server owner only" },
      ],
    )],
    components: [
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`setup:discord-moderator:${nonce}`)
          .setPlaceholder("Select recorded moderator role")
          .setMinValues(1)
          .setMaxValues(1),
      ),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`setup:discord-senior-quartermaster:${nonce}`)
          .setPlaceholder("Select Senior Quartermaster role")
          .setMinValues(1)
          .setMaxValues(1),
      ),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`setup:discord-quartermaster:${nonce}`)
          .setPlaceholder("Select Quartermaster role")
          .setMinValues(1)
          .setMaxValues(1),
      ),
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`setup:security-owner:${nonce}`)
          .setPlaceholder("Select Security / Payout Owner")
          .setMinValues(1)
          .setMaxValues(1),
      ),
    ],
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
        : `Choose an option. Related ${definition.label.toLowerCase()} controls are grouped here; use Back to return to categories.`,
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
    ["uniforms", "Uniform Uploading"],
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
  interaction: SettingsComponentInteraction | ModalSubmitInteraction,
): Promise<{ session: SetupSession; setup?: GuildSetup }> {
  if (!interaction.guild) throw new Error("Settings are only available in the configured server.");
  const session = setupSessions.get(setupSessionId(interaction.guild.id, interaction.user.id));
  if (!session || session.expiresAt <= Date.now() || session.guildId !== interaction.guild.id) {
    throw new Error("This settings session has expired or belongs to another administrator. Run /settings again.");
  }
  // String-menu option values carry the nonce; native role/channel selector
  // values are resource IDs, so their nonce must always come from customId.
  const raw = interaction.isStringSelectMenu?.()
    ? interaction.values[0]
    : interaction.customId;
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
  const response = await interaction.editReply(settingsMenu(nonce, Boolean(existing), state.maintenance.active, existing));
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
  interaction: SettingsComponentInteraction | ModalSubmitInteraction,
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
  ) return "blacklisting";
  if (id === "setup:trello" || id === "settings-action:sync") return "blacklisting";
  if (
    id === "setup:security" ||
    id === "setup:lockdown" ||
    id === "setup:identity" ||
    id === "settings-action:lockdown" ||
    id === "settings-action:unlock"
  ) return "global";
  if (id === "setup:audit" || id === "setup:discord") return "global";
  if (
    id === "setup:uniforms" ||
    id === "setup:uniforms-config" ||
    id === "setup:uniforms-reset" ||
    id === "setup:uniforms-spreadsheet-config" ||
    id === "setup:uniforms-spreadsheet-reset" ||
    id === "setup:uniforms-recover"
  ) return "uploading";
  if (
    id === "setup:bot-state" ||
    id === "setup:view" ||
    id === "settings-action:status" ||
    id === "settings-action:initial-audit" ||
    id === "settings-action:maintenance-enable" ||
    id === "settings-action:maintenance-disable"
  ) return "global";
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
    await interaction.update(settingsMenu(session.nonce, Boolean(setup), state.maintenance.active, setup));
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
    const categoryLocation = settingsCategoryLocation("global");
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
  interaction: SettingsComponentInteraction,
): Promise<void> {
  const { session, setup } = await requireSettingsSession(interaction);
  const raw = interaction.isStringSelectMenu()
    ? selectedSettingsValue(interaction)
    : interaction.customId;
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
    await renderSettingsBack(interaction as ButtonInteraction, session, setup, "root");
    return;
  }
  if (id.startsWith("settings:back:category:")) {
    const targetCategory = id.slice("settings:back:category:".length) as SettingsCategory;
    const expected = settingsCurrentParent(session);
    if (expected.kind !== "category" || expected.category !== targetCategory) {
      throw new Error("This settings control is stale. Return to /settings and choose a category again.");
    }
    await renderSettingsBack(interaction as ButtonInteraction, session, setup, `category:${targetCategory}`);
    return;
  }
  if (id.startsWith("settings:back:page:")) {
    const targetPage = id.slice("settings:back:page:".length);
    const expected = settingsCurrentParent(session);
    if (expected.kind !== "page" || expected.id !== targetPage) {
      throw new Error("This settings control is stale. Return to /settings and choose a page again.");
    }
    await renderSettingsBack(interaction as ButtonInteraction, session, setup, `page:${targetPage}`);
    return;
  }
  if (id === "settings-action:initial-audit") {
    if (setup) throw new Error("Setup is already complete. Use Discord Identity & Uniform Roles to update role assignments.");
    session.initialSetup ??= {};
    await interaction.update(initialSetupPanel(session));
    return;
  }
  if (id.startsWith("settings:initial-")) {
    if (setup) throw new Error("Setup is already complete. Run /settings to change saved configuration.");
    session.initialSetup ??= {};
    if (id === "settings:initial-audit") {
      const channelId = selectedSettingsValue(interaction as SettingsSelectInteraction);
      await requireAuditChannel(interaction.guild!, {
        guildId: interaction.guild!.id,
        moderatorRoleId: interaction.guild!.id,
        auditChannelId: channelId,
        updatedBy: interaction.user.id,
        updatedAt: new Date().toISOString(),
      });
      session.initialSetup.auditChannelId = channelId;
      await interaction.update(initialSetupPanel(session));
      return;
    }
    if (id === "settings:initial-senior-quartermaster" || id === "settings:initial-quartermaster") {
      const roleId = selectedSettingsValue(interaction as SettingsSelectInteraction);
      const role = await interaction.guild!.roles.fetch(roleId);
      if (!role) throw new Error("The selected role does not exist in this server.");
      validateModeratorRole(interaction.guild!, role);
      if (id === "settings:initial-senior-quartermaster") {
        session.initialSetup.seniorQuartermasterRoleId = roleId;
      } else {
        session.initialSetup.quartermasterRoleId = roleId;
      }
      await interaction.update(initialSetupPanel(session));
      return;
    }
    if (id === "settings:initial-security-owner") {
      await requireServerOwner(interaction.guild!, interaction.user.id, undefined, id);
      const ownerId = selectedSettingsValue(interaction as SettingsSelectInteraction);
      const owner = await interaction.guild!.members.fetch({ user: ownerId, force: true });
      if (
        owner.id !== interaction.guild!.ownerId &&
        !owner.permissions.has(PermissionFlagsBits.Administrator)
      ) {
        throw new Error("The selected Security / Payout Owner must be the server owner or a current Administrator.");
      }
      session.initialSetup.securityOwnerId = ownerId;
      await interaction.update(initialSetupPanel(session));
      return;
    }
    if (id === "settings:initial-save") {
      const selected = session.initialSetup;
      if (
        !selected.auditChannelId ||
        !selected.seniorQuartermasterRoleId ||
        !selected.quartermasterRoleId ||
        !selected.securityOwnerId
      ) {
        throw new Error("Select an audit channel, Senior Quartermaster role, Quartermaster role, and Security / Payout Owner before saving.");
      }
      const initial: GuildSetup = {
        guildId: interaction.guild!.id,
        // Kept for compatibility with older records; it grants no authorization.
        moderatorRoleId: interaction.guild!.id,
        auditChannelId: selected.auditChannelId,
        seniorQuartermasterRoleId: selected.seniorQuartermasterRoleId,
        quartermasterRoleId: selected.quartermasterRoleId,
        securityOwnerId: selected.securityOwnerId,
        security: defaultSecuritySettings(),
        monitoring: defaultMonitoringSettings(),
        trello: defaultTrelloMappings(),
        audit: defaultAuditSettings(),
        identity: defaultIdentitySettings(),
        updatedBy: interaction.user.id,
        updatedAt: new Date().toISOString(),
      };
      await requireAuditChannel(interaction.guild!, initial);
      await saveGuildSetup(initial);
      await sendAuditEvent(interaction.guild!, initial, {
        action: "Bot setup completed", status: "success", actorId: interaction.user.id,
        fields: [
          { name: "Audit channel", value: `<#${initial.auditChannelId}>` },
          { name: "Senior Quartermaster", value: `<@&${initial.seniorQuartermasterRoleId}>` },
          { name: "Quartermaster", value: `<@&${initial.quartermasterRoleId}>` },
        ],
      });
      await registerGuildCommands(interaction.guild!, true);
      commandsRegistered = true;
      setupCommandRegistered = true;
      guildSetupComplete = true;
      setRecoveryStatus("successful");
      await interaction.update(responseWithEmbed(
        "Core setup is saved. Open /settings to configure Trello, blacklist mappings, audit destinations, and uniform spreadsheet settings.",
        "Setup Complete",
        "success",
      ));
      return;
    }
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

async function handleSetupComponent(interaction: SettingsComponentInteraction): Promise<void> {
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
  if (ownerOnlySecurityControls.has(id)) {
    if (id === "setup:security-owner") {
      await requireServerOwner(guild, interaction.user.id, setup, id);
    } else {
      await requireConfiguredSecurityOwner(guild, interaction.user.id, setup, id);
    }
  }
  const nonce = rawId.match(/:([a-f0-9]{32})$/)?.[1];
  if (nonce && activeSession?.nonce !== nonce) {
    throw new Error("This settings control belongs to an expired settings session. Run /settings again.");
  }
  if (activeSession?.nonceRequired && id.startsWith("setup:")) {
    const pageIds = new Set([
      "setup:blacklist", "setup:trello", "setup:security", "setup:lockdown",
      "setup:audit", "setup:discord", "setup:identity", "setup:uniforms", "setup:bot-state", "setup:view",
    ]);
    if (pageIds.has(id)) {
      const current = settingsNavigation(activeSession).at(-1);
      if (current?.kind === "page" && current.id === id) {
        // The category select has already established this page.
      } else if (current?.kind === "page" && id === "setup:security") {
        const categoryLocation = settingsCategoryLocation("global");
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
  if (id === "setup:uniforms") {
    await renderUniformSettings(interaction as ButtonInteraction, setup, botAvatarUrl());
    return;
  }
  if (id === "setup:discord") {
    await interaction.update(discordRolePanel(setup, activeSession?.nonce ?? nonce ?? ""));
    return;
  }
  if (
    id === "setup:discord-moderator" ||
    id === "setup:discord-senior-quartermaster" ||
    id === "setup:discord-quartermaster"
  ) {
    if (!interaction.isRoleSelectMenu()) {
      throw new Error("Choose the Quartermaster role with the server role selector.");
    }
    const roleId = selectedSettingsValue(interaction);
    const role = await guild.roles.fetch(roleId);
    if (!role) throw new Error("The selected role does not exist in this server.");
    validateModeratorRole(guild, role);
    const key = id === "setup:discord-moderator"
      ? "moderatorRoleId"
      : id === "setup:discord-senior-quartermaster"
        ? "seniorQuartermasterRoleId"
        : "quartermasterRoleId";
    const updated = await saveSetupChange(
      guild,
      { ...setup, [key]: roleId },
      interaction.user.id,
      key === "moderatorRoleId"
        ? "Recorded moderator role"
        : key === "seniorQuartermasterRoleId"
          ? "Senior Quartermaster uniform role"
          : "Quartermaster uniform role",
      setup[key] ?? "Not configured",
      roleId,
    );
    await interaction.update(discordRolePanel(updated, activeSession?.nonce ?? nonce ?? ""));
    return;
  }
  if (id === "setup:security-owner") {
    if (!interaction.isUserSelectMenu()) {
      throw new Error("Choose the Security / Payout Owner with the server member selector.");
    }
    const ownerId = selectedSettingsValue(interaction);
    const owner = await guild.members.fetch({ user: ownerId, force: true });
    if (
      owner.id !== guild.ownerId &&
      !owner.permissions.has(PermissionFlagsBits.Administrator)
    ) {
      throw new Error("The selected Security / Payout Owner must be the server owner or a current Administrator.");
    }
    const updated = await saveSetupChange(
      guild,
      { ...setup, securityOwnerId: ownerId },
      interaction.user.id,
      "Security / Payout Owner",
      setup.securityOwnerId ?? "Not configured",
      ownerId,
    );
    await interaction.update(discordRolePanel(updated, activeSession?.nonce ?? nonce ?? ""));
    return;
  }
  if (
    id === "setup:uniforms-config" ||
    id === "setup:uniforms-reset" ||
    id === "setup:uniforms-spreadsheet-config" ||
    id === "setup:uniforms-spreadsheet-reset" ||
    id === "setup:uniforms-recover"
  ) {
    if (!interaction.isButton()) {
      throw new Error("Uniforms settings controls must be used from their settings page.");
    }
    await handleUniformSettingsComponent(interaction, setup);
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
    ), new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(`setup:blacklist-role-select:${activeSession?.nonce ?? nonce ?? ""}`)
        .setPlaceholder("Select blacklisted Discord role")
        .setMinValues(1)
        .setMaxValues(1),
    )] });
    return;
  }
  if (id === "setup:blacklist-role-select") {
    if (!interaction.isRoleSelectMenu()) {
      throw new Error("Choose the blacklist role with the server role selector.");
    }
    const roleId = selectedSettingsValue(interaction);
    const role = await guild.roles.fetch(roleId);
    if (!role) throw new Error("The selected blacklist role does not exist in this server.");
    validateModeratorRole(guild, role);
    await saveSetupChange(
      guild,
      { ...setup, blacklistRoleId: roleId },
      interaction.user.id,
      "Blacklisted Discord role",
      setup.blacklistRoleId ?? "None",
      roleId,
    );
    await interaction.update({
      ...responseWithEmbed("Blacklist role mapping saved and validated.", "Blacklist Role Saved", "success"),
      components: [],
    });
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
    const current = trelloMappingsFor(setup);
    const defaults = defaultTrelloMappings();
    // Reset names only. A board is independently selected and must never be
    // silently switched back to an environment legacy fallback.
    const mapping = {
      boardId: current.boardId,
      lists: defaults.lists,
      labels: defaults.labels,
    };
    await validateTrelloMappings(mapping);
    await saveSetupChange(guild, { ...setup, trello: mapping }, interaction.user.id, "Trello mappings", JSON.stringify(current), JSON.stringify(mapping));
    await interaction.update({
      ...responseWithEmbed("Default Trello mappings were validated against the board and saved.", "Trello Mappings Saved", "success"),
      components: [],
    });
    return;
  }
  if (id === "setup:trello") {
    const monitoring = { ...defaultMonitoringSettings(), ...setup.monitoring };
    const mapping = trelloMappingsFor(setup);
    await interaction.update({ embeds: [outcomeEmbed("Trello Monitoring", "Monitoring is report-only for manual Trello edits; Discord state changes require approved bot actions.", "info", [
      { name: "Board", value: mapping.boardId ? safePresentationText(mapping.boardId) : "Not configured", inline: true },
      { name: "Connection", value: getTrelloReadiness().ready ? "Connected and verified" : "Not currently verified", inline: true },
      { name: "Manual Change Alerts", value: monitoring.manualChangeDetection ? "Enabled" : "Disabled", inline: true },
      { name: "Database Sync Checks", value: monitoring.desyncDetection ? "Enabled" : "Disabled", inline: true },
      { name: "Polling Interval", value: `${monitoring.pollingIntervalSeconds} seconds`, inline: true },
      { name: "Discord Role Changes", value: "Approved bot actions only", inline: true },
    ])], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("setup:trello-board").setLabel("Board & Connection").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("setup:trello-toggle").setLabel("Toggle manual alerts").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:trello-desync").setLabel("Toggle desync checks").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:trello-interval").setLabel("Polling interval").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup:trello-monitoring-reset").setLabel("Reset Defaults").setStyle(ButtonStyle.Secondary),
    )] });
    return;
  }
  if (id === "setup:trello-board") {
    const mapping = trelloMappingsFor(setup);
    await interaction.showModal(new ModalBuilder()
      .setCustomId(scopedSetupModalId(guild.id, interaction.user.id, "setup-modal:trello-board"))
      .setTitle("Trello Board")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("board")
          .setLabel("Trello board URL or board ID")
          .setStyle(TextInputStyle.Short)
          .setValue(mapping.boardId ?? "")
          .setRequired(true)
          .setMaxLength(300),
      )));
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
  if (id === "setup:view") {
    const uniforms = uniformSettingsFor(setup);
    await interaction.update({ embeds: [outcomeEmbed("Configuration", "Saved server configuration and authorization policy.", "info", [
      { name: "Audit Channel", value: `<#${setup.auditChannelId}>` },
      { name: "Blacklist Role", value: setup.blacklistRoleId ? `<@&${setup.blacklistRoleId}>` : "Not configured" },
       { name: "Administration", value: "Current Administrator permission only" },
       { name: "Senior Quartermaster", value: setup.seniorQuartermasterRoleId ? `<@&${setup.seniorQuartermasterRoleId}> — uniform logging only` : "Not configured" },
       { name: "Quartermaster", value: setup.quartermasterRoleId ? `<@&${setup.quartermasterRoleId}> — uniform logging only` : "Not configured" },
      { name: "Uniform /log", value: uniforms.logChannelId ? `<#${uniforms.logChannelId}>` : "Not configured", inline: true },
      { name: "Uniform /moderated", value: uniforms.moderatedChannelId ? `<#${uniforms.moderatedChannelId}>` : "Not configured", inline: true },
    ])], components: [] });
  }
}

async function handleSetupModal(interaction: ModalSubmitInteraction): Promise<void> {
  const setup = await requireSetupSession(interaction);
  const guild = interaction.guild!;
  const rawId = interaction.customId;
  const id = rawId.replace(/:([a-f0-9]{32})$/, "");
  if (ownerOnlySecurityControls.has(id)) {
    await requireConfiguredSecurityOwner(guild, interaction.user.id, setup, id);
  }
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
  if (id === "setup-modal:uniforms") {
    await handleUniformSettingsModal(interaction, setup);
    return;
  }
  if (id === "setup-modal:uniforms-recover") {
    await handleUniformRecoveryModal(interaction, setup);
    return;
  }
  if (id === "setup-modal:uniforms-spreadsheet") {
    await handleUniformSpreadsheetSettingsModal(interaction, setup);
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
  if (id === "setup-modal:trello-board") {
    const current = trelloMappingsFor(setup);
    const boardId = trelloBoardIdFromInput(interaction.fields.getTextInputValue("board"));
    const trello = { ...current, boardId };
    // This is a read-only credentials check: no token is displayed or
    // accepted, and mapping validation only reads the selected board.
    await validateTrelloMappings(trello);
    await saveSetupChange(
      guild,
      { ...setup, trello },
      interaction.user.id,
      "Trello board",
      current.boardId ?? "Not configured",
      boardId,
    );
    await interaction.reply({
      ...responseWithEmbed("The Trello board and existing list/label mappings were verified with the connected account and saved.", "Trello Board Saved", "success"),
      ephemeral: true,
    });
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
    const trello = { boardId: current.boardId, lists, labels };
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
    // Old messages may outlive a deployment. Do not let their ID-only modal
    // bypass the required native audit/Quartermaster selections.
    throw new Error("This first-time setup form is obsolete. Run /setup or /settings and use the server selectors.");
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
  let target: ModerationTarget | undefined;
  if (command === "blacklist" || command === "revoke_blacklist") {
    try {
      target = await resolveModerationTarget(interaction, command);
    } catch (error) {
      if (!(error instanceof DiscordIdentityRequiredError)) throw error;
      const robloxUser = await findRobloxUser(moderationRobloxUsername(interaction));
      const id = crypto.randomUUID().replaceAll("-", "");
      const nonce = crypto.randomUUID().replaceAll("-", "");
      identityPrompts.set(id, {
        userId: interaction.user.id,
        guildId: interaction.guild!.id,
        command,
        original: interaction,
        robloxUserId: robloxUser.id,
        robloxUsername: robloxUser.name,
        expiresAt: Date.now() + setupSessionLifetimeMs,
        nonce,
        ...(error.cardId ? { cardId: error.cardId } : {}),
      });
      await interaction.editReply({
        content: "",
        embeds: [outcomeEmbed(
          "Discord Account Needed",
          `${error.message}\n\nNo provider mutation, role change, or rate-limit reservation has been made. Use the button to provide a validated Discord identity.`,
          "warning",
          [
            { name: "Roblox User", value: `${safePresentationText(robloxUser.name)} (${displayId(robloxUser.id)})` },
            { name: "Target", value: "Discord member or verified nonmember account" },
          ],
        )],
        allowedMentions: noMentions,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`identity-prompt:${id}:${nonce}`)
            .setLabel("Provide Discord Account")
            .setStyle(ButtonStyle.Primary),
        )],
      });
      return;
    }
  }
  const id = crypto.randomUUID().replaceAll("-", "");
  confirmations.set(id, { userId: interaction.user.id, guildId: interaction.guild!.id, command, original: interaction, target, expiresAt: Date.now() + setupSessionLifetimeMs });
  await interaction.editReply({
    content: "",
    embeds: [outcomeEmbed("Confirm Action", `Review the requested /${command} operation. Your current Administrator permission will be checked again before execution.`, "warning", target ? [
      { name: "Roblox User", value: `${safePresentationText(target.robloxUsername)} (${displayId(target.robloxUserId)})` },
      {
        name: "Discord Account",
        value: `<@${target.discordUserId}> (${displayId(target.discordUserId)})\n${target.memberPresent ? "Current server member" : "Validated nonmember account"}`,
      },
    ] : undefined)],
    allowedMentions: noMentions,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`confirm:${id}`).setLabel("Confirm").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`cancel:${id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    )],
  });
}

async function resolveModerationTarget(
  interaction: ChatInputCommandInteraction,
  command: "blacklist" | "revoke_blacklist",
): Promise<ModerationTarget> {
  const robloxUser = await findRobloxUser(moderationRobloxUsername(interaction));
  const snapshot = command === "revoke_blacklist"
    ? await findPendingOrActiveSnapshot(interaction.guild!.id, robloxUser.id)
    : undefined;
  let cardId = snapshot?.cardId;
  if (command === "revoke_blacklist" && !cardId) {
    const configuredSetup = await getGuildSetup(interaction.guild!.id);
    const cards = await findBlacklistCardsByRobloxId(
      robloxUser.id,
      configuredSetup ? trelloMappingsFor(configuredSetup) : defaultTrelloMappings(),
    );
    const activeCards = cards.filter((card) => card.listType !== "revoked");
    if (activeCards.length !== 1) {
      throw new Error(
        activeCards.length === 0
          ? `No active Trello blacklist card was found for ${robloxUser.name} (${robloxUser.id}).`
          : `Multiple active Trello blacklist cards match ${robloxUser.name} (${robloxUser.id}); resolve the duplicate cards before revoking.`,
      );
    }
    cardId = activeCards[0]!.id;
  }
  let member: GuildMember | undefined;
  try {
    if (snapshot) {
      // A saved snapshot is the authority for revocation. The member may have
      // left and must not be re-resolved by a mutable username.
      try {
        const fetched = await interaction.guild!.members.fetch(snapshot.discordUserId);
        member = memberResults(fetched).find((candidate) => candidate.id === snapshot.discordUserId);
      } catch {
        member = undefined;
      }
    } else {
      member = await resolveMember(interaction, robloxUser.name);
    }
  } catch (error) {
    if (error instanceof DiscordIdentityRequiredError && cardId) {
      error.cardId = cardId;
    }
    throw error;
  }
  const discordUserId = snapshot?.discordUserId ?? member?.id;
  if (!discordUserId) throw new DiscordIdentityRequiredError(
    `I could not resolve a Discord identity for Roblox username "${robloxUser.name}".`,
    cardId,
  );
  return {
    discordUserId,
    robloxUserId: robloxUser.id,
    robloxUsername: robloxUser.name,
    memberPresent: Boolean(member),
    ...(command === "revoke_blacklist" && cardId
      ? { cardId }
      : {}),
  };
}

function confirmationPayload(command: string, target: ModerationTarget) {
  return {
    content: "",
    embeds: [outcomeEmbed(
      "Confirm Action",
      `Review the requested /${command} operation. Your current Administrator permission will be checked again before execution.`,
      "warning",
      [
        { name: "Roblox User", value: `${safePresentationText(target.robloxUsername)} (${displayId(target.robloxUserId)})` },
        {
          name: "Discord Account",
          value: `<@${target.discordUserId}> (${displayId(target.discordUserId)})\n${target.memberPresent ? "Current server member" : "Validated nonmember account"}`,
        },
      ],
    )],
    allowedMentions: noMentions,
    ephemeral: true,
  };
}

async function requireIdentityPrompt(
  interaction: ButtonInteraction | ModalSubmitInteraction,
): Promise<{ pending: DiscordIdentityPrompt; setup: GuildSetup }> {
  if (!interaction.guild) throw new Error("This account prompt is only available in the configured server.");
  const match = interaction.customId.match(/^identity-(?:prompt|modal):([a-f0-9]{32}):([a-f0-9]{32})$/);
  const id = match?.[1];
  const nonce = match?.[2];
  const pending = id ? identityPrompts.get(id) : undefined;
  const expectedPhase = interaction.customId.startsWith("identity-prompt:")
    ? "button"
    : "modal";
  if (
    !pending ||
    !nonce ||
    pending.nonce !== nonce ||
    pending.expiresAt <= Date.now() ||
    pending.userId !== interaction.user.id ||
    pending.guildId !== interaction.guild.id ||
    (expectedPhase === "button"
      ? pending.phase !== undefined
      : pending.phase !== "modal")
  ) {
    throw new Error("This Discord account prompt has expired or belongs to another administrator.");
  }
  // Claim before the first await. Discord can deliver duplicate button/modal
  // interactions while the member/provider lookup is still in flight.
  pending.phase = expectedPhase === "button" ? "button" : "resolving";
  try {
    const setup = await getGuildSetup(interaction.guild.id);
    await requireCurrentAdministrator(interaction.guild, interaction.user.id, setup, `/${pending.command} account prompt`);
    const state = await getSecurityState(interaction.guild.id);
    if (state.maintenance.active) throw new Error(maintenanceMessage);
    if (state.lockdown.active) throw new Error(`Security lockdown is active: ${state.lockdown.reason || "no reason provided"}.`);
    if (!setup) throw new Error("Complete setup before continuing this moderation action.");
    return { pending, setup };
  } catch (error) {
    // Permission/state failures do not consume the prompt. Releasing only this
    // still-current object permits a controlled retry after the administrator
    // restores setup/state, while duplicate in-flight interactions remain
    // rejected by the synchronous phase claim above.
    if (id && identityPrompts.get(id) === pending) {
      pending.phase = expectedPhase === "button" ? undefined : "modal";
    }
    throw error;
  }
}

async function handleIdentityPromptButton(interaction: ButtonInteraction): Promise<void> {
  const { pending } = await requireIdentityPrompt(interaction);
  const match = interaction.customId.match(/^identity-prompt:([a-f0-9]{32}):([a-f0-9]{32})$/);
  if (!match) throw new Error("This Discord account prompt is invalid.");
  const [, id, nonce] = match;
  // Keep the prompt claimed while opening the modal; a second button click
  // must not produce another modal or continuation.
  pending.phase = "modal";
  try {
    await interaction.showModal(new ModalBuilder()
      .setCustomId(`identity-modal:${id}:${nonce}`)
      .setTitle("Provide Discord Account")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("discord_identity")
          .setLabel("Discord tag, username, or numeric ID")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100),
      )));
  } catch (error) {
    if (id && identityPrompts.get(id) === pending) pending.phase = undefined;
    throw error;
  }
}

async function handleIdentityPromptModal(interaction: ModalSubmitInteraction): Promise<void> {
  const { pending } = await requireIdentityPrompt(interaction);
  const rawIdentity = interaction.fields.getTextInputValue("discord_identity");
  let resolved: ResolvedDiscordIdentity;
  try {
    resolved = await resolveDiscordIdentity(interaction.guild!, rawIdentity);
  } catch (error) {
    // Keep the prompt alive so a bad tag/ID can be corrected without creating
    // a confirmation, reserving a rate slot, touching Trello, or changing
    // roles.
    if (identityPrompts.get(interaction.customId.split(":")[1] ?? "") === pending) {
      pending.phase = "modal";
    }
    await interaction.reply({
      ...errorResponse(error instanceof Error ? error.message : "Discord account lookup failed.", "Discord Account Not Resolved"),
      ephemeral: true,
    });
    return;
  }
  const target: ModerationTarget = {
    discordUserId: resolved.userId,
    robloxUserId: pending.robloxUserId,
    robloxUsername: pending.robloxUsername,
    memberPresent: Boolean(resolved.member),
    ...(pending.command === "revoke_blacklist" && pending.cardId
      ? { cardId: pending.cardId }
      : {}),
  };
  const promptId = interaction.customId.split(":")[1];
  // Delete the claimed prompt before creating the confirmation or awaiting
  // Discord. A valid modal can therefore be consumed only once.
  if (promptId && identityPrompts.get(promptId) === pending) identityPrompts.delete(promptId);
  const confirmationId = crypto.randomUUID().replaceAll("-", "");
  confirmations.set(confirmationId, {
    userId: pending.userId,
    guildId: pending.guildId,
    command: pending.command,
    original: pending.original,
    target,
    expiresAt: Date.now() + setupSessionLifetimeMs,
  });
  await interaction.reply({
    ...confirmationPayload(pending.command, target),
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`confirm:${confirmationId}`).setLabel("Confirm").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`cancel:${confirmationId}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
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
  setDiscordOperationalPresence(active);
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
  if (pending.claimed) throw new Error("This maintenance confirmation is already being processed.");
  // Claim synchronously before setup/permission reads. Only the first
  // duplicate interaction may reserve and commit the transition.
  pending.claimed = true;
  let setup: GuildSetup | undefined;
  try {
    setup = await getGuildSetup(pending.guildId);
    await requireCurrentAdministrator(interaction.guild, interaction.user.id, setup, "/maintenance confirmation");
  } catch (error) {
    if (id && maintenanceConfirmations.get(id) === pending) pending.claimed = false;
    throw error;
  }
  if (interaction.customId.startsWith("maintenance-cancel:")) {
    maintenanceConfirmations.delete(id!);
    await interaction.update({
      ...responseWithEmbed("Maintenance change cancelled.", "Maintenance Change Cancelled", "info"),
      components: [],
    });
    return;
  }
  maintenanceConfirmations.delete(id!);
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
  if (!interaction.guild) throw new Error("Bot setup is unavailable.");
  if (pending.claimed) throw new Error("This confirmation is already being processed.");
  // Claim before any await. The map entry is deleted below only after the
  // synchronous cancel/authorization checks, so a duplicate cannot reserve a
  // second destructive-action slot.
  pending.claimed = true;
  const cancellation = interaction.customId.startsWith("cancel:");
  // A confirmation token is already atomically claimed. Acknowledge the
  // Discord button immediately instead of making that acknowledgement wait on
  // file-backed setup/security reads; authorization and every destructive
  // check still happen before provider work below.
  if (!cancellation) await interaction.deferUpdate();
  let setup: GuildSetup | undefined;
  try {
    setup = await getGuildSetup(pending.guildId);
    await requireCurrentAdministrator(interaction.guild, interaction.user.id, setup, `/${pending.command} confirmation`);
    if (pending.command !== "security_unlock" && await maintenanceActive(pending.guildId)) {
      throw new Error("Bot maintenance mode is active. Commands are temporarily unavailable.");
    }
  } catch (error) {
    if (id && confirmations.get(id) === pending) pending.claimed = false;
    throw error;
  }
  if (cancellation) {
    confirmations.delete(id!);
    await interaction.update({
      ...responseWithEmbed("Action cancelled.", "Action Cancelled", "info"),
      components: [],
    });
    return;
  }
  confirmations.delete(id!);
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
  // `/setup` is the first-time-friendly alias for the same private settings
  // wizard.  It remains registered after setup so administrators never need a
  // separate, divergent configuration path.  The option compatibility below
  // is retained only for old in-flight command payloads from previous builds.
  if (!selectedRole && !selectedAuditChannel) {
    await handleSettings(interaction);
    return;
  }
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
    ...previous,
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
  boundTarget?: ModerationTarget,
): Promise<void> {
  const username = moderationRobloxUsername(interaction);
  const type = interaction.options.getString("type", true) as BlacklistType;
  const reason = interaction.options.getString("reason", true).trim();
  const robloxUser = boundTarget
    ? { id: boundTarget.robloxUserId, name: boundTarget.robloxUsername }
    : await findRobloxUser(username);
  let member: GuildMember | undefined;
  if (boundTarget) {
    try {
      const fetched = await interaction.guild!.members.fetch(boundTarget.discordUserId);
      member = memberResults(fetched).find((candidate) => candidate.id === boundTarget.discordUserId);
    } catch {
      member = undefined;
    }
  } else {
    member = await resolveMember(interaction, robloxUser.name);
  }
  const targetDiscordUserId = boundTarget?.discordUserId ?? member?.id;
  if (!targetDiscordUserId) throw new Error("A validated Discord account is required.");
  if (setup) {
    await protectTargetIdentity(interaction.guild!, targetDiscordUserId, member, setup);
    await validateBlacklistRoleForAction(interaction.guild!, setup);
  }
  const existing = await findPendingOrActiveSnapshot(
    interaction.guild!.id,
    robloxUser.id,
  );

  if (existing) {
    throw new Error(`${robloxUser.name} already has an active blacklist snapshot.`);
  }

  const plannedRoleIds = member ? getRemovableRoleIds(member).changed : [];
  // A Discord account may carry several independent Roblox restrictions. Each
  // snapshot retains the union so restoring one restriction cannot discard
  // roles that belong to the eventual last revocation.
  const priorRoleSnapshots = await listSnapshotsForMember(
    interaction.guild!.id,
    targetDiscordUserId,
  );
  const savedRoleIds = [...new Set([
    ...(member ? plannedRoleIds : []),
    ...priorRoleSnapshots
      .filter((snapshot) => ["pending", "active", "revocation_pending"].includes(snapshot.status))
      .flatMap((snapshot) => snapshot.roleIds),
  ])];
  const roleSummary = member ? describeRoles(member, plannedRoleIds) : "None; member absent";
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
  const createdAt = new Date().toISOString();
  const approvedNonmemberSnapshot = !member
    ? {
        key,
        guildId: interaction.guild!.id,
        discordUserId: targetDiscordUserId,
        robloxUserId: robloxUser.id,
        robloxUsername: robloxUser.name,
        // A nonmember has no role state to invent. Join enforcement will
        // enforce this exact Discord-ID binding when the account joins.
         roleIds: savedRoleIds,
        blacklistType: type,
        blacklistReason: reason,
        source: "command" as const,
        status: "pending" as const,
        createdAt,
      }
    : undefined;

  try {
    // Approval is durable before a provider mutation for an absent account.
    if (approvedNonmemberSnapshot) await saveRoleSnapshot(approvedNonmemberSnapshot);
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
      discordUserId: targetDiscordUserId,
      robloxUserId: robloxUser.id,
      robloxUsername: robloxUser.name,
       roleIds: savedRoleIds,
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
        target: `<@${targetDiscordUserId}> (${targetDiscordUserId})`,
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

    const roleIds = member
      ? await withMemberRoleLock(interaction.guild!.id, member.id, async () => {
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
        })
      : [];
    const associations = await recordIdentityAssociation(interaction.guild!.id, targetDiscordUserId, robloxUser.id);
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
        target: `<@${targetDiscordUserId}> (${targetDiscordUserId})`,
        fields: [{ name: "Result", value: warnings.map((warning) =>
          warning === "same_discord_different_roblox"
            ? "Same Discord account is associated with another Roblox identity."
            : "Same Roblox identity is associated with another Discord account.",
        ).join("\n") }],
      });
    }
    if (setup) {
      await auditBestEffort(interaction.guild!, setup, {
        action: member
          ? "Discord roles removed"
          : "Discord role enforcement deferred for nonmember",
        status: "success",
        actorId: interaction.user.id,
        target: `<@${targetDiscordUserId}> (${targetDiscordUserId})`,
        fields: [
          {
            name: "Roblox user",
            value: `${robloxUser.name} | ${robloxUser.id}`,
          },
          { name: "Roles removed", value: member ? describeRoles(member, roleIds) : "None; member absent" },
        ],
      });
    }
    await saveRoleSnapshot({
      key,
      guildId: interaction.guild!.id,
      discordUserId: targetDiscordUserId,
      robloxUserId: robloxUser.id,
      robloxUsername: robloxUser.name,
      // Retain the original snapshot, even when a later enforcement attempt
      // could only remove part of the member's current roles.
       roleIds: savedRoleIds,
      cardId: createdCard.id,
      cardUrl: createdCard.url,
      blacklistType: type,
      blacklistReason: reason,
      source: "command",
      ...(member
        ? { blacklistNotificationAttemptedAt: new Date().toISOString() }
        : {}),
      status: "active",
      createdAt,
    });

    if (member) try {
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
          target: `<@${targetDiscordUserId}> (${targetDiscordUserId})`,
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
        target: `<@${targetDiscordUserId}> (${targetDiscordUserId})`,
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
       embeds: [outcomeEmbed("Blacklist Completed", member
         ? "The Roblox user was recorded and Discord role enforcement completed."
         : "The Roblox user and exact Discord account binding were recorded; role enforcement will run if the account joins this server.", "success", [
        { name: "Roblox User", value: `${safePresentationText(robloxUser.name)} (${displayId(robloxUser.id)})`, inline: true },
        { name: "Discord State", value: member ? `${roleIds.length} roles removed` : "Nonmember binding saved; enforcement will run on join", inline: true },
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
        target: `<@${targetDiscordUserId}> (${targetDiscordUserId})`,
        fields: [
          { name: "Roblox user", value: `${robloxUser.name} | ${robloxUser.id}` },
          {
            name: "Result",
            value: createdCard
              ? reusedRevokedCard
                ? "The existing Trello card was updated; synchronization will retry role enforcement."
                : "The Trello card exists and synchronization will retry role enforcement."
              : approvedNonmemberSnapshot
                ? "The exact nonmember Discord binding remains durably approved and pending provider recovery; no roles were changed."
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
  boundTarget?: ModerationTarget,
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
  boundTarget?: ModerationTarget,
): Promise<void> {
  const username = interaction.options.getString("username", true);
  const robloxUser = boundTarget
    ? { id: boundTarget.robloxUserId, name: boundTarget.robloxUsername }
    : await findRobloxUser(username);
  const guild = interaction.guild!;
  const snapshot = await findPendingOrActiveSnapshot(guild.id, robloxUser.id);
  if (
    boundTarget &&
    snapshot &&
    (snapshot.discordUserId !== boundTarget.discordUserId ||
      snapshot.robloxUserId !== boundTarget.robloxUserId)
  ) {
    throw new Error("The saved Discord/Roblox binding changed after confirmation; start /revoke_blacklist again.");
  }
  // A role snapshot is an immutable account binding. A departed member does
  // not invalidate a revocation approval: role restoration completes on join.
  let member: GuildMember | undefined;
  if (snapshot) {
    try {
      const fetched = await guild.members.fetch(snapshot.discordUserId);
      member = memberResults(fetched).find((candidate) => candidate.id === snapshot.discordUserId);
    } catch {
      member = undefined;
    }
  }
  if (member) await validateBlacklistRoleForAction(interaction.guild!, setup);
  const mappings = trelloMappingsFor(setup);
  let pending = snapshot;
  if (pending?.status !== "revocation_pending") {
    const cards = await findBlacklistCardsByRobloxId(robloxUser.id, mappings);
    const card = boundTarget?.cardId
      ? cards.find((candidate) => candidate.id === boundTarget.cardId)
      : cards[0];
    if (!card || card.listType === "revoked") {
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
  boundTarget?: ModerationTarget,
): Promise<void> {
  return withGuildBlacklistLifecycleLock(interaction.guild!.id, async () => {
    if (await maintenanceActive(interaction.guild!.id)) {
      throw new Error("Bot maintenance mode is active. Commands are temporarily unavailable.");
    }
    return handleRevokeUnlocked(interaction, setup, boundTarget);
  });
}

function payoutPreviewFields(snapshot: Awaited<ReturnType<typeof readPayoutSnapshot>>) {
  return [
    ...snapshot.roles.map((role) => ({
      name: role.role,
      value: `${role.total} Robux · ${role.participants.length} participant${role.participants.length === 1 ? "" : "s"}`,
      inline: true,
    })),
    { name: "Grand Total", value: `${snapshot.grandTotal} Robux`, inline: true },
    { name: "Source", value: "Payout Logging1 (read only)", inline: true },
    { name: "Uniform clear", value: `${snapshot.spreadsheet.logTab}!${snapshot.grids.log.range.a1}; F${snapshot.grids.log.range.startRow}:F${snapshot.grids.log.range.endRow}`, inline: false },
    { name: "Moderated clear", value: `${snapshot.spreadsheet.moderatedTab}!${snapshot.grids.moderated.range.a1}`, inline: false },
  ];
}

async function requirePayoutSafety(
  guild: Guild,
  actorId: string,
  setup: GuildSetup,
  command: string,
): Promise<void> {
  if (!setup.securityOwnerId) {
    throw new Error("Select a Security / Payout Owner in setup before using this command.");
  }
  await requireConfiguredSecurityOwner(guild, actorId, setup, command);
  await requireCurrentAdministrator(guild, actorId, setup, command);
  const denial = await mutateSecurityState(guild.id, (state) => {
    if (state.lockdown.active) {
      return `Security lockdown is active: ${state.lockdown.reason || "no reason provided"}.`;
    }
    if (
      securitySettingsFor(setup).recentPermissionEscalationProtection &&
      administratorInEscalationWindow(state, actorId)
    ) {
      return "This administrator permission was granted recently or has not previously been observed. Payout is delayed for 10 minutes.";
    }
    if (state.maintenance.active) {
      return "Bot maintenance mode is active. Payout is temporarily unavailable.";
    }
    return undefined;
  });
  if (denial) throw new Error(denial);
}

function payoutRecoveryDetails(run: PayoutRun): {
  text: string;
  label: string;
  mode: NonNullable<PayoutConfirmation["mode"]>;
  style: ButtonStyle;
} {
  if (run.state === "complete") {
    return {
      text: "This archived payout is already complete but retained a legacy workbook lock. Finalizing removes only that matching lock; it sends no report and changes no spreadsheet cells.",
      label: "Finalize Completed Lock",
      mode: "resume",
      style: ButtonStyle.Danger,
    };
  }
  if (run.state === "unsafe" || run.state === "cleared" || run.state === "clearing") {
    return {
      text: run.state === "cleared"
        ? "The archived reset completed, but local completion bookkeeping did not finish. This recovery only verifies the exact archived ranges are blank and Sold is false, then finalizes records. It never sends another DM or repeats deletion."
        : run.state === "clearing"
          ? "The bot stopped while the Google Sheets reset was being attempted. This recovery only verifies the exact archived ranges are blank and Sold is false, then finalizes records. It never sends another DM or repeats deletion."
        : "The prior Google Sheets reset response was unknown. This recovery will only verify the exact archived ranges are already blank and Sold is false; it will never send another DM or repeat deletion. It refuses a newer/changed payout source.",
      label: "Verify and Finalize Reset",
      mode: "recover-clear",
      style: ButtonStyle.Danger,
    };
  }
  if (run.reportState === "uncertain") {
    return {
      text: "Discord could not confirm the private payout report. Do not continue unless you personally received the complete report (all pages). Choosing the confirmation below records that acknowledgement and then clears the archived uniform ranges; it will not send any DM again.",
      label: "I Received Full Report — Clear",
      mode: "acknowledge",
      style: ButtonStyle.Danger,
    };
  }
  return {
    text: run.reportState === "delivered"
      ? "The private report was already delivered. Resume only the archived reset; no report will be sent again."
      : "This archived payout has a pending private report. Resume sends only undelivered report pages, then clears the archived ranges.",
    label: "Resume Payout",
    mode: "resume",
    style: ButtonStyle.Danger,
  };
}

async function renderPayoutRecovery(
  interaction: ChatInputCommandInteraction,
  run: PayoutRun,
): Promise<void> {
  const details = payoutRecoveryDetails(run);
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const pending: PayoutConfirmation = {
    userId: interaction.user.id, guildId: interaction.guild!.id, runId: run.runId,
    expiresAt: Date.now() + 10 * 60_000, original: interaction, mode: details.mode,
  };
  payoutConfirmations.set(nonce, pending);
  const reply = await interaction.editReply({
    content: "",
    embeds: [outcomeEmbed(
      "Payout Recovery Required",
      `${details.text}\n\nRun: ${run.runId}\nState: ${run.state}; report: ${run.reportState}.`,
      "warning",
    )],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`payout:${details.mode}:${nonce}`).setLabel(details.label).setStyle(details.style),
      new ButtonBuilder().setCustomId(`payout:cancel:${nonce}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    )],
    allowedMentions: noMentions,
  });
  pending.messageId = reply.id;
}

async function handlePayoutCommand(interaction: ChatInputCommandInteraction, setup: GuildSetup): Promise<void> {
  await requirePayoutSafety(interaction.guild!, interaction.user.id, setup, "/payout");
  // Discover by guild before consulting current settings. An administrator may
  // have edited the configured workbook after a run started; that must not
  // turn the archived lock into a permanently unreachable recovery.
  const guildActive = await activePayoutRunForGuild(interaction.guild!.id);
  if (guildActive) {
    await renderPayoutRecovery(interaction, guildActive);
    return;
  }
  const spreadsheet = uniformSettingsFor(setup).spreadsheet;
  if (!spreadsheet) throw new Error("Google Sheets uniform logging is not configured.");
  const normalized = normalizeUniformSpreadsheetConfig(spreadsheet);
  const locked = await payoutLockForWorkbook(normalized.spreadsheetId);
  if (locked) {
    const active = await getPayoutRun(locked.runId);
    if (!active || active.spreadsheetId !== normalized.spreadsheetId || active.state === "complete") {
      throw new Error("The payout lock archive is inconsistent; do not start a new payout until it is reviewed.");
    }
    await renderPayoutRecovery(interaction, active);
    return;
  }
  const snapshot = await readPayoutSnapshot(googlePayoutSheetsClient, spreadsheet);
  const run = await archivePayoutPreview(snapshot, interaction.guild!.id, interaction.user.id);
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const pending: PayoutConfirmation = { userId: interaction.user.id, guildId: interaction.guild!.id, runId: run.runId,
    expiresAt: Date.now() + 10 * 60_000, original: interaction };
  payoutConfirmations.set(nonce, pending);
  const reply = await interaction.editReply({
    content: "",
    embeds: [outcomeEmbed("Payout Preview",
      "No spreadsheet cells have changed. Confirmation privately reports this payout, then clears the listed uniform data. This does not transfer Robux.",
      "warning", payoutPreviewFields(snapshot))],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`payout:confirm:${nonce}`).setLabel("Confirm Payout").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`payout:cancel:${nonce}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    )],
    allowedMentions: noMentions,
  });
  pending.messageId = reply.id;
}

async function handlePayoutConfirmation(interaction: ButtonInteraction): Promise<void> {
  const match = /^payout:(confirm|cancel|resume|acknowledge|recover-clear):([a-f0-9]{32})$/.exec(interaction.customId);
  const pending = match && payoutConfirmations.get(match[2]);
  if (!match || !pending || pending.expiresAt <= Date.now() || pending.userId !== interaction.user.id ||
      pending.guildId !== interaction.guildId || !interaction.guild ||
      (match[1] !== "cancel" && match[1] !== (pending.mode ?? "confirm")) ||
      (pending.messageId !== undefined && interaction.message.id !== pending.messageId)) {
    throw new Error("This payout confirmation has expired or belongs to another administrator.");
  }
  if (pending.claimed) throw new Error("This payout confirmation is already being processed.");
  pending.claimed = true;
  try {
    const setup = await getGuildSetup(pending.guildId);
    if (!setup) throw new Error("Complete setup before confirming a payout.");
    await requirePayoutSafety(interaction.guild, interaction.user.id, setup, "/payout confirmation");
    if (match[1] === "cancel") {
      payoutConfirmations.delete(match[2]);
      await interaction.update({ ...responseWithEmbed("Payout preview cancelled. No spreadsheet cells changed.", "Payout Cancelled", "info"), components: [] });
      return;
    }
    const current = await getPayoutRun(pending.runId);
    const configured = uniformSettingsFor(setup).spreadsheet;
    const recovery = match[1] === "resume" || match[1] === "acknowledge" || match[1] === "recover-clear";
    if (!current || current.guildId !== pending.guildId ||
        (!recovery && (current.actorId !== interaction.user.id || !configured ||
          normalizeUniformSpreadsheetConfig(configured).spreadsheetId !== current.spreadsheetId))) {
      throw new Error("The archived payout or configured workbook changed. Run /payout again.");
    }
    if (!recovery) {
      if (!configured) throw new Error("Google Sheets uniform logging is not configured.");
      const latest = await readPayoutSnapshot(googlePayoutSheetsClient, configured);
      if (latest.sourceFingerprint !== current.sourceFingerprint ||
          latest.clearCells.some((cell, index) => cell.range !== current.clearCells[index]?.range)) {
        payoutConfirmations.delete(match[2]);
        throw new Error("Payout source or reset configuration changed after preview. Run /payout again; no cells changed.");
      }
    }
    payoutConfirmations.delete(match[2]);
    await interaction.deferUpdate();
    if (match[1] === "acknowledge") {
      await acknowledgeUncertainPayoutReport(pending.runId, interaction.user.id);
    }
    const completed = match[1] === "recover-clear"
      ? await recoverUnknownPayoutClear(googlePayoutSheetsClient, pending.runId)
      : await confirmArchivedPayout(googlePayoutSheetsClient, pending.runId, {
        sendPage: async (_run, page) => {
          const embeds = page.map((embed) => ({
          title: embed.title, description: embed.description, fields: embed.fields, footer: { text: embed.footer },
        }));
        const message = await interaction.user.send({ embeds, allowedMentions: noMentions });
        return message.id;
      },
      });
    await pending.original.editReply({
      ...responseWithEmbed(`Payout run ${completed.runId} is complete. Your private payout summary was delivered before the reset.`,
        "Payout Complete", "success"),
      components: [],
    });
  } catch (error) {
    pending.claimed = false;
    throw error;
  }
}

async function withUniformInteractionActivity<T>(
  guildId: string | null,
  work: () => Promise<T>,
): Promise<T> {
  if (!guildId) return work();
  const setup = await getGuildSetup(guildId);
  const spreadsheet = setup && uniformSettingsFor(setup).spreadsheet;
  // Let the established uniform handler return its normal setup error if
  // there is no configured workbook; there is no workbook to serialize then.
  if (!spreadsheet) return work();
  return withPayoutAwareUniformActivity(spreadsheet, work);
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

  if (interaction.commandName === "payout") {
    try {
      await handlePayoutCommand(interaction, setup);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not prepare a payout preview.";
      await interaction.editReply(errorResponse(message, "Payout Unavailable"));
    }
    return;
  }

  // Uniform logging is intentionally independent of blacklist validation,
  // Trello readiness, destructive-action limits, and security lockdown.
  // Maintenance remains the existing global emergency block above.
  if (uniformCommandNames.has(interaction.commandName)) {
    try {
      const spreadsheet = uniformSettingsFor(setup).spreadsheet;
      if (spreadsheet) {
        await withPayoutAwareUniformActivity(spreadsheet, () => handleUniformCommand(interaction, setup, botAvatarUrl()));
      } else {
        await handleUniformCommand(interaction, setup, botAvatarUrl());
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The uniform log failed unexpectedly.";
      await interaction.editReply(errorResponse(
        error instanceof UniformNotificationError
          ? message
          : `Could not complete the uniform log: ${message}`,
        error instanceof UniformNotificationError ? "Saved, Notification Failed" : "Uniform Log Failed",
      ));
    }
    return;
  }
  if (interaction.commandName === uniformRelogCommandName) {
    try {
      await withUniformInteractionActivity(interaction.guildId, () => handleUniformRelogCommand(interaction));
    } catch (error) {
      const message = error instanceof Error ? error.message : "The relog failed unexpectedly.";
      await interaction.editReply(
        error instanceof UniformDeliveryRecoveryError
          ? uniformDeliveryRecoveryResponse(error)
          : errorResponse(`Could not replace the uniform link: ${message}`, "Uniform Relog Failed"),
      );
    }
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
        let boundTarget: ModerationTarget | undefined;
        if (command === "blacklist" || command === "revoke_blacklist") {
          try {
            boundTarget = await resolveModerationTarget(interaction, command);
          } catch (error) {
            if (!(error instanceof DiscordIdentityRequiredError)) throw error;
            // Even when ordinary confirmations are disabled, an unresolved
            // Discord account must use the same private identity continuation.
            await createConfirmation(interaction, command);
            return;
          }
        }
      await reserveDestructiveAction(interaction.guild, interaction.user.id, setup, command);
      await requireTrelloReadiness(trelloMappingsFor(setup));
        if (command === "blacklist") await handleBlacklist(interaction, setup, boundTarget);
      else if (command === "group_blacklist") await handleGroupBlacklist(interaction, setup);
        else await handleRevoke(interaction, setup, boundTarget);
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

function setDiscordOperationalPresence(maintenance: boolean): void {
  const user = discordClient?.user;
  if (!user) return;
  user.setPresence({
    status: maintenance ? "idle" : "online",
    activities: [],
  });
}

export async function getPublicBotStatus(): Promise<{
  status: PublicBotStatus;
  checkedAt: string;
}> {
  if (!discordClient?.isReady() || !config.discordGuildId) {
    return { status: "offline", checkedAt: new Date().toISOString() };
  }

  const maintenance = await maintenanceActive(config.discordGuildId);
  return {
    status: mapDiscordPresenceToPublicStatus(
      discordClient.user.presence.status,
      maintenance,
      true,
    ),
    checkedAt: new Date().toISOString(),
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
  persistRecoveryState();
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

  const commandData = setupValid ? allEnabledCommands : setupOnlyCommands;
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
  // If enumeration is unavailable, interaction-time checks still fail closed.
  if (typeof guild.members.list !== "function") return;
  const members = await fetchGuildMembers(guild);
  await mutateSecurityState(guild.id, (state) => {
    for (const member of members.values()) {
      if (member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator)) {
        administratorInEscalationWindow(state, member.id);
      } else {
        delete state.observedAdministrators[member.id];
      }
    }
  });
}

async function replyInteractionError(
  interaction: ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction |
    RoleSelectMenuInteraction | ChannelSelectMenuInteraction | ModalSubmitInteraction,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : "The interaction failed unexpectedly.";
  let payload: ReturnType<typeof errorResponse> | ReturnType<typeof uniformDeliveryRecoveryResponse>;
  if (error instanceof UniformDeliveryRecoveryError) {
    payload = uniformDeliveryRecoveryResponse(error);
  } else {
    // A recovery modal is authorized by the surrounding settings session
    // before its handler runs. If that authorization fails, expose only the
    // submitted ID and never manufacture a retry control for the caller.
    let recoverySubmissionId: string | undefined;
    if (interaction.customId.startsWith("setup-modal:uniforms-recover") && "fields" in interaction) {
      try {
        const candidate = interaction.fields.getTextInputValue("submission_id").trim();
        if (/^\d{17,25}$/.test(candidate)) recoverySubmissionId = candidate;
      } catch {
        recoverySubmissionId = undefined;
      }
    }
    payload = recoverySubmissionId
      ? uniformDeliveryRecoveryResponse(new UniformDeliveryRecoveryError(
        recoverySubmissionId,
        message,
        "none",
      ))
      : errorResponse(message, "Interaction Error");
  }
  if (interaction.deferred || interaction.replied) {
    if (error instanceof UniformDeliveryRecoveryError && typeof interaction.editReply === "function") {
      await interaction.editReply(payload).catch(() => undefined);
    } else {
      await interaction.followUp({ ...payload, ephemeral: true }).catch(() => undefined);
    }
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
          if (leadershipLost) {
            throw new Error("PostgreSQL leadership was lost before Discord became ready.");
          }
          const moderationEnabled = await registerCommands(readyClient);
            setDiscordOperationalPresence(
              config.discordGuildId
                ? await maintenanceActive(config.discordGuildId)
                : false,
            );
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
        if (interaction.customId.startsWith("identity-prompt:")) {
          await handleIdentityPromptButton(interaction);
          return;
        }
        if (interaction.customId.startsWith("payout:")) {
          await handlePayoutConfirmation(interaction);
          return;
        }
        if (interaction.customId.startsWith("uniform:") && interaction.guildId && await maintenanceActive(interaction.guildId)) {
          await interaction.reply({
            ...responseWithEmbed(maintenanceMessage, "Maintenance Active", "warning"),
            ephemeral: true,
          });
          return;
        }
        if (interaction.customId.startsWith("uniform:submit:")) {
          await withUniformInteractionActivity(interaction.guildId, () => handleUniformSubmitButton(interaction, maintenanceActive));
          return;
        }
        if (interaction.customId.startsWith("uniform:retry:")) {
          await withUniformInteractionActivity(interaction.guildId, () => handleUniformRetryButton(interaction, maintenanceActive));
          return;
        }
        if (interaction.customId.startsWith("uniform:cancel:")) {
          await withUniformInteractionActivity(interaction.guildId, () => handleUniformCancelButton(interaction));
          return;
        }
        if (interaction.customId.startsWith("uniform:purchase:") || interaction.customId.startsWith("uniform:assist:")) {
          await withUniformInteractionActivity(interaction.guildId, () => handleUniformCustomerButton(interaction));
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
        // The confirmation handler rechecks maintenance after claiming and
        // immediately acknowledges an otherwise valid confirmation. Keeping
        // this before the broad maintenance gate prevents storage contention
        // from delaying the claimed interaction acknowledgement.
        if (interaction.customId.startsWith("confirm:") || interaction.customId.startsWith("cancel:")) {
          await handleConfirmation(interaction);
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
    } else if (
      (typeof interaction.isRoleSelectMenu === "function" && interaction.isRoleSelectMenu()) ||
      (typeof interaction.isChannelSelectMenu === "function" && interaction.isChannelSelectMenu())
    ) {
      void (async () => {
        if (interaction.customId.startsWith("settings:")) {
          await handleSettingsComponent(interaction as RoleSelectMenuInteraction | ChannelSelectMenuInteraction);
          return;
        }
        if (interaction.guildId && await maintenanceActive(interaction.guildId)) {
          await interaction.reply({ ...responseWithEmbed(maintenanceMessage, "Maintenance Active", "warning"), ephemeral: true });
          return;
        }
        await handleSetupComponent(interaction as RoleSelectMenuInteraction | ChannelSelectMenuInteraction);
      })().catch((error) => replyInteractionError(interaction, error));
    } else if (typeof interaction.isUserSelectMenu === "function" && interaction.isUserSelectMenu()) {
      void (async () => {
        if (interaction.customId.startsWith("settings:")) {
          await handleSettingsComponent(interaction);
          return;
        }
        if (interaction.customId.startsWith("setup:")) {
          if (interaction.guildId && await maintenanceActive(interaction.guildId)) {
            await interaction.reply({ ...responseWithEmbed(maintenanceMessage, "Maintenance Active", "warning"), ephemeral: true });
            return;
          }
          await handleSetupComponent(interaction);
          return;
        }
        if (interaction.guildId && await maintenanceActive(interaction.guildId)) {
          await interaction.reply({ ...responseWithEmbed(maintenanceMessage, "Maintenance Active", "warning"), ephemeral: true });
          return;
        }
        await withUniformInteractionActivity(interaction.guildId, () => handleUniformUserSelection(interaction));
      })().catch((error) => replyInteractionError(interaction, error));
    } else if (interaction.isStringSelectMenu()) {
      void (async () => {
        if (interaction.customId.startsWith("uniform:relog-select:")) {
          if (interaction.guildId && await maintenanceActive(interaction.guildId)) {
            await interaction.reply({
              ...responseWithEmbed(maintenanceMessage, "Maintenance Active", "warning"),
              ephemeral: true,
            });
            return;
          }
          await withUniformInteractionActivity(interaction.guildId, () => handleUniformRelogSelection(interaction));
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
        await handleSetupComponent(interaction);
      })().catch((error) => replyInteractionError(interaction, error));
    } else if (interaction.isModalSubmit()) {
      void (async () => {
        if (interaction.customId.startsWith("identity-modal:")) {
          await handleIdentityPromptModal(interaction);
          return;
        }
        if (interaction.customId.startsWith("settings-modal:")) {
          await handleSettingsModal(interaction);
          return;
        }
        if (interaction.customId.startsWith("uniform:assist-modal:")) {
          if (interaction.guildId && await maintenanceActive(interaction.guildId)) {
            await interaction.reply({ ...responseWithEmbed(maintenanceMessage, "Maintenance Active", "warning"), ephemeral: true });
            return;
          }
          await withUniformInteractionActivity(interaction.guildId, () => handleUniformAssistanceModal(interaction));
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
      }).catch((error) => logger.error({ error }, "Failed to record administrator grant"));
    } else if (hadAdministrator && !hasAdministrator) {
      void mutateSecurityState(after.guild.id, (state) => {
        delete state.observedAdministrators[after.id];
      }).catch((error) => logger.error({ error }, "Failed to record administrator removal"));
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
    if (leadershipLost) {
      throw new Error("PostgreSQL leadership was lost during Discord connection.");
    }
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
  if (leadershipLost) {
    setRecoveryStatus("blocked", "PostgreSQL leadership was lost; bot restart is required.");
    return refreshResult();
  }
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
        if (leadershipLost) {
          setRecoveryStatus("blocked", "PostgreSQL leadership was lost; bot restart is required.");
          return refreshResult();
        }
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

      if (leadershipLost) {
        setRecoveryStatus("blocked", "PostgreSQL leadership was lost; bot restart is required.");
        return refreshResult();
      }
      await connectDiscord();
      return refreshResult();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The bot could not be started.";
      if (trigger === "automatic") {
        recovery.lastRetryOutcome = "blocked";
      }
      // Persist the final automatic state as one ordered snapshot; assigning
      // the outcome after setRecoveryStatus used to lose it on restart.
      setRecoveryStatus("blocked", message);
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
  if (!config.botRuntimeEnabled) {
    logger.warn(
      "Bot runtime is disabled. Set BOT_RUNTIME_ENABLED=true only in the single environment that should connect to Discord.",
    );
    return;
  }
  if (isFileBotStorage()) {
    throw new Error("BOT_STORAGE_MODE=file is test-only and cannot run a Discord bot.");
  }
  if (!shutdownHooksInstalled) {
    shutdownHooksInstalled = true;
    const shutdown = () => {
      clearTrelloRetry();
      clearBlacklistSyncTimer();
      discordClient?.destroy();
      discordClient = null;
      const lease = runtimeLease;
      runtimeLease = null;
      void lease?.release().catch((error) => {
        logger.error({ err: error }, "Could not release bot runtime leadership lock");
      });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }
  if (!runtimeLease) {
    leadershipLost = false;
    leadershipGeneration += 1;
    runtimeLease = await acquireBotRuntimeLease((error) => {
      leadershipLost = true;
      leadershipGeneration += 1;
      runtimeLease = null;
      clearTrelloRetry();
      clearBlacklistSyncTimer();
      commandsRegistered = false;
      setupCommandRegistered = false;
      guildSetupComplete = false;
      discordClient?.destroy();
      discordClient = null;
      logger.error({ err: error }, "Lost PostgreSQL bot leadership lock; Discord client stopped fail-closed");
      // Do not await cleanup or persistence: a process that lost its DB
      // session must not reconnect while a replacement leader may be active.
      botExit(1);
    });
  }
  let result: BotRefreshResult;
  try {
    const persistedRecovery = await readPersistedRecoveryState();
    Object.assign(recovery, persistedRecovery);
    result = await refreshBot();
    await recoveryPersistence;
    if (leadershipLost) {
      throw new Error("PostgreSQL leadership was lost during bot startup.");
    }
  } catch (error) {
    clearTrelloRetry();
    clearBlacklistSyncTimer();
    discordClient?.destroy();
    discordClient = null;
    const lease = runtimeLease;
    runtimeLease = null;
    await lease?.release().catch(() => undefined);
    throw error;
  }
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

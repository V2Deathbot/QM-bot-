import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
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
  revokeBlacklistCard,
  type TrelloReadiness,
} from "./trello";
import {
  findActiveSnapshot,
  findPendingOrActiveSnapshot,
  revokeRoleSnapshot,
  saveRoleSnapshot,
} from "./role-store";
import {
  describeRoles,
  getRemovableRoleIds,
  removeAssignableRoles,
  restoreAssignableRoles,
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
  saveGuildSetup,
  type GuildSetup,
} from "./setup-store";
import {
  enforceBlacklistForJoinedMember,
  getBlacklistSyncStatus,
  reportBlacklistSyncUnavailable,
  setNextBlacklistSyncAt,
  synchronizeBlacklists,
  type BlacklistSyncTrigger,
} from "./blacklist-sync";

const setupCommand = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Configure the moderation role and audit channel.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addRoleOption((option) =>
    option
      .setName("role")
      .setDescription("The minimum role allowed to use blacklist commands.")
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("audit_channel_id")
      .setDescription("The ID of the text channel that receives audit logs.")
      .setRequired(true),
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

function clearBlacklistSyncTimer(): void {
  if (blacklistSyncTimer) {
    clearTimeout(blacklistSyncTimer);
    blacklistSyncTimer = null;
  }
  setNextBlacklistSyncAt(null);
}

function scheduleBlacklistSync(guild: Guild): void {
  clearBlacklistSyncTimer();
  const nextSyncAt = new Date(
    Date.now() + config.trelloSyncIntervalMs,
  ).toISOString();
  setNextBlacklistSyncAt(nextSyncAt);
  blacklistSyncTimer = setTimeout(() => {
    blacklistSyncTimer = null;
    setNextBlacklistSyncAt(null);
    void runGuildBlacklistSync(guild, "poll").finally(() => {
      if (discordClient?.isReady() && guildSetupComplete) {
        scheduleBlacklistSync(guild);
      }
    });
  }, config.trelloSyncIntervalMs);
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

  const readiness =
    trigger === "poll" ? await checkTrelloReadiness() : getTrelloReadiness();
  if (!readiness.ready) {
    await reportBlacklistSyncUnavailable(guild, setup, trigger);
    return;
  }

  await synchronizeBlacklists(guild, setup, trigger);
  if (trigger !== "poll") scheduleBlacklistSync(guild);
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
  return interaction.guild!.members.fetch(interaction.user.id);
}

export async function canUseModerationCommands(
  interaction: ChatInputCommandInteraction,
  setup: GuildSetup,
): Promise<boolean> {
  const guild = interaction.guild!;
  const member = await interactionMember(interaction);
  if (guild.ownerId === member.id) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  const moderatorRole = await guild.roles.fetch(setup.moderatorRoleId);
  if (!moderatorRole) return false;
  return member.roles.highest.position >= moderatorRole.position;
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

  const selectedRole = interaction.options.getRole("role", true);
  const role = await guild.roles.fetch(selectedRole.id);
  if (!role) {
    throw new Error("The selected moderator role does not exist.");
  }
  validateModeratorRole(guild, role);

  const auditChannelId = interaction.options
    .getString("audit_channel_id", true)
    .trim();
  if (!/^\d{5,25}$/.test(auditChannelId)) {
    throw new Error("The audit channel ID must contain only numbers.");
  }

  const previous = await getGuildSetup(guild.id);
  const setup: GuildSetup = {
    guildId: guild.id,
    moderatorRoleId: role.id,
    auditChannelId,
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
        name: "Minimum moderator role",
        value: `${role.name} (${role.id})`,
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
    `Setup complete. Members with **${role.name}** or a higher role can now use moderation commands. Audits will be sent to <#${auditChannelId}>.`,
  );
  await runGuildBlacklistSync(guild, "setup");
}

export async function handleBlacklist(
  interaction: ChatInputCommandInteraction,
  setup?: GuildSetup,
): Promise<void> {
  const username = interaction.options.getString("user", true);
  const type = interaction.options.getString("type", true) as BlacklistType;
  const reason = interaction.options.getString("reason", true).trim();
  const robloxUser = await findRobloxUser(username);
  const member = await resolveMember(interaction, robloxUser.name);
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

    const roleIds = (await removeAssignableRoles(member)).changed;
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
      roleIds,
      cardId: createdCard.id,
      cardUrl: createdCard.url,
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

async function handleGroupBlacklist(
  interaction: ChatInputCommandInteraction,
  setup: GuildSetup,
): Promise<void> {
  const groupId = interaction.options.getString("id", true);
  const reason = interaction.options.getString("reason", true).trim();
  const groupUrl = getRobloxGroupUrl(groupId);
  const card = await createGroupBlacklistCard({ groupUrl, reason });

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

async function handleRevoke(
  interaction: ChatInputCommandInteraction,
  setup: GuildSetup,
): Promise<void> {
  const username = interaction.options.getString("username", true);
  const robloxUser = await findRobloxUser(username);
  const member = await resolveMember(interaction, robloxUser.name);
  const snapshot = await findActiveSnapshot(interaction.guild!.id, robloxUser.id);
  const card = await findBlacklistCardByRobloxId(robloxUser.id);

  if (!card || card.listType === "revoked") {
    throw new Error(
      `No active Trello blacklist card was found for ${robloxUser.name} (${robloxUser.id}).`,
    );
  }

  const revokedCard = await revokeBlacklistCard(card);
  await auditBestEffort(interaction.guild!, setup, {
    action: "Trello blacklist card moved to revoked",
    status: "success",
    actorId: interaction.user.id,
    target: `<@${member.id}> (${member.id})`,
    fields: [
      { name: "Roblox user", value: `${robloxUser.name} | ${robloxUser.id}` },
      { name: "Trello card", value: `${card.id}\n${revokedCard.url}` },
    ],
  });
  if (snapshot) {
    await restoreAssignableRoles(member, snapshot.roleIds);
    await revokeRoleSnapshot(snapshot.key);
    await auditBestEffort(interaction.guild!, setup, {
      action: "Discord roles restored",
      status: "success",
      actorId: interaction.user.id,
      target: `<@${member.id}> (${member.id})`,
      fields: [
        {
          name: "Roles restored",
          value: describeRoles(member, snapshot.roleIds),
        },
      ],
    });
  }

  try {
    await member.send({
      content: `Your blacklist has been revoked. Trello record: ${revokedCard.url}`,
      embeds: [],
    });
  } catch {
    await auditBestEffort(interaction.guild!, setup, {
      action: "Revocation DM could not be delivered",
      status: "failed",
      actorId: interaction.user.id,
      target: `<@${member.id}> (${member.id})`,
      fields: [{ name: "Trello card", value: `${card.id}\n${revokedCard.url}` }],
    });
  }

  await auditBestEffort(interaction.guild!, setup, {
    action: "User blacklist revoked",
    status: "success",
    actorId: interaction.user.id,
    target: `<@${member.id}> (${member.id})`,
    fields: [
      { name: "Roblox user", value: `${robloxUser.name} | ${robloxUser.id}` },
      {
        name: "Roles restored",
        value: snapshot ? describeRoles(member, snapshot.roleIds) : "No saved roles",
      },
      { name: "Trello card", value: `${card.id}\n${revokedCard.url}` },
    ],
  });
  await interaction.editReply(
    `Revoked the blacklist for **${robloxUser.name}** and moved the Trello card to the revoked list.${snapshot ? ` Restored ${snapshot.roleIds.length} saved role(s).` : " No saved role snapshot was found, so no roles were restored."}`,
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

  if (!(await canUseModerationCommands(interaction, setup))) {
    await auditBestEffort(interaction.guild, setup, {
      action: "Unauthorized moderation command denied",
      status: "failed",
      actorId: interaction.user.id,
      fields: [{ name: "Command", value: `/${interaction.commandName}` }],
    });
    await interaction.editReply(
      "You need the configured moderator role or a higher role to use this command.",
    );
    return;
  }

  try {
    await sendAuditEvent(interaction.guild, setup, {
      action: "Moderation command started",
      status: "started",
      actorId: interaction.user.id,
      fields: [{ name: "Command", value: `/${interaction.commandName}` }],
    });
    await requireTrelloReadiness();

    if (interaction.commandName === "blacklist") {
      await handleBlacklist(interaction, setup);
    } else if (interaction.commandName === "group_blacklist") {
      await handleGroupBlacklist(interaction, setup);
    } else if (interaction.commandName === "revoke_blacklist") {
      await handleRevoke(interaction, setup);
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
            if (moderationEnabled) {
              setRecoveryStatus("successful");
              const guild = await readyClient.guilds.fetch(
                config.discordGuildId!,
              );
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
      const trello = await checkTrelloReadiness();
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

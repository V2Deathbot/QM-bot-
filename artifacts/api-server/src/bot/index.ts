import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { logger } from "../lib/logger";
import { config, getMissingConfiguration, type BlacklistType } from "./config";
import {
  checkTrelloReadiness,
  createBlacklistCard,
  createGroupBlacklistCard,
  findBlacklistCard,
  getTrelloReadiness,
  requireTrelloReadiness,
  revokeBlacklistCard,
} from "./trello";
import {
  findActiveSnapshot,
  revokeRoleSnapshot,
  saveRoleSnapshot,
} from "./role-store";
import { findRobloxUser, getRobloxGroupUrl } from "./roblox";

const commands = [
  new SlashCommandBuilder()
    .setName("blacklist")
    .setDescription("Blacklist a Roblox user and remove their server roles.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
].map((command) => command.toJSON());

function keyFor(guildId: string, robloxUserId: number): string {
  return `${guildId}:${robloxUserId}`;
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

async function removeRoles(member: GuildMember): Promise<string[]> {
  const roleIds = member.roles.cache
    .filter((role) => role.id !== member.guild.id && !role.managed)
    .map((role) => role.id);

  if (roleIds.length > 0) {
    await member.roles.remove(roleIds, "Roblox blacklist");
  }

  return roleIds;
}

async function restoreRoles(member: GuildMember, roleIds: string[]): Promise<void> {
  const botMember = member.guild.members.me;
  const restorable = roleIds.filter((roleId) => {
    const role = member.guild.roles.cache.get(roleId);
    return Boolean(role && !role.managed && botMember && role.position < botMember.roles.highest.position);
  });

  if (restorable.length > 0) {
    await member.roles.add(restorable, "Roblox blacklist revoked");
  }
}

export async function handleBlacklist(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const username = interaction.options.getString("user", true);
  const type = interaction.options.getString("type", true) as BlacklistType;
  const reason = interaction.options.getString("reason", true).trim();
  const robloxUser = await findRobloxUser(username);
  const member = await resolveMember(interaction, robloxUser.name);
  const existing = await findActiveSnapshot(interaction.guild!.id, robloxUser.id);

  if (existing) {
    throw new Error(`${robloxUser.name} already has an active blacklist snapshot.`);
  }

  const roleIds = await removeRoles(member);
  const key = keyFor(interaction.guild!.id, robloxUser.id);
  await saveRoleSnapshot({
    key,
    guildId: interaction.guild!.id,
    discordUserId: member.id,
    robloxUserId: robloxUser.id,
    robloxUsername: robloxUser.name,
    roleIds,
    status: "active",
    createdAt: new Date().toISOString(),
  });

  try {
    const card = await createBlacklistCard({
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
      roleIds,
      cardId: card.id,
      cardUrl: card.url,
      status: "active",
      createdAt: new Date().toISOString(),
    });
    await member.send({
      content: `You have been blacklisted from this server. Trello record: ${card.url}`,
      embeds: [],
    });
    await interaction.editReply(
      `Blacklisted **${robloxUser.name}** (${robloxUser.id}). Removed ${roleIds.length} role(s) and created the Trello card: ${card.url}`,
    );
  } catch (error) {
    await restoreRoles(member, roleIds);
    throw error;
  }
}

async function handleGroupBlacklist(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const groupId = interaction.options.getString("id", true);
  const reason = interaction.options.getString("reason", true).trim();
  const groupUrl = getRobloxGroupUrl(groupId);
  const card = await createGroupBlacklistCard({ groupUrl, reason });

  await interaction.editReply(
    `Blacklisted group ${groupUrl}. Created the Trello card: ${card.url}`,
  );
}

async function handleRevoke(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const username = interaction.options.getString("username", true);
  const robloxUser = await findRobloxUser(username);
  const member = await resolveMember(interaction, robloxUser.name);
  const snapshot = await findActiveSnapshot(interaction.guild!.id, robloxUser.id);
  const card = await findBlacklistCard(`${robloxUser.name} | ${robloxUser.id}`);

  if (!card) {
    throw new Error(
      `No Trello blacklist card was found for ${robloxUser.name} (${robloxUser.id}).`,
    );
  }

  const revokedCard = await revokeBlacklistCard(card);
  if (snapshot) {
    await restoreRoles(member, snapshot.roleIds);
    await revokeRoleSnapshot(snapshot.key);
  }

  await member.send({
    content: `Your blacklist has been revoked. Trello record: ${revokedCard.url}`,
    embeds: [],
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

  try {
    await requireTrelloReadiness();

    if (interaction.commandName === "blacklist") {
      await handleBlacklist(interaction);
    } else if (interaction.commandName === "group_blacklist") {
      await handleGroupBlacklist(interaction);
    } else if (interaction.commandName === "revoke_blacklist") {
      await handleRevoke(interaction);
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The command failed unexpectedly.";
    logger.error({ err: error, command: interaction.commandName }, "Blacklist command failed");
    await interaction.editReply(`Could not complete the command: ${message}`);
  }
}

export function getBotStatus() {
  const trello = getTrelloReadiness();
  return {
    configured: getMissingConfiguration().length === 0,
    missing: getMissingConfiguration(),
    commandsEnabled: trello.ready,
  };
}

export async function startBot(): Promise<void> {
  const missing = getMissingConfiguration();
  if (missing.length > 0) {
    logger.warn({ missing }, "Blacklist bot is waiting for configuration");
    return;
  }

  const trello = await checkTrelloReadiness();
  if (!trello.ready) {
    logger.warn(
      {
        readiness: trello.status,
        missingLists: trello.missingLists,
        error: trello.error,
      },
      "Blacklist bot is waiting for Trello board readiness",
    );
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  client.once("ready", async (readyClient) => {
    if (config.discordGuildId) {
      const guild = await readyClient.guilds.fetch(config.discordGuildId);
      await guild.commands.set(commands);
      logger.info(
        { guildId: config.discordGuildId, commandCount: commands.length },
        "Blacklist commands registered for guild",
      );
    } else {
      const rest = new REST({ version: "10" }).setToken(config.discordToken!);
      await rest.put(Routes.applicationCommands(readyClient.user.id), {
        body: commands,
      });
      logger.info({ commandCount: commands.length }, "Blacklist commands registered globally");
    }

    logger.info({ user: readyClient.user.tag }, "Discord blacklist bot is online");
  });

  client.on("interactionCreate", (interaction) => {
    if (interaction.isChatInputCommand()) {
      void handleInteraction(interaction);
    }
  });

  client.on("error", (error) => {
    logger.error({ err: error }, "Discord client error");
  });

  await client.login(config.discordToken);
}

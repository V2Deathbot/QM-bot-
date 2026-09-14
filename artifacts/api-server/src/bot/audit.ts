import {
  ChannelType,
  Colors,
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
  type Role,
} from "discord.js";
import { config } from "./config";
import { auditSettingsFor, type GuildSetup } from "./setup-store";

export type AuditStatus = "started" | "success" | "failed";

export interface AuditField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface AuditEvent {
  action: string;
  status: AuditStatus;
  actorId: string;
  target?: string;
  fields?: AuditField[];
}

const statusColors = {
  started: Colors.Yellow,
  success: Colors.Green,
  failed: Colors.Red,
} as const;

function clean(value: string): string {
  let sanitized = value.replaceAll("`", "'");
  for (const secret of [
    config.discordToken,
    config.trelloApiKey,
    config.trelloToken,
  ]) {
    if (secret) sanitized = sanitized.replaceAll(secret, "[redacted]");
  }
  return sanitized.slice(0, 1_000) || "None";
}

export async function requireAuditChannel(
  guild: Guild,
  setup: GuildSetup,
) {
  const channel = await guild.channels.fetch(setup.auditChannelId);
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) {
    throw new Error(
      "The configured audit channel is missing or is not a text channel. Run /settings again.",
    );
  }

  const botMember = guild.members.me;
  const permissions = botMember ? channel.permissionsFor(botMember) : null;
  if (
    !permissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ])
  ) {
    throw new Error(
      "The bot cannot view, send messages, and embed links in the configured audit channel.",
    );
  }

  return channel;
}

export function validateModeratorRole(guild: Guild, role: Role): void {
  if (role.guild.id !== guild.id) {
    throw new Error("The moderator role must belong to this server.");
  }
  if (role.managed && role.id !== guild.id) {
    throw new Error("A managed integration role cannot be the moderator role.");
  }

  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("The bot needs the Manage Roles permission before setup.");
  }
  if (
    role.id !== guild.id &&
    role.position >= botMember.roles.highest.position
  ) {
    throw new Error(
      "The moderator role must be below the bot's highest role in the server hierarchy.",
    );
  }
}

export async function validateGuildSetup(
  guild: Guild,
  setup: GuildSetup,
): Promise<void> {
  // moderatorRoleId is retained only to migrate old setup JSON. Authorization
  // is now the member's current Administrator permission, not role position.
  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error("The bot needs the Manage Roles permission before moderation.");
  }
  await requireAuditChannel(guild, setup);
}

export async function sendAuditEvent(
  guild: Guild,
  setup: GuildSetup,
  event: AuditEvent,
): Promise<void> {
  const normalizedAction = event.action.toLowerCase();
  const mandatory = /(security|maintenance|rate limit|protected|unauthorized|configuration|setup)/.test(normalizedAction);
  const settings = auditSettingsFor(setup);
  if (!mandatory) {
    if (normalizedAction.includes("trello") && !settings.trelloAlerts) return;
    if (/(role|enforcement|restoration)/.test(normalizedAction) && !settings.roleEnforcementLogs) return;
    if (/(join|joined)/.test(normalizedAction) && !settings.joinLeaveBlacklistLogs) return;
    if (normalizedAction.includes("blacklist") && !settings.blacklistLogs) return;
  }
  const selectedChannelId =
    (/(security|rate limit|protected|unauthorized)/.test(normalizedAction)
      ? setup.securityAlertChannelId
      : undefined) ??
    (normalizedAction.includes("trello") ? setup.trelloAlertChannelId : undefined) ??
    setup.auditChannelId;
  // Audit controls are destinations, not suppression controls: every event
  // always has the main audit channel as a safe fallback.
  let channel: Awaited<ReturnType<typeof requireAuditChannel>>;
  try {
    channel = await requireAuditChannel(guild, {
      ...setup,
      auditChannelId: selectedChannelId,
    });
  } catch (error) {
    if (selectedChannelId === setup.auditChannelId) throw error;
    channel = await requireAuditChannel(guild, setup);
  }
  const embed = new EmbedBuilder()
    .setTitle(clean(event.action))
    .setColor(statusColors[event.status])
    .setTimestamp()
    .addFields(
      {
        name: "Status",
        value: event.status.toUpperCase(),
        inline: true,
      },
      {
        name: "Moderator",
        value: `<@${event.actorId}> (${event.actorId})`,
        inline: true,
      },
    );

  if (event.target) {
    embed.addFields({ name: "Target", value: clean(event.target) });
  }
  for (const field of event.fields ?? []) {
    embed.addFields({
      name: clean(field.name).slice(0, 256),
      value: clean(field.value),
      inline: field.inline,
    });
  }

  await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
  type PermissionResolvable,
  type StringSelectMenuInteraction,
} from "discord.js";
import { findRobloxUser, type RobloxUser } from "./roblox";
import {
  defaultUniformSettings,
  saveGuildSetup,
  uniformSettingsFor,
  type GuildSetup,
  type UniformSettings,
} from "./setup-store";
import {
  displayId,
  noMentions,
  presentationEmbed,
  readableDate,
  safePresentationText,
} from "./presentation";

/**
 * Uniform logging deliberately has no provider side effects.  In particular,
 * Roblox asset inputs are parsed locally; accepting a URL never causes the bot
 * to fetch an arbitrary URL.
 */
const allowedRobloxHosts = new Set([
  "roblox.com",
  "www.roblox.com",
  "create.roblox.com",
]);

export const uniformCommands = [
  new SlashCommandBuilder()
    .setName("log")
    .setDescription("Log a completed uniform upload.")
    .addStringOption((option) =>
      option
        .setName("customer")
        .setDescription("Exact Roblox username for the customer.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("qm")
        .setDescription("Exact Roblox username for the Quartermaster.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("seqm")
        .setDescription("Exact Roblox username for the Senior Quartermaster.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("publisher")
        .setDescription("Exact Roblox username for the publisher.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("shirtid1")
        .setDescription("Roblox uniform asset ID or allowlisted Roblox URL.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("shirtid2").setDescription("Uniform asset ID or Roblox URL.").setRequired(false),
    )
    .addStringOption((option) =>
      option.setName("shirtid3").setDescription("Uniform asset ID or Roblox URL.").setRequired(false),
    )
    .addStringOption((option) =>
      option.setName("shirtid4").setDescription("Uniform asset ID or Roblox URL.").setRequired(false),
    )
    .addStringOption((option) =>
      option.setName("shirtid5").setDescription("Uniform asset ID or Roblox URL.").setRequired(false),
    )
    .addStringOption((option) =>
      option.setName("shirtid6").setDescription("Uniform asset ID or Roblox URL.").setRequired(false),
    )
    .addStringOption((option) =>
      option.setName("shirtid7").setDescription("Uniform asset ID or Roblox URL.").setRequired(false),
    )
    .addStringOption((option) =>
      option.setName("shirtid8").setDescription("Uniform asset ID or Roblox URL.").setRequired(false),
    )
    .addStringOption((option) =>
      option.setName("shirtid9").setDescription("Uniform asset ID or Roblox URL.").setRequired(false),
    )
    .addStringOption((option) =>
      option.setName("shirtid10").setDescription("Uniform asset ID or Roblox URL.").setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("moderated")
    .setDescription("Log a moderated uniform upload.")
    .addStringOption((option) =>
      option
        .setName("customer")
        .setDescription("Exact Roblox username for the customer.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("uploader")
        .setDescription("Exact Roblox username for the uploader.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("publisher")
        .setDescription("Exact Roblox username for the publisher.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("shirtid")
        .setDescription("Roblox uniform asset ID or allowlisted Roblox URL.")
        .setRequired(true),
    ),
] as const;

export const uniformCommandNames = new Set(["log", "moderated"]);

export type UniformCommandName = "log" | "moderated";

export interface UniformAsset {
  id: number;
  /** Canonical catalog URL, independent of the input form. */
  url: string;
}

export interface UniformSubmission {
  command: UniformCommandName;
  users: {
    customer: RobloxUser;
    qm?: RobloxUser;
    seqm?: RobloxUser;
    uploader?: RobloxUser;
    publisher: RobloxUser;
  };
  assets: UniformAsset[];
}

function positiveAssetId(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("Uniform asset IDs must contain digits only.");
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Uniform asset ID must be a positive safe integer.");
  }
  return id;
}

/**
 * Accept numeric IDs and Roblox catalog/library/store URLs only.  This
 * function intentionally performs no network request.
 */
export function parseUniformAssetInput(input: string): UniformAsset {
  const value = input.trim();
  if (!value || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Each uniform asset must be a positive Roblox asset ID or a valid Roblox uniform URL.");
  }

  let id: number;
  if (/^\d+$/.test(value)) {
    id = positiveAssetId(value);
  } else {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("Uniform assets must be positive numeric IDs or valid https://www.roblox.com uniform URLs.");
    }
    if (
      parsed.protocol !== "https:" ||
      !allowedRobloxHosts.has(parsed.hostname.toLowerCase()) ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error("Uniform URLs must use an allowlisted Roblox HTTPS host.");
    }

    const catalogMatch = /^\/(?:catalog|library)\/(\d+)(?:\/|$)/i.exec(parsed.pathname);
    const storeMatch = /^\/store\/asset\/(\d+)(?:\/|$)/i.exec(parsed.pathname);
    const assetPath = /^\/asset\/?$/i.test(parsed.pathname);
    const assetQuery = assetPath ? parsed.searchParams.get("id") : null;
    const candidate = catalogMatch?.[1] ?? storeMatch?.[1] ?? assetQuery;
    if (
      !candidate ||
      (!catalogMatch &&
        !storeMatch &&
        [...parsed.searchParams.keys()].some((key) => key.toLowerCase() !== "id"))
    ) {
      throw new Error("That URL is not a supported Roblox uniform asset URL.");
    }
    id = positiveAssetId(candidate);
  }

  return {
    id,
    url: `https://www.roblox.com/catalog/${id}`,
  };
}

function cleanUsername(value: string, label: string): string {
  const username = value.trim();
  if (!username || username.length > 50 || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new Error(`${label} must be a valid Roblox username.`);
  }
  return username;
}

function optionString(
  interaction: ChatInputCommandInteraction,
  name: string,
  required = false,
): string | undefined {
  const value = interaction.options.getString(name, required);
  if (value === null || value === undefined) {
    if (required) throw new Error(`Missing required field "${name}".`);
    return undefined;
  }
  return value;
}

function assetInputsFor(
  interaction: ChatInputCommandInteraction,
  command: UniformCommandName,
): string[] {
  const names = command === "log"
    ? Array.from({ length: 10 }, (_value, index) => `shirtid${index + 1}`)
    : ["shirtid"];
  const inputs: string[] = [];
  let gap = false;
  for (const [index, name] of names.entries()) {
    const value = optionString(interaction, name, index === 0);
    if (!value || !value.trim()) {
      if (index === 0) throw new Error("The first uniform asset is required.");
      gap = true;
      continue;
    }
    if (gap) {
      throw new Error("Uniform asset inputs must be provided in order without gaps.");
    }
    inputs.push(value);
  }
  if (inputs.length < 1) {
    throw new Error("At least one uniform asset is required.");
  }
  if (command === "moderated" && inputs.length !== 1) {
    throw new Error("The moderated uniform log accepts exactly one uniform asset.");
  }
  return inputs;
}

function userInputsFor(
  interaction: ChatInputCommandInteraction,
  command: UniformCommandName,
): Array<{ key: keyof UniformSubmission["users"]; label: string }> {
  return command === "log"
    ? [
        { key: "customer", label: "Customer" },
        { key: "qm", label: "Quartermaster" },
        { key: "seqm", label: "Senior Quartermaster" },
        { key: "publisher", label: "Publisher" },
      ]
    : [
        { key: "customer", label: "Customer" },
        { key: "uploader", label: "Uploader" },
        { key: "publisher", label: "Publisher" },
      ];
}

async function resolveSubmission(
  interaction: ChatInputCommandInteraction,
  command: UniformCommandName,
): Promise<UniformSubmission> {
  const inputs = userInputsFor(interaction, command);
  const unique = new Map<string, { input: string; labels: string[] }>();
  for (const { key, label } of inputs) {
    const input = cleanUsername(
      optionString(interaction, key, true) ?? "",
      label,
    );
    const dedupeKey = input.toLowerCase();
    const existing = unique.get(dedupeKey);
    if (existing) existing.labels.push(label);
    else unique.set(dedupeKey, { input, labels: [label] });
  }

  const resolved = new Map<string, RobloxUser>();
  for (const [dedupeKey, value] of unique) {
    try {
      // Keep one exact Roblox resolver call per username in this invocation.
      resolved.set(dedupeKey, await findRobloxUser(value.input));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Roblox lookup failed.";
      throw new Error(`Could not validate ${value.labels.join(" / ")} Roblox username "${value.input}": ${reason}`);
    }
  }

  const users = {} as UniformSubmission["users"];
  for (const { key, label } of inputs) {
    const input = cleanUsername(optionString(interaction, key, true) ?? "", label);
    users[key] = resolved.get(input.toLowerCase())!;
  }

  const assets = assetInputsFor(interaction, command).map((input) => {
    try {
      return parseUniformAssetInput(input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Invalid uniform asset.";
      throw new Error(`Could not validate uniform asset "${input}": ${reason}`);
    }
  });

  return { command, users, assets };
}

function memberHasRole(member: GuildMember, roleIds: string[]): boolean {
  const cache = member.roles?.cache as
    | { has?: (id: string) => boolean; some?: (predicate: (role: { id: string }) => boolean) => boolean }
    | undefined;
  if (cache?.some && cache.some((role) => roleIds.includes(role.id))) return true;
  return Boolean(cache?.has && roleIds.some((id) => cache.has!(id)));
}

async function currentMember(
  guild: Guild,
  userId: string,
): Promise<GuildMember> {
  let fetched: unknown;
  try {
    fetched = await guild.members.fetch({ user: userId, force: true });
  } catch {
    throw new Error("Your current Discord member permissions could not be verified.");
  }
  const member = fetched as GuildMember | null;
  if (!member || member.id !== userId) {
    throw new Error("Your current Discord member permissions could not be verified.");
  }
  return member;
}

export async function canSubmitUniforms(
  guild: Guild,
  userId: string,
  settings: UniformSettings,
): Promise<boolean> {
  const member = await currentMember(guild, userId);
  if (guild.ownerId === member.id || member.permissions.has(PermissionFlagsBits.Administrator)) {
    return true;
  }
  return settings.authorizedMemberIds.includes(member.id) ||
    memberHasRole(member, settings.authorizedRoleIds);
}

async function requireUniformSubmitter(
  guild: Guild,
  userId: string,
  settings: UniformSettings,
): Promise<void> {
  if (await canSubmitUniforms(guild, userId, settings)) return;
  throw new Error(
    "You are not authorized to submit uniform logs. An Administrator, configured uniform role, or configured member ID is required.",
  );
}

type UniformChannel = {
  type: ChannelType;
  permissionsFor: (member: GuildMember) => { has: (permissions: PermissionResolvable[]) => boolean } | null;
  send: (payload: unknown) => Promise<unknown>;
};

async function requireUniformChannel(
  guild: Guild,
  channelId: string | undefined,
  command: UniformCommandName,
): Promise<UniformChannel> {
  if (!channelId) {
    throw new Error(
      `The /${command} destination is not configured. Ask an Administrator to open /settings → Uniforms → Uploading Configuration.`,
    );
  }
  let channel: unknown;
  try {
    channel = await guild.channels.fetch(channelId);
  } catch {
    throw new Error(`The configured /${command} destination could not be fetched. Ask an Administrator to update Uniforms settings.`);
  }
  const candidate = channel as UniformChannel | null;
  if (
    !candidate ||
    (candidate.type !== ChannelType.GuildText && candidate.type !== ChannelType.GuildAnnouncement)
  ) {
    throw new Error(`The configured /${command} destination is missing or is not a text channel.`);
  }
  const botMember = guild.members.me;
  let permissions: ReturnType<UniformChannel["permissionsFor"]> = null;
  try {
    permissions = botMember ? candidate.permissionsFor(botMember) : null;
  } catch {
    permissions = null;
  }
  if (!permissions?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ])) {
    throw new Error(
      `The bot cannot view, send messages, and embed links in the configured /${command} destination.`,
    );
  }
  return candidate;
}

function profileLink(user: RobloxUser): string {
  return `[${safePresentationText(user.name, 100)}](https://www.roblox.com/users/${user.id}/profile)\nRoblox ID: ${displayId(user.id)}`;
}

export function uniformSubmissionEmbed(
  submission: UniformSubmission,
  actorId: string,
  avatarUrl?: string,
  at = new Date(),
): EmbedBuilder {
  const roleFields = submission.command === "log"
    ? [
        { name: "Customer", value: profileLink(submission.users.customer), inline: true },
        { name: "Quartermaster", value: profileLink(submission.users.qm!), inline: true },
        { name: "Senior Quartermaster", value: profileLink(submission.users.seqm!), inline: true },
        { name: "Publisher", value: profileLink(submission.users.publisher), inline: true },
      ]
    : [
        { name: "Customer", value: profileLink(submission.users.customer), inline: true },
        { name: "Uploader", value: profileLink(submission.users.uploader!), inline: true },
        { name: "Publisher", value: profileLink(submission.users.publisher), inline: true },
      ];
  const assetFields = submission.assets.map((asset, index) => ({
    name: `Uniform ${index + 1}`,
    value: `[Open Roblox uniform asset](${asset.url})\nAsset ID: ${displayId(asset.id)}`,
  }));
  const timestamp = at.toISOString();
  return presentationEmbed(
    submission.command === "log" ? "Uniform Upload Logged" : "Moderated Uniform Logged",
    submission.command === "log"
      ? "A uniform upload was logged."
      : "A moderated uniform upload was logged.",
    "success",
    avatarUrl,
    [
      ...roleFields,
      ...assetFields,
      { name: "Actor ID", value: displayId(actorId), inline: true },
      { name: "Timestamp", value: `${readableDate(timestamp)}\n${safePresentationText(timestamp)}`, inline: true },
    ],
  ).setTimestamp(at);
}

export async function handleUniformCommand(
  interaction: ChatInputCommandInteraction,
  setup: GuildSetup,
  avatarUrl?: string,
): Promise<void> {
  const command = interaction.commandName as UniformCommandName;
  if (!uniformCommandNames.has(command)) {
    throw new Error("That is not a uniform logging command.");
  }
  const settings = uniformSettingsFor(setup);
  await requireUniformSubmitter(interaction.guild!, interaction.user.id, settings);
  const channel = await requireUniformChannel(
    interaction.guild!,
    command === "log" ? settings.logChannelId : settings.moderatedChannelId,
    command,
  );

  // All account and asset validation occurs before the public send. A failed
  // lookup can therefore never leave a partial uniform log in the channel.
  const submission = await resolveSubmission(interaction, command);
  await channel.send({
    content: "",
    embeds: [uniformSubmissionEmbed(submission, interaction.user.id, avatarUrl)],
    allowedMentions: noMentions,
  });
  await interaction.editReply({
    content: "",
    embeds: [presentationEmbed(
      "Uniform Log Submitted",
      `Your /${command} submission was posted to the configured uniform channel.`,
      "success",
      avatarUrl,
      [{ name: "Destination", value: `<#${command === "log" ? settings.logChannelId : settings.moderatedChannelId}>` }],
    )],
    allowedMentions: noMentions,
  });
}

function discordIds(value: string, label: string): string[] {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.some((entry) => !/^\d{5,25}$/.test(entry))) {
    throw new Error(`${label} must contain only comma-separated Discord IDs, or be left blank to revoke access.`);
  }
  return [...new Set(entries)];
}

function optionalChannelId(value: string, label: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!/^\d{5,25}$/.test(trimmed)) {
    throw new Error(`${label} must be a Discord channel ID, or be left blank to disable that destination.`);
  }
  return trimmed;
}

async function fetchedMember(guild: Guild, id: string): Promise<GuildMember> {
  let result: unknown;
  try {
    result = await guild.members.fetch(id);
  } catch {
    throw new Error(`Member ${id} does not belong to this server or could not be fetched.`);
  }
  const member = result as GuildMember | null;
  if (!member || member.id !== id || (member.guild?.id && member.guild.id !== guild.id)) {
    throw new Error(`Member ${id} does not belong to this server.`);
  }
  return member;
}

export async function validateUniformSettings(
  guild: Guild,
  settings: UniformSettings,
): Promise<void> {
  const normalized = uniformSettingsFor({ uniforms: settings } as GuildSetup);
  if (normalized.logChannelId) {
    await requireUniformChannel(guild, normalized.logChannelId, "log");
  }
  if (normalized.moderatedChannelId) {
    await requireUniformChannel(guild, normalized.moderatedChannelId, "moderated");
  }
  for (const roleId of normalized.authorizedRoleIds) {
    if (!/^\d{5,25}$/.test(roleId)) throw new Error(`Role ${roleId} is not a valid Discord ID.`);
    let role: unknown;
    try {
      role = await guild.roles.fetch(roleId);
    } catch {
      role = null;
    }
    const guildId = (role as { guild?: { id?: string } } | null)?.guild?.id;
    if (!role || guildId !== guild.id) {
      throw new Error(`Role ${roleId} does not belong to this server.`);
    }
  }
  for (const memberId of normalized.authorizedMemberIds) {
    if (!/^\d{5,25}$/.test(memberId)) throw new Error(`Member ${memberId} is not a valid Discord ID.`);
    await fetchedMember(guild, memberId);
  }
}

export async function saveUniformSettings(
  guild: Guild,
  setup: GuildSetup,
  actorId: string,
  settings: UniformSettings,
): Promise<GuildSetup> {
  const normalized: UniformSettings = {
    ...defaultUniformSettings(),
    ...settings,
    authorizedRoleIds: [...new Set(settings.authorizedRoleIds ?? [])],
    authorizedMemberIds: [...new Set(settings.authorizedMemberIds ?? [])],
  };
  await validateUniformSettings(guild, normalized);
  const updated: GuildSetup = {
    ...setup,
    uniforms: normalized,
    updatedBy: actorId,
    updatedAt: new Date().toISOString(),
  };
  await saveGuildSetup(updated);
  return updated;
}

export async function resetUniformSettings(
  setup: GuildSetup,
  actorId: string,
): Promise<GuildSetup> {
  const updated = { ...setup } as GuildSetup & { uniforms?: UniformSettings };
  delete updated.uniforms;
  updated.updatedBy = actorId;
  updated.updatedAt = new Date().toISOString();
  await saveGuildSetup(updated);
  return updated;
}

export function uniformSettingsEmbed(
  setup: GuildSetup,
  avatarUrl?: string,
): EmbedBuilder {
  const settings = uniformSettingsFor(setup);
  const mentionList = (ids: string[], prefix: string): string =>
    ids.length ? ids.map((id) => `${prefix}${id}>`).join(", ") : "None — Administrators only";
  return presentationEmbed(
    "Uniforms",
    "Separate uniform logging destinations and submitter access. Administrators and the server owner can always submit.",
    "info",
    avatarUrl,
    [
      { name: "/log destination", value: settings.logChannelId ? `<#${settings.logChannelId}>` : "Not configured", inline: true },
      { name: "/moderated destination", value: settings.moderatedChannelId ? `<#${settings.moderatedChannelId}>` : "Not configured", inline: true },
      { name: "Authorized roles", value: mentionList(settings.authorizedRoleIds, "<@&"), inline: false },
      { name: "Authorized members", value: mentionList(settings.authorizedMemberIds, "<@"), inline: false },
    ],
  );
}

export async function renderUniformSettings(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  setup: GuildSetup,
  avatarUrl?: string,
): Promise<void> {
  await interaction.update({
    embeds: [uniformSettingsEmbed(setup, avatarUrl)],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("setup:uniforms-config")
          .setLabel("Uploading Configuration")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("setup:uniforms-reset")
          .setLabel("Reset Uniforms")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

export async function handleUniformSettingsComponent(
  interaction: ButtonInteraction,
  setup: GuildSetup,
): Promise<void> {
  const id = interaction.customId.replace(/:([a-f0-9]{32})$/, "");
  if (id === "setup:uniforms-reset") {
    const updated = await resetUniformSettings(setup, interaction.user.id);
    await interaction.update({
      embeds: [uniformSettingsEmbed(updated)],
      components: [],
    });
    return;
  }
  if (id !== "setup:uniforms-config") {
    throw new Error("That Uniforms settings control is no longer available.");
  }
  const settings = uniformSettingsFor(setup);
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId("setup-modal:uniforms")
      .setTitle("Uniform Uploading Configuration")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("log_channel_id")
            .setLabel("/log channel ID (optional)")
            .setStyle(TextInputStyle.Short)
            .setValue(settings.logChannelId ?? "")
            .setRequired(false)
            .setMaxLength(25),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("moderated_channel_id")
            .setLabel("/moderated channel ID (optional)")
            .setStyle(TextInputStyle.Short)
            .setValue(settings.moderatedChannelId ?? "")
            .setRequired(false)
            .setMaxLength(25),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("authorized_role_ids")
            .setLabel("Authorized role IDs (comma-separated)")
            .setStyle(TextInputStyle.Paragraph)
            .setValue(settings.authorizedRoleIds.join(", "))
            .setRequired(false)
            .setMaxLength(500),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("authorized_member_ids")
            .setLabel("Authorized member IDs (comma-separated)")
            .setStyle(TextInputStyle.Paragraph)
            .setValue(settings.authorizedMemberIds.join(", "))
            .setRequired(false)
            .setMaxLength(500),
        ),
      ),
  );
}

function uniformModalValue(
  interaction: ModalSubmitInteraction,
  id: string,
): string {
  try {
    return interaction.fields.getTextInputValue(id);
  } catch {
    throw new Error(`Missing Uniforms configuration field "${id}". Reopen the settings modal and try again.`);
  }
}

export async function handleUniformSettingsModal(
  interaction: ModalSubmitInteraction,
  setup: GuildSetup,
): Promise<GuildSetup> {
  const settings: UniformSettings = {
    logChannelId: optionalChannelId(
      uniformModalValue(interaction, "log_channel_id"),
      "/log channel ID",
    ),
    moderatedChannelId: optionalChannelId(
      uniformModalValue(interaction, "moderated_channel_id"),
      "/moderated channel ID",
    ),
    authorizedRoleIds: discordIds(
      uniformModalValue(interaction, "authorized_role_ids"),
      "Authorized role IDs",
    ),
    authorizedMemberIds: discordIds(
      uniformModalValue(interaction, "authorized_member_ids"),
      "Authorized member IDs",
    ),
  };
  const updated = await saveUniformSettings(
    interaction.guild!,
    setup,
    interaction.user.id,
    settings,
  );
  await interaction.reply({
    content: "",
    embeds: [presentationEmbed(
      "Uniforms Saved",
      "Uniform destinations and submitter access were validated and saved. Blank destinations disable that command; blank access lists restore Administrator-only access.",
      "success",
      undefined,
      [
        { name: "/log", value: updated.uniforms?.logChannelId ? `<#${updated.uniforms.logChannelId}>` : "Not configured", inline: true },
        { name: "/moderated", value: updated.uniforms?.moderatedChannelId ? `<#${updated.uniforms.moderatedChannelId}>` : "Not configured", inline: true },
      ],
    )],
    allowedMentions: noMentions,
    ephemeral: true,
  });
  return updated;
}
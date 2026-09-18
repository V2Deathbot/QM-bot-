import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type Attachment,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
  type PermissionResolvable,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";
import { randomBytes } from "node:crypto";
import { inflateSync } from "node:zlib";
import { purchaseFooter } from "./purchase-footers";
import {
  findRobloxUser,
  ownsRobloxAsset,
  RobloxInventoryPrivateError,
  RobloxOwnershipUnavailableError,
  verifyPublishedClassicShirt,
  type RobloxUser,
} from "./roblox";
import {
  defaultUniformSettings,
  getGuildSetup,
  saveGuildSetup,
  updateGuildSetup,
  commandPermissionFor,
  hasCommandPermissionEntry,
  uniformSettingsFor,
  type GuildSetup,
  type UniformSettings,
} from "./setup-store";
import { payoutWorkbookGeneration } from "./payout-store";
import {
  getUniformDelivery,
  claimUniformDeliveryAction,
  findUniformDeliveriesForChannel,
  findLegacyNonceRejectedDelivery,
  findPendingUniformModerationChecks,
  recoverLegacyNonceRejectedDelivery,
  claimUniformDeliveryStage,
  saveUniformDelivery,
  uniformDiscordNonce,
  updateUniformDelivery,
  type UniformDeliveryRecord,
} from "./uniform-delivery-store";
import { logger } from "../lib/logger";
import {
  displayId,
  noMentions,
  presentationEmbed,
  readableDate,
  safePresentationText,
} from "./presentation";
import {
  appendUniformRows,
  LOG_UNIFORM_COLUMN_COUNT,
  MODERATED_UNIFORM_COLUMN_COUNT,
  markUniformRowsSold,
  markUniformRowsNotified,
  normalizeUniformSpreadsheetConfig,
  normalizeUniformDataRange,
  replaceUniformRowLink,
  verifyUniformSubmissionRows,
  validateSpreadsheetConfiguration,
  type UniformSheetRow,
} from "./google-sheets";

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
const allowedUniformTypes = new Set([
  "ClassA", "ClassA_MP", "ClassA_HG", "ClassB", "Ike", "Bomber", "Flight",
  "Alpha", "Bravo", "DressBlue", "DressWhite",
  "White", "Khaki", "Blue", "Gray", "Overcoat",
]);
const uniformTypeChoices = [
  { name: "Army · ClassA", value: "ClassA" },
  { name: "Army · ClassA_MP", value: "ClassA_MP" },
  { name: "Army · ClassA_HG", value: "ClassA_HG" },
  { name: "Army · ClassB", value: "ClassB" },
  { name: "Army · Ike", value: "Ike" },
  { name: "Army · Bomber", value: "Bomber" },
  { name: "Army · Flight", value: "Flight" },
  { name: "Marines · Alpha", value: "Alpha" },
  { name: "Marines · Bravo", value: "Bravo" },
  { name: "Marines · DressBlue", value: "DressBlue" },
  { name: "Marines · DressWhite", value: "DressWhite" },
  { name: "Navy · White", value: "White" },
  { name: "Navy · Khaki", value: "Khaki" },
  { name: "Navy · Blue", value: "Blue" },
  { name: "Navy · Gray", value: "Gray" },
  { name: "Navy · Overcoat", value: "Overcoat" },
] as const;
const classicShirtWidth = 585;
const classicShirtHeight = 559;
const maximumUniformAttachmentBytes = 10 * 1024 * 1024;
const maximumUniformDecodedBytes = 8 * 1024 * 1024;
const uniformPublisherRoleId = "1548958021160411216";

export const uniformCommands = [
  new SlashCommandBuilder()
    .setName("created")
    .setDescription("Submit a created Classic Shirt PNG for review and publishing.")
    .addStringOption((option) =>
      option
        .setName("customer")
        .setDescription("Exact Roblox username for the customer.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("uniform_type")
        .setDescription("Uniform type for Shirt 1.")
        .setRequired(true)
        .addChoices(...uniformTypeChoices),
    )
    .addChannelOption((option) =>
      option.setName("channel").setDescription("Customer ticket channel.").setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .addAttachmentOption((option) =>
      option.setName("uniform").setDescription("Classic Shirt PNG using the Roblox template.").setRequired(true),
    )
    .addAttachmentOption((option) => option.setName("uniform2").setDescription("Optional Classic Shirt PNG #2.").setRequired(false))
    .addStringOption((option) => option.setName("uniform_type2").setDescription("Uniform type for Shirt 2.").setRequired(false).addChoices(...uniformTypeChoices))
    .addAttachmentOption((option) => option.setName("uniform3").setDescription("Optional Classic Shirt PNG #3.").setRequired(false))
    .addStringOption((option) => option.setName("uniform_type3").setDescription("Uniform type for Shirt 3.").setRequired(false).addChoices(...uniformTypeChoices))
    .addAttachmentOption((option) => option.setName("uniform4").setDescription("Optional Classic Shirt PNG #4.").setRequired(false))
    .addStringOption((option) => option.setName("uniform_type4").setDescription("Uniform type for Shirt 4.").setRequired(false).addChoices(...uniformTypeChoices))
    .addAttachmentOption((option) => option.setName("uniform5").setDescription("Optional Classic Shirt PNG #5.").setRequired(false))
    .addStringOption((option) => option.setName("uniform_type5").setDescription("Uniform type for Shirt 5.").setRequired(false).addChoices(...uniformTypeChoices)),
  new SlashCommandBuilder()
    .setName("moderated")
    .setDescription("Log a moderated uniform upload.")
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
        .setName("customer")
        .setDescription("Exact Roblox username for the customer.")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("shirtid")
        .setDescription("Roblox uniform asset ID or allowlisted Roblox URL.")
        .setRequired(true),
    )
    .addChannelOption((option) =>
      option.setName("channel").setDescription("Customer delivery channel.").setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),
  // Keep /relog intentionally narrow. The original delivery and asset are
  // selected from durable channel-bound records, not supplied as usernames.
  new SlashCommandBuilder()
    .setName("relog")
    .setDescription("Submit a replacement Classic Shirt PNG for an existing customer delivery.")
    .addChannelOption((option) =>
      option.setName("channel").setDescription("Original customer delivery channel.").setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .addAttachmentOption((option) =>
      option.setName("uniform").setDescription("Replacement Classic Shirt PNG using the Roblox template.").setRequired(true),
    ),
] as const;

export const uniformCommandNames = new Set(["created", "log", "moderated"]);
export const uniformRelogCommandName = "relog";

export type UniformCommandName = "log" | "moderated";

export const uniformSpreadsheetInputIds = [
  "spreadsheet_id",
  "log_tab",
  "moderated_tab",
  "log_range",
  "moderated_range",
] as const;

/**
 * This error is intentionally distinguishable by the command router: the
 * detailed spreadsheet rows are durable even when Discord's notification
 * endpoint fails, so the private response must never suggest a resubmission.
 */
export class UniformNotificationError extends Error {
  readonly sheetSaved = true;
  readonly notificationFailed = true;

  constructor(command: UniformCommandName, cause: unknown, notificationPosted = false) {
    super(
      `The /${command} uniform rows were saved to Google Sheets, but ` +
      `${notificationPosted ? "the notification status could not be recorded after the Discord notice was posted" : "the Discord notification failed"}. ` +
      `Do not resubmit; an administrator should check the configured channel. ` +
      `Notification error: ${cause instanceof Error ? cause.message : "unknown Discord error"}`,
    );
    this.name = "UniformNotificationError";
  }
}

type DiscordDeliveryStage =
  | "upload-log notice"
  | "customer delivery"
  | "purchase audit"
  | "relog handoff"
  | "relog audit";

interface DiscordFailureDetails {
  status?: number;
  code?: number;
}

/**
 * This deliberately exposes only Discord's stable status and API code.
 * Request payloads can contain names, mentions, and component data, while
 * Discord error objects can retain the complete request configuration.
 */
function discordFailureDetails(error: unknown): DiscordFailureDetails {
  if (!error || typeof error !== "object") return {};
  const value = error as {
    status?: unknown;
    code?: unknown;
    rawError?: { status?: unknown; code?: unknown };
  };
  const statusValue = value.status ?? value.rawError?.status;
  const codeValue = value.code ?? value.rawError?.code;
  return {
    ...(typeof statusValue === "number" && Number.isInteger(statusValue)
      ? { status: statusValue }
      : {}),
    ...(typeof codeValue === "number" && Number.isInteger(codeValue)
      ? { code: codeValue }
      : {}),
  };
}

export class UniformDiscordDeliveryError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly stage: DiscordDeliveryStage,
    readonly status?: number,
    readonly code?: number,
  ) {
    const details = [
      status === undefined ? "" : `HTTP ${status}`,
      code === undefined ? "" : `Discord code ${code}`,
    ].filter(Boolean).join(", ");
    const retryable = status === 400 || status === 403;
    super(
      retryable
        ? `Discord rejected the ${stage}${details ? ` (${details})` : ""}. Correct the destination or bot permissions, then choose Retry Delivery.`
        : `The ${stage} outcome could not be confirmed${details ? ` (${details})` : ""}. It will not be retried automatically.`,
    );
    this.name = "UniformDiscordDeliveryError";
    this.retryable = retryable;
  }
}

export type UniformDeliveryRetryControl = "enabled" | "disabled" | "none";

/**
 * A delivery interaction has already created a durable submission record. Keep
 * that record's ID attached to failures so the interaction router can repair
 * the same ephemeral response instead of replacing it with a generic error.
 * The retry control is deliberately explicit: authorization failures never
 * return a usable retry control, while ambiguous outbox states return only a
 * disabled control and a manual-verification explanation.
 */
export class UniformDeliveryRecoveryError extends Error {
  constructor(
    readonly submissionId: string,
    message: string,
    readonly retryControl: UniformDeliveryRetryControl,
  ) {
    super(message);
    this.name = "UniformDeliveryRecoveryError";
  }
}

function discordDeliveryFailure(stage: DiscordDeliveryStage, error: unknown): UniformDiscordDeliveryError {
  const { status, code } = discordFailureDetails(error);
  // Do not attach `error`: Discord.js error objects can include the request
  // body and authorization metadata. The structured fields are sufficient for
  // operations without logging customer data or secrets.
  logger.error(
    { stage, discordStatus: status, discordCode: code },
    "Discord uniform delivery failed",
  );
  return new UniformDiscordDeliveryError(stage, status, code);
}

const activeUniformSubmissions = new Set<string>();
const uniformConfirmationLifetimeMs = 10 * 60_000;
interface PendingUniformConfirmation {
  nonce: string;
  submissionId: string;
  guildId: string;
  actorId: string;
  command: UniformCommandName;
  twoStage?: boolean;
  submission: UniformSubmission;
  attachmentBuffer?: Buffer;
  attachmentBuffers?: Buffer[];
  destinationChannelId: string;
  ticketChannelName: string;
  customerId?: string;
  seqmId?: string;
  expiresAt: number;
  workbookGeneration?: number;
}
const pendingUniformConfirmations = new Map<string, PendingUniformConfirmation>();
interface PendingRelogConfirmation {
  nonce: string;
  guildId: string;
  actorId: string;
  channelId: string;
  newAsset?: UniformAsset;
  replacementAttachment?: NonNullable<UniformSubmission["sourceAttachment"]>;
  attachmentBuffer?: Buffer;
  choices: Array<{ submissionId: string; rowIndex: number }>;
  expiresAt: number;
}
const pendingRelogConfirmations = new Map<string, PendingRelogConfirmation>();

export function resetUniformSubmissionStateForTests(): void {
  activeUniformSubmissions.clear();
  pendingUniformConfirmations.clear();
  pendingRelogConfirmations.clear();
}

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
    publisher?: RobloxUser;
  };
  assets: UniformAsset[];
  uniformType?: string;
  uniformTypes?: string[];
  publisherName?: string;
  sourceAttachment?: {
    name: string;
    contentType: "image/png";
    size: number;
    url: string;
  };
  sourceAttachments?: Array<NonNullable<UniformSubmission["sourceAttachment"]>>;
  sourceBuffers?: Buffer[];
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

function optionAttachment(
  interaction: ChatInputCommandInteraction,
  name: string,
  required = false,
): Attachment | undefined {
  const getter = (interaction.options as unknown as {
    getAttachment?: (optionName: string, isRequired?: boolean) => Attachment | null;
  }).getAttachment;
  const value = typeof getter === "function"
    ? getter.call(interaction.options, name, required)
    : null;
  if (!value && required) throw new Error(`Missing required attachment "${name}".`);
  return value ?? undefined;
}

async function validatedClassicShirtAttachment(
  interaction: ChatInputCommandInteraction,
  optionName = "uniform",
): Promise<{
  attachment: NonNullable<UniformSubmission["sourceAttachment"]>;
  buffer: Buffer;
}> {
  const attachment = optionAttachment(interaction, optionName, true)!;
  if (
    attachment.contentType !== "image/png" ||
    !attachment.name.toLowerCase().endsWith(".png")
  ) {
    throw new Error("The uniform attachment must be a PNG file.");
  }
  if (
    !Number.isSafeInteger(attachment.size) ||
    attachment.size <= 0 ||
    attachment.size > maximumUniformAttachmentBytes
  ) {
    throw new Error("The uniform PNG must be between 1 byte and 10 MB.");
  }
  let response: Response;
  try {
    response = await fetch(attachment.url, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error("The uniform PNG could not be downloaded from Discord.");
  }
  if (!response.ok) {
    throw new Error(`The uniform PNG could not be downloaded from Discord (HTTP ${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== attachment.size || bytes.length > maximumUniformAttachmentBytes) {
    throw new Error("The downloaded uniform PNG size did not match the Discord attachment.");
  }
  const { width, height } = validatedPngDimensions(bytes);
  if (width !== classicShirtWidth || height !== classicShirtHeight) {
    throw new Error(
      `The Classic Shirt PNG must be exactly ${classicShirtWidth}×${classicShirtHeight} pixels.`,
    );
  }
  return {
    attachment: {
      name: attachment.name.slice(0, 100),
      contentType: "image/png",
      size: attachment.size,
      url: attachment.url,
    },
    buffer: bytes,
  };
}

function pngCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validatedPngDimensions(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 45 || !bytes.subarray(0, signature.length).equals(signature)) {
    throw new Error("The uniform attachment is not a valid PNG image.");
  }
  let offset = signature.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let sawHeader = false;
  let sawEnd = false;
  let sawPalette = false;
  const compressed: Buffer[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error("The uniform PNG is truncated.");
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (length > maximumUniformAttachmentBytes || crcOffset + 4 > bytes.length) {
      throw new Error("The uniform PNG contains an invalid chunk.");
    }
    const type = bytes.toString("ascii", typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("The uniform PNG contains an invalid chunk type.");
    const expectedCrc = bytes.readUInt32BE(crcOffset);
    const actualCrc = pngCrc32(bytes.subarray(typeStart, dataEnd));
    if (actualCrc !== expectedCrc) throw new Error("The uniform PNG failed its integrity check.");
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) throw new Error("The uniform PNG has no valid image header.");
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      const validDepths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !validDepths[colorType]?.includes(bitDepth) ||
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        bytes[dataStart + 12] !== 0
      ) {
        throw new Error("The uniform PNG uses unsupported or invalid image settings.");
      }
      sawHeader = true;
    } else if (type === "IHDR") {
      throw new Error("The uniform PNG contains more than one image header.");
    }
    if (type === "PLTE") sawPalette = length > 0 && length % 3 === 0;
    if (type === "IDAT") compressed.push(bytes.subarray(dataStart, dataEnd));
    if (type === "IEND") {
      if (length !== 0) throw new Error("The uniform PNG has an invalid end marker.");
      offset = crcOffset + 4;
      sawEnd = true;
      break;
    }
    offset = crcOffset + 4;
  }
  if (!sawHeader || !sawEnd || offset !== bytes.length || !compressed.length) {
    throw new Error("The uniform PNG is incomplete.");
  }
  try {
    const decoded = inflateSync(Buffer.concat(compressed), {
      maxOutputLength: maximumUniformDecodedBytes,
    });
    if (colorType === 3 && !sawPalette) throw new Error("missing palette");
    const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
    const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
    const expectedLength = height * (rowBytes + 1);
    if (decoded.length !== expectedLength) throw new Error("invalid scanline length");
    for (let row = 0; row < height; row += 1) {
      if (decoded[row * (rowBytes + 1)]! > 4) throw new Error("invalid scanline filter");
    }
  } catch {
    throw new Error("The uniform PNG image data is corrupt or too large.");
  }
  return { width, height };
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
  twoStage = false,
): Array<{ key: keyof UniformSubmission["users"]; label: string }> {
  return command === "log"
    ? twoStage
      ? [{ key: "customer", label: "Customer" }]
      : [
          { key: "customer", label: "Customer" },
          { key: "qm", label: "Quartermaster" },
          { key: "seqm", label: "Senior Quartermaster" },
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
  twoStage = false,
): Promise<{ submission: UniformSubmission; attachmentBuffer?: Buffer; attachmentBuffers?: Buffer[] }> {
  const inputs = userInputsFor(interaction, command, twoStage);
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

  if (command === "log") {
    if (twoStage) {
      const creator = await currentMember(interaction.guild!, interaction.user.id);
      const creatorName = creator.displayName?.trim() ||
        interaction.user.globalName?.trim() ||
        interaction.user.username;
      users.qm = { id: 0, name: creatorName, displayName: creatorName };
      users.seqm = { id: 0, name: "Pending", displayName: "Pending" };
    }
    const legacyAssetInput = optionString(interaction, "shirtid1");
    const uniformType = (
      optionString(interaction, "uniform_type") ??
      (legacyAssetInput ? "ClassA" : "")
    ).trim();
    if (!allowedUniformTypes.has(uniformType)) {
      throw new Error("Select one of the approved Army, Marines, or Navy uniform types.");
    }
    // Preserve handler compatibility with confirmations created before the
    // attachment-first command contract was registered. New Discord commands
    // cannot supply these removed options.
    if (legacyAssetInput) {
      return {
        submission: {
          command,
          users,
          assets: [parseUniformAssetInput(legacyAssetInput)],
          uniformType,
          publisherName:
            optionString(interaction, "publisher")?.trim() ||
            interaction.client.user?.username?.trim() ||
            "Quartermaster Bot",
        },
      };
    }
    const attachments: Array<NonNullable<UniformSubmission["sourceAttachment"]>> = [];
    const buffers: Buffer[] = [];
    const uniformTypes: string[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const optionName = index === 1 ? "uniform" : `uniform${index}`;
      const typeOptionName = index === 1 ? "uniform_type" : `uniform_type${index}`;
      const attachment = optionAttachment(interaction, optionName, index === 1);
      const shirtType = index === 1 ? uniformType : optionString(interaction, typeOptionName)?.trim();
      if (!attachment) {
        if (shirtType) {
          throw new Error(`Shirt ${index} type cannot be selected without Shirt ${index}.`);
        }
        if (index > 1) {
          for (let later = index + 1; later <= 5; later += 1) {
            if (optionAttachment(interaction, `uniform${later}`, false)) {
              throw new Error("Uniform PNG attachments must be provided in order without gaps.");
            }
          }
        }
        continue;
      }
      if (!shirtType) {
        throw new Error(`Select a uniform type for Shirt ${index}.`);
      }
      if (!allowedUniformTypes.has(shirtType)) {
        throw new Error(`Select an approved uniform type for Shirt ${index}.`);
      }
      const validated = await validatedClassicShirtAttachment(interaction, optionName);
      attachments.push(validated.attachment);
      buffers.push(validated.buffer);
      uniformTypes.push(shirtType);
    }
    const publisherName = interaction.client.user?.username?.trim() || "Quartermaster Bot";
    return {
      submission: {
        command,
        users,
        assets: [],
        uniformType,
        uniformTypes,
        publisherName,
        sourceAttachment: attachments[0],
        sourceAttachments: attachments,
        sourceBuffers: buffers,
      },
      attachmentBuffer: buffers[0],
      attachmentBuffers: buffers,
    };
  }

  const assets = assetInputsFor(interaction, command).map((input) => {
    try {
      return parseUniformAssetInput(input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Invalid uniform asset.";
      throw new Error(`Could not validate uniform asset "${input}": ${reason}`);
    }
  });

  return { submission: { command, users, assets } };
}

function memberHasRole(member: GuildMember, roleIds: string[]): boolean {
  const cache = member.roles?.cache as
    | { has?: (id: string) => boolean; some?: (predicate: (role: { id: string }) => boolean) => boolean }
    | undefined;
  if (cache?.some && cache.some((role) => roleIds.includes(role.id))) return true;
  return Boolean(cache?.has && roleIds.some((id) => cache.has!(id)));
}

async function discordPublisherName(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<string> {
  const member = await currentMember(interaction.guild!, interaction.user.id);
  return member.displayName?.trim() ||
    interaction.user.globalName?.trim() ||
    interaction.user.username?.trim() ||
    interaction.user.id;
}

/**
 * Named Quartermaster roles are a convenience authorization layer for uniform
 * work only.  They are combined at the point of authorization, never copied
 * into the editable generic role list.
 */
function uniformAccessSettings(setup: GuildSetup, command?: UniformCommandName): UniformSettings {
  const settings = uniformSettingsFor(setup);
  const permissionCommand = command === "log" ? "created" : command;
  const grant = permissionCommand && hasCommandPermissionEntry(setup, permissionCommand)
    ? commandPermissionFor(setup, permissionCommand)
    : command === "log" && hasCommandPermissionEntry(setup, "log")
      ? commandPermissionFor(setup, "log")
      : undefined;
  return {
    ...settings,
    authorizedRoleIds: grant?.roleIds ?? [],
    authorizedMemberIds: grant?.memberIds ?? [],
  };
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
  name?: string;
  permissionsFor: (member: GuildMember) => { has: (permissions: PermissionResolvable[]) => boolean } | null;
  send: (payload: unknown) => Promise<unknown>;
  messages?: {
    fetch: (messageId: string) => Promise<{ edit: (payload: unknown) => Promise<unknown> } | null>;
  };
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

function sheetValue(value: string | number | null | undefined): string {
  // The API request uses valueInputOption=RAW.  Do not turn user-provided
  // usernames or links into formulas while keeping empty role columns useful.
  return value === undefined ? "" : String(value);
}

export function uniformSheetRows(
  submission: UniformSubmission,
  interaction: Pick<ChatInputCommandInteraction, "id" | "user" | "guildId">,
  _at: Date,
): UniformSheetRow[] {
  if (!interaction.id) {
    throw new Error("The Discord interaction has no submission ID.");
  }
  const users = submission.users;
  const publisherName = submission.publisherName ?? users.publisher?.name ?? "Quartermaster Bot";
  // The visible worksheet has a user-established schema. Do not add IDs,
  // dates, command type, notification state, or any other metadata to it.
  if (
    submission.command === "log" &&
    submission.sourceAttachment &&
    submission.assets.length === 0
  ) {
    return [[
      sheetValue(users.qm?.name),
      sheetValue(users.seqm?.name),
      sheetValue(publisherName),
      sheetValue(users.customer.name),
      "",
    ]];
  }
  return submission.assets.map((asset) => submission.command === "log"
    ? [
        sheetValue(users.qm?.name),
        sheetValue(users.seqm?.name),
        sheetValue(publisherName),
        sheetValue(users.customer.name),
        sheetValue(asset.url),
      ]
    : [
        sheetValue(users.uploader?.name),
        sheetValue(publisherName),
        sheetValue(users.customer.name),
        sheetValue(asset.url),
      ]);
}

function configuredSpreadsheet(
  settings: UniformSettings,
): UniformSettings["spreadsheet"] {
  return settings.spreadsheet
    ? normalizeUniformSpreadsheetConfig(settings.spreadsheet)
    : undefined;
}

function sentDiscordMessageId(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}

export async function validateUniformSpreadsheetSettings(
  settings: UniformSettings,
): Promise<void> {
  if (!settings.spreadsheet) {
    throw new Error(
      "Google Sheets is not configured. Ask an Administrator to open /settings → Uniforms → Spreadsheet Configuration and save a spreadsheet URL or ID.",
    );
  }
  await validateSpreadsheetConfiguration(settings.spreadsheet);
}

export async function saveUniformSpreadsheetSettings(
  guild: Guild,
  setup: GuildSetup,
  actorId: string,
  spreadsheet: UniformSettings["spreadsheet"],
): Promise<GuildSetup> {
  if (!spreadsheet) throw new Error("Spreadsheet configuration is required.");
  const normalized = normalizeUniformSpreadsheetConfig(spreadsheet);
  await validateSpreadsheetConfiguration(normalized);
  return updateGuildSetup(setup.guildId, async (latest) => {
    const base = latest ?? setup;
    const current = uniformSettingsFor(base);
    const merged: UniformSettings = {
      ...current,
      spreadsheet: normalized,
    };
    await validateUniformSettings(guild, merged);
    return {
      ...base,
      uniforms: merged,
      updatedBy: actorId,
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function resetUniformSpreadsheetSettings(
  setup: GuildSetup,
  actorId: string,
): Promise<GuildSetup> {
  return updateGuildSetup(setup.guildId, (latest) => {
    const base = latest ?? setup;
    const current = uniformSettingsFor(base);
    const remaining: UniformSettings = {
      ...current,
      spreadsheet: undefined,
    };
    const updated = {
      ...base,
      uniforms: remaining,
      updatedBy: actorId,
      updatedAt: new Date().toISOString(),
    } as GuildSetup;
    if (!remaining.logChannelId &&
        !remaining.moderatedChannelId &&
        !remaining.authorizedRoleIds.length &&
        !remaining.authorizedMemberIds.length) {
      delete updated.uniforms;
    }
    return updated;
  });
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
        { name: "Publisher", value: submission.users.publisher
          ? profileLink(submission.users.publisher)
          : safePresentationText(submission.publisherName ?? "Quartermaster Bot"), inline: true },
      ]
    : [
        { name: "Customer", value: profileLink(submission.users.customer), inline: true },
        { name: "Uploader", value: profileLink(submission.users.uploader!), inline: true },
        { name: "Publisher", value: submission.users.publisher
          ? profileLink(submission.users.publisher)
          : safePresentationText(submission.publisherName ?? "Quartermaster Bot"), inline: true },
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
  if (!uniformCommandNames.has(interaction.commandName)) {
    throw new Error("That is not a uniform logging command.");
  }
  const twoStage = interaction.commandName === "created";
  const command: UniformCommandName = twoStage || interaction.commandName === "log" ? "log" : "moderated";
  const settings = uniformAccessSettings(setup, command);
  await requireUniformSubmitter(interaction.guild!, interaction.user.id, settings);
  // Validate both the configured audit destination and the explicitly chosen
  // customer destination before opening the private confirmation.
  await requireUniformChannel(
    interaction.guild!, command === "log" ? settings.seqmReviewChannelId ?? settings.logChannelId : settings.moderatedChannelId, command,
  );
  const selectedChannel = interaction.options.getChannel("channel", true);
  const ticketChannel = await requireUniformChannel(interaction.guild!, selectedChannel.id, command);
  const resolved = await resolveSubmission(interaction, command, twoStage);
  const submission = resolved.submission;
  const submissionId = interaction.id;
  if (!submissionId) throw new Error("The Discord interaction has no submission ID.");
  const nonce = randomBytes(16).toString("hex");
  const pending: PendingUniformConfirmation = {
    nonce, submissionId, guildId: interaction.guildId!, actorId: interaction.user.id,
    command, submission, attachmentBuffer: resolved.attachmentBuffer,
    attachmentBuffers: resolved.attachmentBuffers,
    twoStage,
    destinationChannelId: selectedChannel.id,
    ticketChannelName: typeof ticketChannel.name === "string" && ticketChannel.name.trim()
      ? ticketChannel.name.trim()
      : "Ticket name unavailable",
    expiresAt: Date.now() + uniformConfirmationLifetimeMs,
    ...(settings.spreadsheet ? { workbookGeneration: await payoutWorkbookGeneration(settings.spreadsheet.spreadsheetId) } : {}),
  };
  pendingUniformConfirmations.set(nonce, pending);
  await interaction.editReply({
    content: "",
    embeds: [presentationEmbed(
      "Confirm Uniform Delivery",
      command === "log"
        ? "Review the /created submission. Select the customer Discord account, then submit. No Google Sheets rows or Discord messages have been sent yet."
        : "Review the /moderated submission. Select the customer Discord account, then submit. No Google Sheets rows or Discord messages have been sent yet.",
      "info",
      avatarUrl,
      [
        { name: "Customer", value: "Not selected", inline: true },
        { name: "Delivery channel", value: `<#${selectedChannel.id}>`, inline: true },
        { name: command === "log" ? "Uniform type" : "Assets", value: command === "log"
          ? safePresentationText(submission.uniformType ?? "Unknown")
          : `${submission.assets.length} uniform asset${submission.assets.length === 1 ? "" : "s"}` },
      ],
    )],
    components: uniformConfirmationComponents(nonce, command, false),
    allowedMentions: noMentions,
  });
}

function relogChoiceLabel(record: UniformDeliveryRecord, rowIndex: number): string {
  const asset = record.assets[rowIndex];
  return `${record.command === "log" ? "Log" : "Moderated"} · ${record.customerName} · asset ${rowIndex + 1}${asset ? ` (${asset.id})` : ""}`
    .slice(0, 100);
}

async function relogAuthorized(
  guild: Guild,
  actorId: string,
  record: UniformDeliveryRecord,
  setup?: GuildSetup,
): Promise<boolean> {
  const member = await currentMember(guild, actorId);
  if (guild.ownerId === member.id || member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (setup && hasCommandPermissionEntry(setup, "relog")) {
    const grant = commandPermissionFor(setup, "relog");
    return grant.memberIds.includes(actorId) ||
      memberHasRole(member, grant.roleIds);
  }
  return false;
}

function relogPending(nonce: string, interaction: { guildId: string | null; user: { id: string } }): PendingRelogConfirmation {
  const pending = pendingRelogConfirmations.get(nonce);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingRelogConfirmations.delete(nonce);
    throw new Error("This relog selection has expired. Run /relog again.");
  }
  if (pending.guildId !== interaction.guildId || pending.actorId !== interaction.user.id) {
    throw new Error("Only the person who started this relog can select its original delivery.");
  }
  return pending;
}

function relogSelectionPayload(pending: PendingRelogConfirmation, records: UniformDeliveryRecord[]) {
  const options = pending.choices.map(({ submissionId, rowIndex }) => {
    const record = records.find((candidate) => candidate.submissionId === submissionId)!;
    return {
      label: relogChoiceLabel(record, rowIndex),
      description: `Recorded delivery ${submissionId}`.slice(0, 100),
      value: `${submissionId}:${rowIndex}`,
    };
  });
  return {
    embeds: [presentationEmbed(
      "Select Original Uniform Delivery",
      "More than one recorded delivery or asset matches this channel. Select the exact original asset to replace. No spreadsheet cells or customer messages have changed.",
      "info",
      undefined,
      [{ name: pending.replacementAttachment ? "Replacement PNG" : "Replacement asset", value:
        pending.replacementAttachment
          ? safePresentationText(pending.replacementAttachment.name)
          : `[Open Roblox asset](${pending.newAsset!.url})` }],
    )],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`uniform:relog-select:${pending.nonce}`)
        .setPlaceholder("Select original delivery and asset")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(options),
    )],
    allowedMentions: noMentions,
  };
}

function relogSuccessPayload(record: UniformDeliveryRecord) {
  return {
    embeds: [presentationEmbed(
      "Uniform Link Replaced",
      `The original spreadsheet row was updated in place and a fresh customer delivery was posted to <#${record.destinationChannelId}>. No new spreadsheet row or upload-log notice was created.`,
      "success",
      undefined,
      [{ name: "Submission ID", value: displayId(record.submissionId), inline: true }],
    )],
    components: [],
    allowedMentions: noMentions,
  };
}

async function startRelog(
  record: UniformDeliveryRecord,
  rowIndex: number,
  newAsset: UniformAsset,
): Promise<UniformDeliveryRecord> {
  if (record.relog?.state === "sent" &&
      record.relog.rowIndex === rowIndex &&
      record.relog.newAsset.url === newAsset.url) {
    // A replayed interaction/command is already complete. Its durable message
    // ID and revision are authoritative; do not create another customer ping.
    return record;
  }
  if (record.relog && record.relog.state !== "sent") {
    if (record.relog.rowIndex === rowIndex && record.relog.newAsset.url === newAsset.url) {
      throw new Error("This relog is already in progress. Use Retry Delivery only after a definite Discord delivery failure.");
    }
    throw new Error("A prior relog for this delivery is unresolved. No replacement was guessed or sent.");
  }
  if (!record.customerMessageId) {
    throw new Error("The recorded customer delivery message ID is missing. No spreadsheet cells or messages were changed.");
  }
  return updateUniformDelivery(record.submissionId, (item) => {
    if (item.relog && item.relog.state !== "sent") {
      throw new Error("A relog is already in progress for this delivery.");
    }
    if (item.action && item.action.state !== "sent") {
      throw new Error("A customer action is already in progress or unresolved. No relog was started.");
    }
    if (!item.customerMessageId) {
      throw new Error("The recorded customer delivery message ID is missing. No spreadsheet cells or messages were changed.");
    }
    const oldCustomerMessageId = item.customerMessageId;
    item.relog = {
      state: "claimed",
      auditState: "pending",
      rowIndex,
      newAsset,
      oldCustomerMessageId,
      nonce: `u-relog-${randomBytes(8).toString("hex")}`,
      startedAt: new Date().toISOString(),
    };
    // Keep the old message ID as recovery metadata until the replacement
    // message is confirmed. claimUniformDeliveryAction blocks its controls
    // while this relog is in progress.
    item.customerMessageRevision = (item.customerMessageRevision ?? 0) + 1;
    delete item.terminal;
    delete item.action;
  });
}

async function selectAndStartRelog(
  record: UniformDeliveryRecord,
  rowIndex: number,
  newAsset: UniformAsset,
  guild: Guild,
  publisherName = record.publishing?.publisherName ?? "Quartermaster Bot",
): Promise<UniformDeliveryRecord> {
  if (!Array.isArray(record.rows) || !Array.isArray(record.assets) ||
      !Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= record.assets.length ||
      rowIndex >= record.rows.length ||
      record.assets[rowIndex]?.url !== record.rows[rowIndex]?.at(-1)) {
    throw new Error("The selected original asset has no trusted spreadsheet row metadata. No cells were changed.");
  }
  // Refuse old records that do not have the original immutable ledger target
  // before invalidating their customer controls.
  const ledgerRows = await verifyUniformSubmissionRows(
    record.spreadsheet, record.command, record.submissionId,
  );
  if (record.rows.length !== ledgerRows.length ||
      record.rows.some((row, index) => row.length !== ledgerRows[index]?.length ||
        row.some((cell, column) => cell !== ledgerRows[index]![column]))) {
    throw new Error("The recorded delivery no longer matches its original spreadsheet rows. No cells or messages were changed.");
  }
  const current = await startRelog(record, rowIndex, newAsset);
  await updateUniformDelivery(record.submissionId, (item) => {
    if (item.relog?.state !== "claimed") throw new Error("The relog publisher could not be recorded.");
    item.relog.publisherName = publisherName;
  });
  return continueRelog(current, guild);
}

async function continueRelog(record: UniformDeliveryRecord, guild: Guild): Promise<UniformDeliveryRecord> {
  let current = await getUniformDelivery(record.submissionId) ?? record;
  const relog = current.relog;
  if (!relog) throw new Error("This recorded relog is unavailable.");
  if (relog.state === "sent") return sendRelogAudit(current, guild);
  if (relog.state === "customer-claimed" || relog.state === "unresolved") {
    if (relog.state === "customer-claimed") {
      await updateUniformDelivery(current.submissionId, (item) => {
        if (item.relog?.state === "customer-claimed") item.relog.state = "unresolved";
      });
    }
    throw new Error("The replacement customer delivery outcome is unresolved. No duplicate message will be sent.");
  }
  if (relog.state === "claimed") {
    if (relog.rowIndex < 0) throw new Error("The relog has no selected original asset. No cells were changed.");
    await replaceUniformRowLink({
      config: current.spreadsheet,
      logKind: current.command,
      submissionId: current.submissionId,
      rowIndex: relog.rowIndex,
      newLink: relog.newAsset.url,
      publisherName: relog.publisherName,
    });
    current = await updateUniformDelivery(current.submissionId, (item) => {
      const operation = item.relog;
      if (!operation || operation.state !== "claimed") {
        throw new Error("The relog operation changed before the sheet update was recorded.");
      }
      const row = item.rows[operation.rowIndex];
      if (!row || row.length !== (item.command === "log" ? LOG_UNIFORM_COLUMN_COUNT : MODERATED_UNIFORM_COLUMN_COUNT)) {
        throw new Error("The recorded relog row is incomplete. No customer message was sent.");
      }
      row[row.length - 1] = operation.newAsset.url;
      if (operation.publisherName) row[item.command === "log" ? 2 : 1] = operation.publisherName;
      item.assets[operation.rowIndex] = operation.newAsset;
      operation.state = "sheet-updated";
    });
  }
  current = await getUniformDelivery(record.submissionId) ?? current;
  if (current.relog?.state === "pending" || current.relog?.state === "sheet-updated") {
    current = await sendRelogDelivery(current, guild);
  }
  return current.relog?.state === "sent" ? sendRelogAudit(current, guild) : current;
}

async function sendRelogDelivery(record: UniformDeliveryRecord, guild: Guild): Promise<UniformDeliveryRecord> {
  const operation = record.relog;
  if (!operation || (operation.state !== "sheet-updated" && operation.state !== "pending")) {
    throw new Error("This replacement delivery is not ready to send.");
  }
  const destination = await requireUniformChannel(guild, record.destinationChannelId, record.command);
  let current = await updateUniformDelivery(record.submissionId, (item) => {
    if (!item.relog || (item.relog.state !== "sheet-updated" && item.relog.state !== "pending")) {
      throw new Error("This replacement delivery is not ready to send.");
    }
    item.relog.state = "customer-claimed";
  });
  try {
    const message = await destination.send({
      content: `<@${current.customerId}>`,
      embeds: [customerDeliveryEmbed(current)],
      components: customerDeliveryButtons(current),
      allowedMentions: { parse: [], users: [current.customerId] },
      nonce: current.relog!.nonce,
      enforceNonce: true,
    });
    const messageId = sentMessageId(message);
    if (!messageId) throw new Error("Discord did not return a message ID for the replacement customer delivery.");
    current = await updateUniformDelivery(record.submissionId, (item) => {
      if (!item.relog || item.relog.state !== "customer-claimed") {
        throw new Error("The replacement delivery state changed before its message ID was recorded.");
      }
      item.customerMessageId = messageId;
      item.customerDeliveryState = "sent";
      item.relog.state = "sent";
    });
  } catch (error) {
    const failure = error instanceof UniformDiscordDeliveryError
      ? error
      : discordDeliveryFailure("customer delivery", error);
    await updateUniformDelivery(record.submissionId, (item) => {
      if (item.relog?.state === "customer-claimed") item.relog.state = failure.retryable ? "pending" : "unresolved";
    }).catch(() => undefined);
    throw failure;
  }
  return current;
}

async function sendRelogAudit(record: UniformDeliveryRecord, guild: Guild): Promise<UniformDeliveryRecord> {
  let current = await getUniformDelivery(record.submissionId) ?? record;
  const auditState = current.relog?.auditState ?? "pending";
  if (!current.relog || current.relog.state !== "sent" || auditState === "sent") return current;
  if (auditState === "unresolved") {
    throw new Error("The relog audit outcome is unresolved. No duplicate audit message will be sent.");
  }
  if (auditState === "claimed") {
    await updateUniformDelivery(current.submissionId, (item) => {
      if (item.relog?.auditState === "claimed") item.relog.auditState = "unresolved";
    });
    throw new Error("The relog audit outcome is unresolved. No duplicate audit message will be sent.");
  }
  const operationNonce = current.relog.nonce;
  current = await updateUniformDelivery(current.submissionId, (item) => {
    if (!item.relog || item.relog.state !== "sent" || (item.relog.auditState && item.relog.auditState !== "pending")) {
      throw new Error("The relog audit is no longer ready to send.");
    }
    item.relog.auditState = "claimed";
  });
  try {
    const channel = await requireUniformChannel(guild, current.uploadLogChannelId, current.command);
    await channel.send({
      content: "",
      embeds: [relogAuditEmbed(current)],
      allowedMentions: noMentions,
      // A submission can legitimately relog more than one of its ten assets.
      // Bind the audit nonce to the durable relog operation, not just the
      // submission, while retaining a stable key for retries of this operation.
      nonce: uniformDiscordNonce("relog", `${current.submissionId}:${operationNonce}`),
      enforceNonce: true,
    });
    return updateUniformDelivery(current.submissionId, (item) => {
      if (item.relog?.auditState === "claimed") item.relog.auditState = "sent";
    });
  } catch (error) {
    const failure = error instanceof UniformDiscordDeliveryError
      ? error
      : discordDeliveryFailure("relog audit", error);
    await updateUniformDelivery(current.submissionId, (item) => {
      if (item.relog?.auditState === "claimed") item.relog.auditState = failure.retryable ? "pending" : "unresolved";
    }).catch(() => undefined);
    throw failure;
  }
}

function relogPublishingComponents(record: UniformDeliveryRecord, disabled = false) {
  const nonce = record.relogHandoff!.nonce;
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`uniform:relog-publish-success:${record.submissionId}:${nonce}`)
      .setLabel("Complete Replacement Upload")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`uniform:relog-publish-moderated:${record.submissionId}:${nonce}`)
      .setLabel("Roblox Moderation Denied")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  )];
}

function relogPublishingEmbed(record: UniformDeliveryRecord): EmbedBuilder {
  const handoff = record.relogHandoff!;
  return presentationEmbed(
    "Replacement Classic Shirt Awaiting Roblox Upload",
    "Upload the attached replacement PNG through Roblox Creator Dashboard. The existing spreadsheet row and customer message remain unchanged until a published catalog link is completed.",
    "info",
    undefined,
    [
      { name: "Roblox item name", value: safePresentationText(record.customerName), inline: true },
      { name: "Roblox description", value: safePresentationText(handoff.uniformType), inline: true },
      { name: "Customer ticket", value: `<#${record.destinationChannelId}>`, inline: true },
      { name: "Original asset", value: record.assets[handoff.rowIndex]?.url ?? "Unavailable" },
    ],
  );
}

function relogHandoffStartedPayload(record: UniformDeliveryRecord) {
  return {
    embeds: [presentationEmbed(
      "Replacement Awaiting Roblox Upload",
      "The replacement PNG and instructions were posted to the upload-log channel. The existing spreadsheet row and customer message are still unchanged.",
      "info",
      undefined,
      [{ name: "Customer ticket", value: `<#${record.destinationChannelId}>`, inline: true }],
    )],
    components: [],
    allowedMentions: noMentions,
  };
}

async function startRelogPublishingHandoff(
  record: UniformDeliveryRecord,
  rowIndex: number,
  actorId: string,
  attachment: NonNullable<UniformSubmission["sourceAttachment"]>,
  attachmentBuffer: Buffer | undefined,
  guild: Guild,
): Promise<UniformDeliveryRecord> {
  if (record.relogHandoff && record.relogHandoff.state !== "published" &&
      record.relogHandoff.state !== "moderated") {
    throw new Error("A replacement publishing handoff is already active or unresolved for this delivery.");
  }
  if (!record.customerMessageId || !record.assets[rowIndex] || !record.rows[rowIndex] ||
      record.rows[rowIndex]?.at(-1) !== record.assets[rowIndex]?.url) {
    throw new Error("The selected original asset has no trusted delivery metadata. No replacement was started.");
  }
  const ledgerRows = await verifyUniformSubmissionRows(
    record.spreadsheet, record.command, record.submissionId,
  );
  if (record.rows.length !== ledgerRows.length ||
      record.rows.some((row, index) => row.length !== ledgerRows[index]?.length ||
        row.some((cell, column) => cell !== ledgerRows[index]![column]))) {
    throw new Error("The recorded delivery no longer matches its original spreadsheet rows. No replacement was started.");
  }
  const nonce = randomBytes(8).toString("hex");
  let current = await updateUniformDelivery(record.submissionId, (item) => {
    if (item.relogHandoff && item.relogHandoff.state !== "published" &&
        item.relogHandoff.state !== "moderated") {
      throw new Error("A replacement publishing handoff is already active.");
    }
    item.relogHandoff = {
      state: "handoff-pending",
      actorId,
      rowIndex,
      uniformType: item.publishing?.uniformType ?? "Replacement",
      attachment,
      nonce,
      ...(attachmentBuffer
        ? { sourceDataBase64: attachmentBuffer.toString("base64") }
        : {}),
    };
  });
  return sendRelogPublishingHandoff(current, guild, attachmentBuffer);
}

async function sendRelogPublishingHandoff(
  record: UniformDeliveryRecord,
  guild: Guild,
  attachmentBuffer?: Buffer,
  attachmentBuffers?: Buffer[],
): Promise<UniformDeliveryRecord> {
  const operation = record.relogHandoff;
  if (!operation || operation.state !== "handoff-pending") {
    throw new Error("This replacement handoff is not ready to send.");
  }
  let current = await updateUniformDelivery(record.submissionId, (item) => {
    if (item.relogHandoff?.nonce !== operation.nonce ||
        item.relogHandoff.state !== "handoff-pending") {
      throw new Error("This replacement handoff is already claimed or unresolved.");
    }
    item.relogHandoff.state = "handoff-claimed";
  });
  const channel = await requireUniformChannel(guild, current.uploadLogChannelId, current.command);
  try {
    const durableBytes = current.relogHandoff!.sourceDataBase64
      ? Buffer.from(current.relogHandoff!.sourceDataBase64, "base64")
      : undefined;
    const message = await channel.send({
      content: `<@&${uniformPublisherRoleId}>`,
      embeds: [relogPublishingEmbed(current)],
      components: relogPublishingComponents(current),
      files: [{
        attachment: attachmentBuffer ?? durableBytes ?? current.relogHandoff!.attachment.url,
        name: `${current.customerName}-${current.relogHandoff!.uniformType}-replacement.png`
          .replace(/[^a-z0-9_.-]+/gi, "-")
          .slice(0, 100),
      }],
      allowedMentions: { parse: [], roles: [uniformPublisherRoleId] },
      nonce: uniformDiscordNonce("relog", `${current.submissionId}:${operation.nonce}`),
      enforceNonce: true,
    });
    const handoffMessageId = sentMessageId(message);
    if (!handoffMessageId) throw new Error("Discord did not return a message ID for the replacement handoff.");
    current = await updateUniformDelivery(record.submissionId, (item) => {
      if (item.relogHandoff?.nonce !== operation.nonce || item.relogHandoff.state !== "handoff-claimed") {
        throw new Error("The replacement handoff changed before its message ID was recorded.");
      }
      item.relogHandoff.state = "awaiting-result";
      item.relogHandoff.handoffMessageId = handoffMessageId;
      delete item.relogHandoff.sourceDataBase64;
    });
    return current;
  } catch (error) {
    const failure = error instanceof UniformDiscordDeliveryError
      ? error
      : discordDeliveryFailure("relog handoff", error);
    await updateUniformDelivery(record.submissionId, (item) => {
      if (item.relogHandoff?.nonce === operation.nonce && item.relogHandoff.state === "handoff-claimed") {
        item.relogHandoff.state = failure.retryable ? "handoff-pending" : "unresolved";
      }
    }).catch(() => undefined);
    throw failure;
  }
}

async function relogPublishingRecordFor(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  submissionId: string,
  nonce: string,
): Promise<UniformDeliveryRecord> {
  const record = await getUniformDelivery(submissionId);
  if (!record || record.guildId !== interaction.guildId ||
      !record.relogHandoff || record.relogHandoff.nonce !== nonce) {
    throw new Error("This replacement publishing handoff is unavailable.");
  }
  if ("message" in interaction && interaction.message &&
      record.relogHandoff.handoffMessageId !== interaction.message.id) {
    throw new Error("This replacement control is not attached to its recorded handoff message.");
  }
  if (!await relogAuthorized(
    interaction.guild!,
    interaction.user.id,
    record,
    await getGuildSetup(interaction.guildId!),
  )) {
    const member = await currentMember(interaction.guild!, interaction.user.id);
    if (!memberHasRole(member, [uniformPublisherRoleId])) {
      throw new Error("You are no longer authorized to complete this replacement.");
    }
  }
  return record;
}

async function editRelogPublishingHandoff(
  record: UniformDeliveryRecord,
  guild: Guild,
  embed: EmbedBuilder,
): Promise<void> {
  const messageId = record.relogHandoff?.handoffMessageId;
  if (!messageId) return;
  const channel = await requireUniformChannel(guild, record.uploadLogChannelId, record.command);
  const message = await channel.messages?.fetch(messageId);
  if (!message) return;
  await message.edit({
    content: "",
    embeds: [embed],
    components: relogPublishingComponents(record, true),
    allowedMentions: noMentions,
  });
}

export async function handleUniformRelogPublishingButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const [, control, submissionId, nonce] = interaction.customId.split(":");
  const action = control === "relog-publish-success"
    ? "success"
    : control === "relog-publish-moderated"
      ? "moderated"
      : undefined;
  if (!action || !submissionId || !nonce) throw new Error("That replacement action is unavailable.");
  let record = await relogPublishingRecordFor(interaction, submissionId, nonce);
  if (record.relogHandoff!.state !== "awaiting-result") {
    throw new Error("This replacement handoff is already completed or being processed.");
  }
  if (action === "success") {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`uniform:relog-publish-modal:${submissionId}:${nonce}`)
        .setTitle("Complete Replacement Upload")
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("catalog_link")
            .setLabel("Replacement Roblox catalog link")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(500),
        )),
    );
    return;
  }
  await interaction.deferUpdate();
  const publisherName = await discordPublisherName(interaction);
  record = await updateUniformDelivery(submissionId, (item) => {
    if (item.relogHandoff?.nonce !== nonce || item.relogHandoff.state !== "awaiting-result") {
      throw new Error("This replacement handoff is no longer awaiting a result.");
    }
    item.relogHandoff.state = "moderation-claimed";
    item.relogHandoff.publisherName = publisherName;
  });
  try {
    const setup = await getGuildSetup(record.guildId);
    if (!setup) throw new Error("This server no longer has a valid bot setup.");
    const moderatedChannelId = uniformAccessSettings(setup, "moderated").moderatedChannelId;
    const channel = await requireUniformChannel(interaction.guild!, moderatedChannelId, "moderated");
    const sourceRow = record.rows[record.relogHandoff!.rowIndex] ?? [];
    const moderatedRows = [[
      typeof sourceRow[0] === "string" ? sourceRow[0] : "",
      publisherName,
      record.customerName,
      "",
    ]];
    await appendUniformRows({
      config: record.spreadsheet,
      logKind: "moderated",
      rows: moderatedRows,
      submissionId: `relog-moderated:${record.submissionId}:${nonce}`,
    });
    await channel.send({
      content: `<@${record.seqmId}>`,
      embeds: [presentationEmbed(
        "Replacement Upload Unsuccessful",
        "Roblox moderation denied the replacement. The original successful row and customer message remain unchanged.",
        "error",
        undefined,
        [
          { name: "Customer", value: safePresentationText(record.customerName), inline: true },
          { name: "Ticket", value: `<#${record.destinationChannelId}>`, inline: true },
        ],
      )],
      allowedMentions: { parse: [], users: [record.seqmId] },
      nonce: uniformDiscordNonce("moderated", `${record.submissionId}:${nonce}`),
      enforceNonce: true,
    });
    record = await updateUniformDelivery(submissionId, (item) => {
      if (item.relogHandoff?.nonce !== nonce ||
          item.relogHandoff.state !== "moderation-claimed") {
        throw new Error("The replacement moderation state changed before completion.");
      }
      item.relogHandoff.state = "moderated";
      item.relogHandoff.completedAt = new Date().toISOString();
    });
    await editRelogPublishingHandoff(record, interaction.guild!, presentationEmbed(
      "Replacement Rejected by Roblox",
      "The rejection was logged in the moderated worksheet. The original successful delivery remains active.",
      "error",
    )).catch(() => undefined);
    await interaction.editReply({
      embeds: [presentationEmbed("Replacement Rejection Recorded", "No customer message or successful spreadsheet row was changed.", "success")],
      components: relogPublishingComponents(record, true),
      allowedMentions: noMentions,
    });
  } catch (error) {
    const { status } = discordFailureDetails(error);
    const definitelyRejected = status === 400 || status === 403;
    await updateUniformDelivery(submissionId, (item) => {
      if (item.relogHandoff?.nonce === nonce &&
          item.relogHandoff.state === "moderation-claimed") {
        item.relogHandoff.state = definitelyRejected ? "awaiting-result" : "unresolved";
      }
    }).catch(() => undefined);
    throw error;
  }
}

export async function handleUniformRelogPublishingModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const [, control, submissionId, nonce] = interaction.customId.split(":");
  if (control !== "relog-publish-modal" || !submissionId || !nonce) {
    throw new Error("That replacement completion is unavailable.");
  }
  let record = await relogPublishingRecordFor(interaction, submissionId, nonce);
  if (record.relogHandoff!.state !== "awaiting-result") {
    throw new Error("This replacement handoff is already completed or being processed.");
  }
  const asset = parseUniformAssetInput(interaction.fields.getTextInputValue("catalog_link"));
  const published = await verifyPublishedClassicShirt(asset.id);
  if (published.name !== record.customerName) {
    throw new Error(`The replacement Classic Shirt must be named exactly "${record.customerName}".`);
  }
  await interaction.deferReply({ ephemeral: true });
  const publisherName = await discordPublisherName(interaction);
  const rowIndex = record.relogHandoff!.rowIndex;
  record = await updateUniformDelivery(submissionId, (item) => {
    if (item.relogHandoff?.nonce !== nonce || item.relogHandoff.state !== "awaiting-result") {
      throw new Error("This replacement handoff is no longer awaiting a result.");
    }
    item.relogHandoff.state = "publish-claimed";
    item.relogHandoff.publisherName = publisherName;
    item.relogHandoff.publishedAsset = asset;
  });
  try {
    record = await selectAndStartRelog(record, rowIndex, asset, interaction.guild!, publisherName);
    record = await updateUniformDelivery(submissionId, (item) => {
      if (item.relogHandoff?.nonce !== nonce) {
        throw new Error("The replacement handoff changed before completion.");
      }
      item.relogHandoff.state = "published";
      item.relogHandoff.completedAt = new Date().toISOString();
    });
    await editRelogPublishingHandoff(record, interaction.guild!, relogAuditEmbed(record)).catch(() => undefined);
    await interaction.editReply(relogSuccessPayload(record));
  } catch (error) {
    const latest = await getUniformDelivery(submissionId).catch(() => undefined);
    if (!latest?.relog) {
      await updateUniformDelivery(submissionId, (item) => {
        if (item.relogHandoff?.nonce === nonce &&
            item.relogHandoff.state === "publish-claimed") {
          item.relogHandoff.state = "awaiting-result";
        }
      }).catch(() => undefined);
    }
    throw new UniformDeliveryRecoveryError(
      submissionId,
      error instanceof Error ? error.message : "The replacement delivery could not be completed.",
      retryControlFor(latest),
    );
  }
}

export async function handleUniformRelogCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const selected = interaction.options.getChannel("channel", true);
  await requireUniformChannel(interaction.guild!, selected.id, "log");
  const legacyLink = optionString(interaction, "newlink");
  const newAsset = legacyLink ? parseUniformAssetInput(legacyLink) : undefined;
  const replacement = legacyLink ? undefined : await validatedClassicShirtAttachment(interaction);
  const records = await findUniformDeliveriesForChannel(interaction.guildId!, selected.id);
  const setup = await getGuildSetup(interaction.guildId!);
  const authorized: UniformDeliveryRecord[] = [];
  for (const record of records) {
    if (await relogAuthorized(interaction.guild!, interaction.user.id, record, setup)) authorized.push(record);
  }
  const choices = authorized.flatMap((record) =>
    record.assets.map((_asset, rowIndex) => ({ submissionId: record.submissionId, rowIndex })),
  );
  if (!choices.length) {
    throw new Error("No authorized recorded customer delivery with trusted original metadata was found in that channel.");
  }
  if (choices.length > 25) {
    throw new Error("More than 25 recorded assets match this channel. No replacement was guessed; ask an Administrator to narrow the channel records.");
  }
  if (choices.length === 1) {
    const choice = choices[0]!;
    if (replacement) {
      const result = await startRelogPublishingHandoff(
        authorized.find((record) => record.submissionId === choice.submissionId)!,
        choice.rowIndex,
        interaction.user.id,
        replacement.attachment,
        replacement.buffer,
        interaction.guild!,
      );
      await interaction.editReply(relogHandoffStartedPayload(result));
      return;
    }
    try {
      const result = await selectAndStartRelog(
        authorized.find((record) => record.submissionId === choice.submissionId)!,
        choice.rowIndex, newAsset!, interaction.guild!,
      );
      await interaction.editReply(relogSuccessPayload(result));
    } catch (error) {
      const current = await getUniformDelivery(choice.submissionId).catch(() => undefined);
      if (!current?.relog) throw error;
      throw new UniformDeliveryRecoveryError(
        choice.submissionId,
        error instanceof Error ? error.message : "The replacement delivery could not be completed.",
        retryControlFor(current),
      );
    }
    return;
  }
  const nonce = randomBytes(16).toString("hex");
  const pending: PendingRelogConfirmation = {
    nonce, guildId: interaction.guildId!, actorId: interaction.user.id,
    channelId: selected.id,
    ...(newAsset ? { newAsset } : {}),
    ...(replacement
      ? { replacementAttachment: replacement.attachment, attachmentBuffer: replacement.buffer }
      : {}),
    choices, expiresAt: Date.now() + uniformConfirmationLifetimeMs,
  };
  pendingRelogConfirmations.set(nonce, pending);
  await interaction.editReply(relogSelectionPayload(pending, authorized));
}

export async function handleUniformRelogSelection(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const [, , nonce] = interaction.customId.split(":");
  if (!nonce) throw new Error("That relog selection is unavailable.");
  const pending = relogPending(nonce, interaction);
  const [submissionId, rowText] = interaction.values[0]?.split(":") ?? [];
  const rowIndex = Number(rowText);
  if (!submissionId || !Number.isInteger(rowIndex) ||
      !pending.choices.some((choice) => choice.submissionId === submissionId && choice.rowIndex === rowIndex)) {
    throw new Error("That relog selection is unavailable.");
  }
  const record = await getUniformDelivery(submissionId);
  if (!record || record.guildId !== pending.guildId || record.destinationChannelId !== pending.channelId ||
      !await relogAuthorized(interaction.guild!, interaction.user.id, record, await getGuildSetup(interaction.guildId!))) {
    throw new Error("This recorded delivery is no longer available for relog.");
  }
  pendingRelogConfirmations.delete(nonce);
  await interaction.deferUpdate();
  try {
    if (pending.replacementAttachment) {
      const result = await startRelogPublishingHandoff(
        record, rowIndex, interaction.user.id, pending.replacementAttachment,
        pending.attachmentBuffer, interaction.guild!,
      );
      await interaction.editReply(relogHandoffStartedPayload(result));
    } else {
      const result = await selectAndStartRelog(record, rowIndex, pending.newAsset!, interaction.guild!);
      await interaction.editReply(relogSuccessPayload(result));
    }
  } catch (error) {
    const current = await getUniformDelivery(submissionId).catch(() => undefined);
    if (!current?.relog) throw error;
    await interaction.editReply(uniformDeliveryRecoveryResponse(new UniformDeliveryRecoveryError(
      submissionId,
      error instanceof Error ? error.message : "The replacement delivery could not be completed.",
      retryControlFor(current),
    )));
  }
}

function uniformConfirmationComponents(nonce: string, command: UniformCommandName, ready: boolean) {
  const rows: Array<ActionRowBuilder<UserSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [
    new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder().setCustomId(`uniform:customer:${nonce}`).setPlaceholder("Select customer").setMinValues(1).setMaxValues(1),
    ),
  ];
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`uniform:submit:${nonce}`).setLabel("Submit").setStyle(ButtonStyle.Success).setDisabled(!ready),
      new ButtonBuilder().setCustomId(`uniform:cancel:${nonce}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    ),
  );
  return rows;
}

function pendingUniform(nonce: string, interaction: { user: { id: string }; guildId: string | null }): PendingUniformConfirmation {
  const pending = pendingUniformConfirmations.get(nonce);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingUniformConfirmations.delete(nonce);
    throw new Error("This private uniform confirmation has expired. Run the command again.");
  }
  if (pending.actorId !== interaction.user.id || pending.guildId !== interaction.guildId) {
    throw new Error("Only the person who started this uniform submission can use its confirmation controls.");
  }
  return pending;
}

function confirmationEmbed(pending: PendingUniformConfirmation): EmbedBuilder {
  return presentationEmbed(
    "Confirm Uniform Delivery",
    pending.command === "log"
      ? "Review the /created submission. Select the customer Discord account, then submit. No Google Sheets rows or Discord messages have been sent yet."
      : "Review the /moderated submission. Select the customer Discord account, then submit. No Google Sheets rows or Discord messages have been sent yet.",
    "info",
    undefined,
    [
      { name: "Customer", value: pending.customerId ? `<@${pending.customerId}>` : "Not selected", inline: true },
      { name: "Delivery channel", value: `<#${pending.destinationChannelId}>`, inline: true },
      { name: pending.command === "log" ? "Uniform type" : "Assets", value: pending.command === "log"
        ? (pending.submission.uniformTypes ?? [pending.submission.uniformType ?? "Unknown"])
          .map((type, index) => `Shirt ${index + 1}: ${safePresentationText(type)}`).join("\n")
        : pending.submission.assets.map((asset) => `[${asset.id}](${asset.url})`).join(", ") },
    ],
  );
}

export async function handleUniformUserSelection(interaction: UserSelectMenuInteraction): Promise<void> {
  const [, field, nonce] = interaction.customId.split(":");
  if ((field !== "customer" && field !== "seqm") || !nonce) throw new Error("That uniform selection is unavailable.");
  const pending = pendingUniform(nonce, interaction);
  const selected = interaction.values[0];
  if (!selected) throw new Error("Select exactly one Discord user.");
  if (field === "customer") pending.customerId = selected;
  else pending.seqmId = selected;
  await interaction.update({
    embeds: [confirmationEmbed(pending)],
    components: uniformConfirmationComponents(
      nonce, pending.command, Boolean(pending.customerId),
    ),
    allowedMentions: noMentions,
  });
}

function customerDeliveryEmbed(record: UniformDeliveryRecord): EmbedBuilder {
  const moderatedCount = record.publishing?.moderatedIndices?.length ?? 0;
  const deliveredCount = record.assets.length;
  return presentationEmbed(
    deliveredCount > 0 ? "Your Uniform Is Ready" : "Uniform Update",
    deliveredCount > 0
      ? `Your ${deliveredCount} completed shirt${deliveredCount === 1 ? "" : "s"} ${deliveredCount === 1 ? "is" : "are"} ready for collection.` +
        (moderatedCount > 0 ? ` ${moderatedCount} shirt${moderatedCount === 1 ? "" : "s"} were moderated and will be sent at a later date.` : "")
      : `${moderatedCount} shirt${moderatedCount === 1 ? "" : "s"} were moderated and will be sent at a later date.`,
    "success",
    undefined,
    [
      { name: "Customer", value: safePresentationText(record.customerName), inline: true },
      { name: "Uniform links", value: record.assets.map((asset, index) => `[Uniform ${index + 1}](${asset.url})`).join("\n") },
    ],
  );
}

/**
 * Audit text is reconstructed only from frozen sheet rows.  This keeps a
 * relog and a purchase tied to the original Roblox credits rather than to
 * mutable Discord display names or later command values.
 */
function auditCredits(record: UniformDeliveryRecord): Array<{ name: string; value: string; inline?: boolean }> {
  const row = record.rows[0] ?? [];
  const text = (value: unknown) => safePresentationText(typeof value === "string" && value ? value : "Not available");
  return record.command === "log"
    ? [
        { name: "Senior Quartermaster", value: text(row[1]), inline: true },
        { name: "Publisher", value: text(row[2]), inline: true },
        { name: "Quartermaster", value: text(row[0]), inline: true },
      ]
    : [
        { name: "Uploaded by", value: text(row[0]), inline: true },
        { name: "Published by", value: text(row[1]), inline: true },
      ];
}

function auditTicketAndCustomer(record: UniformDeliveryRecord) {
  const row = record.rows[0] ?? [];
  const customerIndex = record.command === "log" ? 3 : 2;
  return [
    { name: "Ticket Channel", value: safePresentationText(record.ticketChannelName ?? "Ticket name unavailable"), inline: true },
    { name: "Requested by", value: safePresentationText(typeof row[customerIndex] === "string" && row[customerIndex] ? row[customerIndex] : record.customerName), inline: true },
  ];
}

function uniformLinks(record: UniformDeliveryRecord): string {
  return record.assets
    .map((asset, index) => `[Uniform ${index + 1}](${asset.url})`)
    .join("\n");
}

function uploadAuditEmbed(record: UniformDeliveryRecord, title = "Uniform Upload Logged"): EmbedBuilder {
  return presentationEmbed(
    title,
    "A uniform upload was recorded for this ticket.",
    "success",
    undefined,
    [
      ...auditTicketAndCustomer(record),
      ...auditCredits(record),
      { name: "Uniform Links", value: uniformLinks(record) },
    ],
  );
}

function relogAuditEmbed(record: UniformDeliveryRecord): EmbedBuilder {
  const operation = record.relog!;
  return presentationEmbed(
    "Uniform Updated",
    "A recorded uniform link was replaced.",
    "success",
    undefined,
    [
      ...auditTicketAndCustomer(record),
      ...auditCredits(record),
      { name: "Changed Uniform Link", value: `[Uniform ${operation.rowIndex + 1}](${operation.newAsset.url})` },
    ],
  );
}

function purchaseConfirmationEmbed(record: UniformDeliveryRecord): EmbedBuilder {
  const row = record.rows[0] ?? [];
  const text = (value: unknown) => safePresentationText(typeof value === "string" && value ? value : "Not available");
  const fields = record.command === "log"
    ? [
        { name: "Made by", value: text(row[0]), inline: true },
        { name: "Uploaded by", value: text(row[1]), inline: true },
        { name: "Published by", value: text(row[2]), inline: true },
      ]
    : [
        { name: "Uploaded by", value: text(row[0]), inline: true },
        { name: "Published by", value: text(row[1]), inline: true },
      ];
  const footerName = record.command === "log" && typeof row[0] === "string" && row[0]
    ? row[0]
    : typeof row[record.command === "log" ? 2 : 1] === "string" && row[record.command === "log" ? 2 : 1]
      ? row[record.command === "log" ? 2 : 1]
      : "The publisher";
  return presentationEmbed(
    "Purchase Confirmed",
    "Thank you for your purchase. Your ticket will be closed shortly.",
    "success",
    undefined,
    fields,
  ).setFooter({ text: purchaseFooter(footerName) });
}

function customerDeliveryButtons(record: UniformDeliveryRecord, disabled = false) {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`uniform:purchase:${record.submissionId}`).setLabel("Purchased").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`uniform:assist:${record.submissionId}`).setLabel("Request Assistance").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  )];
}

function ownershipRetryComponents(record: UniformDeliveryRecord) {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`uniform:purchase:${record.submissionId}`)
      .setLabel("Retry Ownership Check")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`uniform:assist:${record.submissionId}`)
      .setLabel("Request Assistance")
      .setStyle(ButtonStyle.Secondary),
  )];
}

function ownershipFailureResponse(
  record: UniformDeliveryRecord,
  error: unknown,
  missingAssets: Array<{ id: number; url: string }> = [],
) {
  if (error instanceof RobloxInventoryPrivateError) {
    return {
      embeds: [presentationEmbed(
        "Inventory Is Private",
        "Roblox cannot verify this purchase while the customer's inventory is private. Make the inventory visible, then retry the ownership check.",
        "warning",
      )],
      components: ownershipRetryComponents(record),
      allowedMentions: noMentions,
    };
  }
  if (missingAssets.length > 0) {
    return {
      embeds: [presentationEmbed(
        "Purchase Not Verified",
        `Roblox reports that the customer does not own ${missingAssets.length === 1 ? "this uniform" : "these uniforms"}. The purchase remains pending.`,
        "warning",
        undefined,
        missingAssets.map((asset, index) => ({
          name: `Uniform ${index + 1}`,
          value: asset.url,
        })),
      )],
      components: ownershipRetryComponents(record),
      allowedMentions: noMentions,
    };
  }
  return {
    embeds: [presentationEmbed(
      "Roblox Check Unavailable",
      error instanceof RobloxOwnershipUnavailableError
        ? "Roblox did not respond after three automatic attempts. Wait a moment, then retry the ownership check."
        : "The ownership check could not be completed. Wait a moment, then retry.",
      "warning",
    )],
    components: ownershipRetryComponents(record),
    allowedMentions: noMentions,
  };
}
function deliveryRetryComponents(record: Pick<UniformDeliveryRecord, "submissionId"> | string, disabled = false) {
  const submissionId = typeof record === "string" ? record : record.submissionId;
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`uniform:retry:${submissionId}`).setLabel("Retry Delivery").setStyle(ButtonStyle.Primary).setDisabled(disabled),
  )];
}

function hasRetryableDelivery(record: UniformDeliveryRecord | undefined): boolean {
  return Boolean(
    record &&
    record.sheetState === "saved" &&
    (!record.publishing || record.publishing.state === "published") &&
    (record.logNoticeState === "pending" || record.customerDeliveryState === "pending") &&
    record.logNoticeState !== "unresolved" &&
    record.customerDeliveryState !== "unresolved",
  );
}

/**
 * Sheet writes use a durable reservation keyed by submission ID, so a
 * prepared record may safely re-check an uncertain write. Once either
 * Discord operation is unresolved, however, no automatic replay is safe.
 */
function canRetryDelivery(record: UniformDeliveryRecord | undefined): boolean {
  if (record?.relogHandoff) {
    if (record.relogHandoff.state === "handoff-pending") return true;
    if (record.relogHandoff.state === "publish-claimed") {
      return Boolean(
        record.relogHandoff.publishedAsset &&
        (!record.relog ||
          record.relog.state === "claimed" ||
          record.relog.state === "sheet-updated" ||
          record.relog.state === "pending" ||
          (record.relog.state === "sent" && record.relog.auditState === "pending")),
      );
    }
    if (record.relogHandoff.state !== "published") return false;
  }
  if (record?.relog) {
    return record.relog.state === "claimed" ||
      record.relog.state === "sheet-updated" ||
      record.relog.state === "pending" ||
      (record.relog.state === "sent" && record.relog.auditState === "pending");
  }
  if (record?.publishing) {
    if (record.publishing.state === "handoff-pending" ||
        record.publishing.state === "publish-claimed") return true;
    if (record.publishing.state !== "published") return false;
  }
  return Boolean(
    record &&
    (record.sheetState === "prepared" || record.sheetState === "saved") &&
    record.logNoticeState !== "unresolved" &&
    record.customerDeliveryState !== "unresolved",
  );
}

function retryControlFor(record: UniformDeliveryRecord | undefined): UniformDeliveryRetryControl {
  if (!record) return "none";
  return canRetryDelivery(record) ? "enabled" : "disabled";
}

function recoveryPayload(
  submissionId: string,
  title: string,
  description: string,
  tone: "info" | "success" | "warning" | "error",
  retryControl: UniformDeliveryRetryControl,
) {
  const manualVerification = retryControl === "disabled"
    ? " Retry Delivery is disabled; manual verification is required before it can be enabled. No duplicate message will be sent."
    : "";
  return {
    content: "",
    embeds: [presentationEmbed(
      title,
      `${description}${manualVerification}`,
      tone,
      undefined,
      [{ name: "Submission ID", value: displayId(submissionId), inline: true }],
    )],
    components: retryControl === "none"
      ? []
      : deliveryRetryComponents(submissionId, retryControl === "disabled"),
    allowedMentions: noMentions,
  };
}

export function uniformDeliveryRecoveryResponse(error: UniformDeliveryRecoveryError) {
  return recoveryPayload(
    error.submissionId,
    "Uniform Delivery Recovery Error",
    error.message,
    "warning",
    error.retryControl,
  );
}

function sentMessageId(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  return typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : "";
}

function publishingHandoffEmbed(record: UniformDeliveryRecord): EmbedBuilder {
  const publishing = record.publishing!;
  const reviewing = publishing.stage !== "publisher";
  const approvedAssets = publishing.approvedAssets ??
    (publishing.approvedAsset ? [publishing.approvedAsset] : []);
  const approvedIndices = publishing.approvedAssetIndices ??
    approvedAssets.map((_asset, index) => index);
  const publisherIndices = new Set(publishing.publisherAssetIndices ?? approvedIndices);
  const publisherLinks = approvedAssets
    .map((asset, index) => ({ asset, originalIndex: approvedIndices[index] ?? index }))
    .filter(({ originalIndex }) => publisherIndices.has(originalIndex));
  return presentationEmbed(
    reviewing ? "Classic Shirt Awaiting Senior Quartermaster Review" : "Classic Shirt Awaiting Roblox Publishing",
    reviewing
      ? "Review the attached PNG, upload it through Roblox Creator Dashboard as a group Classic Shirt, then enter the uploaded asset link. If Roblox rejects it, record the moderation denial instead."
      : "Publish the approved Classic Shirt by placing this exact asset on sale, then enter the same Roblox link. If Roblox rejects it, record the moderation denial instead.",
    "info",
    undefined,
    [
      { name: "Roblox item name", value: safePresentationText(record.customerName), inline: true },
      { name: "Roblox descriptions", value: (publishing.uniformTypes ?? [publishing.uniformType])
        .map((type, index) => `Shirt ${index + 1}: ${safePresentationText(type)}`).join("\n"), inline: false },
      { name: reviewing ? "Senior Quartermaster" : "Publisher", value: "*Pending*", inline: true },
      ...(publisherLinks.length > 0
        ? [{ name: reviewing ? "Approved assets" : "SEQM-approved links to publish", value: publisherLinks
          .map(({ asset, originalIndex }) => `Shirt ${originalIndex + 1}: [${asset.id}](${asset.url})`)
          .join("\n"), inline: false }]
        : []),
      { name: "Customer ticket", value: `<#${record.destinationChannelId}>`, inline: true },
      ...(reviewing ? [{ name: "PNGs", value: (publishing.attachments ?? [publishing.attachment])
        .map((attachment, index) => `Shirt ${index + 1}: ${safePresentationText(attachment.name)}`).join("\n"), inline: false }] : []),
      ...((publishing.moderatedIndices?.length ?? 0) > 0
        ? [{ name: "Moderated shirts", value: publishing.moderatedIndices!.map((index) => `Shirt ${index + 1}`).join(", "), inline: false }]
        : []),
    ],
  );
}

function publishingHandoffComponents(record: UniformDeliveryRecord, disabled = false) {
  const reviewing = record.publishing?.stage !== "publisher";
  const originalIndices = reviewing
    ? Array.from({ length: record.publishing?.attachments?.length ?? 1 }, (_value, index) => index)
    : record.publishing?.publisherAssetIndices ??
      record.publishing?.approvedAssetIndices ??
      Array.from({ length: record.publishing?.approvedAssets?.length ?? 1 }, (_value, index) => index);
  const count = originalIndices.length;
  const rows: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> = [];
  if (count > 1) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`uniform:publish-moderated-select:${record.submissionId}`)
        .setPlaceholder("Select shirts denied by Roblox")
        .setMinValues(0)
        .setMaxValues(count)
        .setDisabled(disabled)
        .addOptions(originalIndices.map((originalIndex) => ({
          label: `Shirt ${originalIndex + 1}`,
          value: String(originalIndex),
          description: "Mark this shirt as moderated",
        }))),
    ));
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`uniform:publish-success:${record.submissionId}`)
      .setLabel(reviewing ? "Upload" : "Complete Publishing")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`uniform:publish-moderated:${record.submissionId}`)
      .setLabel("Roblox Moderation Denied")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  ));
  return rows;
}

async function sendPublishingHandoff(
  record: UniformDeliveryRecord,
  guild: Guild,
  attachmentBuffer?: Buffer,
  attachmentBuffers?: Buffer[],
): Promise<UniformDeliveryRecord> {
  const publishing = record.publishing;
  if (!publishing) throw new Error("This uniform has no publishing handoff.");
  if (publishing.state === "awaiting-result") return record;
  if (publishing.state !== "handoff-pending") {
    throw new Error("The publishing handoff outcome is unresolved and will not be sent again automatically.");
  }
  const channelId = publishing.stage === "publisher"
    ? publishing.publisherChannelId
    : record.uploadLogChannelId;
  const channel = await requireUniformChannel(guild, channelId, "log");
  let current = await updateUniformDelivery(record.submissionId, (item) => {
    if (item.publishing?.state !== "handoff-pending") {
      throw new Error("This publishing handoff is already claimed.");
    }
    item.publishing.state = "handoff-claimed";
  });
  try {
    const sources: Array<Buffer | string> = attachmentBuffers ??
      (publishing.sourceDataBase64s
        ? publishing.sourceDataBase64s.map((value) => Buffer.from(value, "base64"))
        : [attachmentBuffer ??
      (publishing.sourceDataBase64
        ? Buffer.from(publishing.sourceDataBase64, "base64")
        : publishing.attachment.url)]);
    const handoffPayload = {
      content: publishing.stage === "publisher"
        ? `<@&${uniformPublisherRoleId}>`
        : `<@&${publishing.seqmRoleId}>`,
      embeds: [publishingHandoffEmbed(current)],
      components: publishingHandoffComponents(current),
      ...(publishing.stage === "publisher" ? {} : { files: sources.map((source, index) => ({
        attachment: source,
        name: `${record.customerName}-${publishing.uniformTypes?.[index] ?? publishing.uniformType}-${index + 1}.png`
          .replace(/[^a-z0-9_.-]+/gi, "-")
          .slice(0, 100),
      })) }),
      allowedMentions: {
        parse: [],
        roles: [publishing.stage === "publisher" ? uniformPublisherRoleId : publishing.seqmRoleId!],
      },
      nonce: uniformDiscordNonce(
        "notice",
        `${record.submissionId}:${publishing.stage === "publisher" ? "publisher" : "seqm"}`,
      ),
      enforceNonce: true,
    };
    let message: unknown;
    try {
      message = await channel.send(handoffPayload);
    } catch (error) {
      const { code } = discordFailureDetails(error);
      if (code !== 10008) throw error;
      const { nonce: _nonce, enforceNonce: _enforceNonce, ...freshHandoffPayload } = handoffPayload;
      logger.warn(
        { stage: "publishing handoff", discordCode: code, publishingStage: publishing.stage },
        "Recreating a Discord publishing handoff without its stale nonce",
      );
      message = await channel.send(freshHandoffPayload);
    }
    const handoffMessageId = sentMessageId(message);
    if (!handoffMessageId) throw new Error("Discord did not return a message ID for the publishing handoff.");
    current = await updateUniformDelivery(record.submissionId, (item) => {
      if (item.publishing?.state !== "handoff-claimed") {
        throw new Error("The publishing handoff state changed before its message ID was recorded.");
      }
      item.publishing.state = "awaiting-result";
      item.publishing.handoffMessageId = handoffMessageId;
      delete item.publishing.sourceDataBase64;
      delete item.publishing.sourceDataBase64s;
      item.auditMessageId = handoffMessageId;
      item.logNoticeState = "sent";
    });
    return current;
  } catch (error) {
    const failure = error instanceof UniformDiscordDeliveryError
      ? error
      : discordDeliveryFailure("upload-log notice", error);
    await updateUniformDelivery(record.submissionId, (item) => {
      if (item.publishing?.state === "handoff-claimed") {
        item.publishing.state = failure.retryable ? "handoff-pending" : "unresolved";
      }
    }).catch(() => undefined);
    throw failure;
  }
}

async function publishingRecordFor(
  interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  submissionId: string,
): Promise<UniformDeliveryRecord> {
  const record = await getUniformDelivery(submissionId);
  if (!record || record.guildId !== interaction.guildId || !record.publishing) {
    throw new Error("This publishing handoff is unavailable.");
  }
  if ("message" in interaction && interaction.message &&
      record.publishing.handoffMessageId !== interaction.message.id) {
    throw new Error("This publishing control is not attached to its recorded handoff message.");
  }
  const member = await currentMember(interaction.guild!, interaction.user.id);
  const requiredRole = record.publishing.stage === "publisher"
    ? uniformPublisherRoleId
    : record.publishing.seqmRoleId;
  if (requiredRole && memberHasRole(member, [requiredRole])) return record;
  if (interaction.guild!.ownerId === member.id ||
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      (record.publishing.stage === "publisher" && interaction.user.id === record.seqmId)) {
    return record;
  }
  // Legacy one-stage records had no approvedAsset marker and allowed the
  // original submitter to recover the publishing handoff.
  if (record.publishing.stage === "publisher" &&
      !record.publishing.approvedAsset &&
      interaction.user.id === record.actorId) {
    return record;
  }
  throw new Error(record.publishing.stage === "publisher"
    ? "Only the publishing role or an Administrator can complete this publishing step."
    : "Only the Senior Quartermaster role or an Administrator can complete this review.");
}

async function editPublishingHandoff(
  record: UniformDeliveryRecord,
  guild: Guild,
  embed: EmbedBuilder,
): Promise<void> {
  const messageId = record.publishing?.handoffMessageId;
  if (!messageId) return;
  const channel = await requireUniformChannel(
    guild,
    record.publishing?.stage === "publisher"
      ? record.publishing.publisherChannelId
      : record.uploadLogChannelId,
    "log",
  );
  const message = await channel.messages?.fetch(messageId);
  if (!message) return;
  await message.edit({
    content: "",
    embeds: [embed],
    components: [],
    allowedMentions: noMentions,
  });
}

export async function handleUniformPublishingButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const [, control, submissionId] = interaction.customId.split(":");
  const action = control === "publish-success"
    ? "success"
    : control === "publish-moderated"
      ? "moderated"
      : undefined;
  if (!submissionId || !action) {
    throw new Error("That publishing action is unavailable.");
  }
  let record = await publishingRecordFor(interaction, submissionId);
  if (record.publishing!.state !== "awaiting-result") {
    throw new Error("This publishing handoff has already been completed or is being processed.");
  }
  if (action === "success") {
    const shirtCount = record.publishing!.attachments?.length ?? 1;
    const moderated = new Set(record.publishing!.moderatedIndices ?? []);
    const successful = Array.from({ length: shirtCount }, (_value, index) => index)
      .filter((index) => !moderated.has(index));
    if (successful.length === 0) {
      throw new Error("All shirts are selected as moderated. Use the Roblox Moderation Denied action to complete this result.");
    }
    const inputs = shirtCount === 1
      ? [new TextInputBuilder().setCustomId("catalog_link").setLabel("Published Roblox catalog link").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500)]
      : successful.map((index) => new TextInputBuilder()
        .setCustomId(`catalog_link_${index}`)
        .setLabel(`Shirt ${index + 1} catalog link`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(500));
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`uniform:publish-modal:${submissionId}`)
        .setTitle("Complete Classic Shirt Upload")
        .addComponents(...inputs.map((input) => new ActionRowBuilder<TextInputBuilder>().addComponents(input))),
    );
    return;
  }
  const shirtCount = record.publishing!.attachments?.length ?? 1;
  if (shirtCount > 1) {
    await interaction.deferUpdate();
    const actorName = await discordPublisherName(interaction);
    record = await updateUniformDelivery(submissionId, (item) => {
      if (!item.publishing || item.publishing.state !== "awaiting-result") {
        throw new Error("This publishing handoff is no longer awaiting a result.");
      }
      item.publishing.moderatedIndices = Array.from({ length: shirtCount }, (_value, index) => index);
      item.publishing.seqmName ??= actorName;
      item.rows.forEach((row) => {
        if (row.length === LOG_UNIFORM_COLUMN_COUNT) row[1] = item.publishing!.seqmName!;
      });
    });
    const delivered = await completePublishedUniform(
      record,
      interaction.guild!,
      undefined,
      actorName,
      [],
    );
    await interaction.editReply({
      embeds: [presentationEmbed(
        "Moderation Denials Recorded",
        `All ${shirtCount} shirts were logged as moderated. The customer was notified that they will be sent later in <#${delivered.destinationChannelId}>.`,
        "success",
      )],
      components: [],
      allowedMentions: noMentions,
    });
    return;
  }
  await interaction.deferUpdate();
  const reviewing = record.publishing!.stage !== "publisher";
  const actorName = await discordPublisherName(interaction);
  const publisherName = reviewing ? "" : actorName;
  let current = await updateUniformDelivery(submissionId, (item) => {
    if (item.publishing?.state !== "awaiting-result") {
      throw new Error("This publishing handoff is no longer awaiting a result.");
    }
    item.publishing.state = "moderation-claimed";
    item.publishing.publisherName = publisherName;
    const row = item.rows[0];
    if (row && !reviewing) row[2] = publisherName;
  });
  try {
    const setup = await getGuildSetup(record.guildId);
    if (!setup) throw new Error("This server no longer has a valid bot setup.");
    const settings = uniformAccessSettings(setup, "moderated");
    const moderatedChannelId = settings.moderatedChannelId;
    const moderatedChannel = await requireUniformChannel(interaction.guild!, moderatedChannelId, "moderated");
    const original = current.rows[0] ?? [];
    const moderatedRows = [[
      typeof original[0] === "string" ? original[0] : "",
      publisherName,
      current.customerName,
      reviewing ? "" : current.publishing!.approvedAsset?.url ?? "",
    ]];
    await appendUniformRows({
      config: current.spreadsheet,
      logKind: "moderated",
      rows: moderatedRows,
      submissionId: current.submissionId,
    });
    current = await updateUniformDelivery(submissionId, (item) => {
      if (!item.publishing || item.publishing.state !== "moderation-claimed") {
        throw new Error("The moderated upload state changed before its sheet result was recorded.");
      }
      item.rows = moderatedRows;
      item.sheetState = "saved";
    });
    await moderatedChannel.send({
      content: reviewing ? "" : `<@${current.seqmId}>`,
      embeds: [presentationEmbed(
        "Uniform Upload Unsuccessful",
        "Roblox moderation denied this Classic Shirt. It was logged in the moderated worksheet and nothing was sent to the customer.",
        "error",
        undefined,
        [
          { name: "Customer", value: safePresentationText(current.customerName), inline: true },
          { name: "Uniform type", value: safePresentationText(current.publishing!.uniformType), inline: true },
          { name: "Ticket", value: `<#${current.destinationChannelId}>`, inline: true },
        ],
      )],
      allowedMentions: reviewing ? noMentions : { parse: [], users: [current.seqmId] },
      nonce: uniformDiscordNonce("moderated", current.submissionId),
      enforceNonce: true,
    });
    current = await updateUniformDelivery(submissionId, (item) => {
      if (!item.publishing || item.publishing.state !== "moderation-claimed") {
        throw new Error("The moderated upload state changed before completion.");
      }
      item.customerDeliveryState = "sent";
      item.publishing.state = "moderated";
      item.publishing.completedAt = new Date().toISOString();
    });
    await editPublishingHandoff(record, interaction.guild!, presentationEmbed(
      "Roblox Moderation Denied",
      "This upload was logged in the moderated worksheet. No customer message was sent.",
      "error",
      undefined,
       [{ name: reviewing ? "Senior Quartermaster" : "Publisher", value: safePresentationText(actorName), inline: true }],
    )).catch(() => undefined);
    await interaction.editReply({
      embeds: [presentationEmbed(
        "Moderation Denial Recorded",
        reviewing
          ? "The moderated worksheet was updated. No publisher or customer message was sent."
          : "The moderated worksheet was updated and the Senior Quartermaster was notified.",
        "success",
      )],
      components: [],
      allowedMentions: noMentions,
    });
  } catch (error) {
    const current = await getUniformDelivery(submissionId).catch(() => undefined);
    const failure = error instanceof UniformDiscordDeliveryError
      ? error
      : current?.sheetState === "saved"
        ? discordDeliveryFailure("upload-log notice", error)
        : undefined;
    await updateUniformDelivery(submissionId, (item) => {
      if (item.publishing?.state === "moderation-claimed") {
        item.publishing.state = !failure || failure.retryable ? "awaiting-result" : "unresolved";
      }
    }).catch(() => undefined);
    throw failure ?? error;
  }
}

export async function handleUniformPublishingModerationSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const [, control, submissionId] = interaction.customId.split(":");
  if (control !== "publish-moderated-select" || !submissionId) {
    throw new Error("That moderation selection is unavailable.");
  }
  const record = await publishingRecordFor(interaction, submissionId);
  if (record.publishing!.state !== "awaiting-result") {
    throw new Error("This moderation selection is no longer available.");
  }
  const count = record.publishing!.attachments?.length ?? 1;
  const moderatedIndices = [...new Set(interaction.values.map(Number))]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < count)
    .sort((a, b) => a - b);
  await updateUniformDelivery(submissionId, (item) => {
    if (!item.publishing) throw new Error("This publishing handoff is unavailable.");
    item.publishing.moderatedIndices = moderatedIndices;
  });
  await interaction.update({
    embeds: [publishingHandoffEmbed({
      ...record,
      publishing: { ...record.publishing!, moderatedIndices },
    })],
    components: publishingHandoffComponents({
      ...record,
      publishing: { ...record.publishing!, moderatedIndices },
    }),
    allowedMentions: noMentions,
  });
}

async function forwardApprovedUniform(
  record: UniformDeliveryRecord,
  guild: Guild,
): Promise<UniformDeliveryRecord> {
  const asset = record.publishing?.approvedAsset;
  if (!record.publishing || !asset) throw new Error("The pending Roblox asset is unavailable.");
  await editPublishingHandoff(record, guild, presentationEmbed(
    "Classic Shirt Approved for Publishing",
    "Roblox finished processing this Classic Shirt and it passed validation. It was forwarded to the publisher channel.",
    "success",
    undefined,
    [
      { name: "Senior Quartermaster", value: safePresentationText(record.publishing.seqmName ?? "Unknown"), inline: true },
      { name: "Approved asset", value: `[${asset.id}](${asset.url})`, inline: true },
    ],
  )).catch(() => undefined);
  const transitioned = await updateUniformDelivery(record.submissionId, (item) => {
    if (!item.publishing ||
        (item.publishing.state !== "moderation-pending" &&
          item.publishing.state !== "awaiting-result")) {
      throw new Error("This Roblox moderation check is no longer pending.");
    }
    item.publishing.stage = "publisher";
    item.publishing.state = "handoff-pending";
    item.publishing.publisherName = "Pending";
    delete item.publishing.handoffMessageId;
  });
  return sendPublishingHandoff(transitioned, guild);
}

async function completeAutomaticRobloxModeration(
  record: UniformDeliveryRecord,
  guild: Guild,
): Promise<UniformDeliveryRecord> {
  let current = record;
  if (current.publishing?.state === "moderation-pending") {
    current = await updateUniformDelivery(record.submissionId, (item) => {
      if (item.publishing?.state !== "moderation-pending") {
        throw new Error("This Roblox moderation result is no longer pending.");
      }
      item.publishing.state = "moderation-claimed";
      item.publishing.moderationNoticeState = "pending";
    });
  }
  if (current.publishing?.state !== "moderation-claimed") return current;
  const original = current.rows[0] ?? [];
  const moderatedRows = [[
    typeof original[0] === "string" ? original[0] : "",
    "",
    current.customerName,
    "",
  ]];
  if (current.sheetState !== "saved") {
    await appendUniformRows({
      config: current.spreadsheet,
      logKind: "moderated",
      rows: moderatedRows,
      submissionId: current.submissionId,
    });
    current = await updateUniformDelivery(current.submissionId, (item) => {
      if (item.publishing?.state !== "moderation-claimed") {
        throw new Error("The automatic moderation state changed before its sheet result was recorded.");
      }
      item.rows = moderatedRows;
      item.sheetState = "saved";
    });
  }
  if (current.publishing!.moderationNoticeState !== "sent") {
    current = await updateUniformDelivery(current.submissionId, (item) => {
      if (!item.publishing || item.publishing.state !== "moderation-claimed") {
        throw new Error("The automatic moderation notice is no longer available.");
      }
      item.publishing.moderationNoticeState = "claimed";
    });
    try {
      const channel = await requireUniformChannel(
        guild,
        current.publishing!.moderatedChannelId,
        "moderated",
      );
      await channel.send({
        content: `<@${current.seqmId}>`,
        embeds: [presentationEmbed(
          "Classic Shirt Moderated",
          "Roblox moderation denied the Classic Shirt you approved. It was recorded in Moderated Logs and was not sent to publishers or the customer.",
          "error",
          undefined,
          [
            { name: "Customer", value: safePresentationText(current.customerName), inline: true },
            { name: "Uniform type", value: safePresentationText(current.publishing!.uniformType), inline: true },
            { name: "Asset", value: current.publishing!.approvedAsset!.url },
          ],
        )],
        allowedMentions: { parse: [], users: [current.seqmId] },
        nonce: uniformDiscordNonce("moderated", current.submissionId),
        enforceNonce: true,
      });
      current = await updateUniformDelivery(current.submissionId, (item) => {
        if (item.publishing?.state !== "moderation-claimed") {
          throw new Error("The automatic moderation state changed before its notice was recorded.");
        }
        item.publishing.moderationNoticeState = "sent";
      });
    } catch (error) {
      await updateUniformDelivery(current.submissionId, (item) => {
        if (item.publishing?.state === "moderation-claimed") {
          item.publishing.moderationNoticeState = "pending";
        }
      }).catch(() => undefined);
      throw error;
    }
  }
  await editPublishingHandoff(current, guild, presentationEmbed(
    "Roblox Moderation Denied",
    "Roblox denied this Classic Shirt. It was recorded in Moderated Logs and the Senior Quartermaster was notified.",
    "error",
    undefined,
    [{ name: "Asset", value: current.publishing!.approvedAsset!.url }],
  )).catch(() => undefined);
  return updateUniformDelivery(current.submissionId, (item) => {
    if (item.publishing?.state !== "moderation-claimed" ||
        item.publishing.moderationNoticeState !== "sent") {
      throw new Error("The automatic moderation result is incomplete.");
    }
    item.customerDeliveryState = "sent";
    item.publishing.state = "moderated";
    item.publishing.completedAt = new Date().toISOString();
  });
}

export async function recoverPendingUniformReviews(guild: Guild): Promise<void> {
  const records = await findPendingUniformModerationChecks();
  for (const record of records) {
    if (record.guildId !== guild.id) continue;
    try {
      if (record.publishing?.state === "moderation-claimed") {
        await completeAutomaticRobloxModeration(record, guild);
        continue;
      }
      await forwardApprovedUniform(record, guild);
    } catch (error) {
      logger.error(
        { submissionId: record.submissionId, errorName: error instanceof Error ? error.name : "Unknown" },
        "Pending uniform review recovery failed",
      );
    }
  }
}

async function completePublishedUniform(
  record: UniformDeliveryRecord,
  guild: Guild,
  asset: { id: number; url: string } | undefined,
  publisherName: string,
  completedAssets?: Array<{ id: number; url: string }>,
): Promise<UniformDeliveryRecord> {
  const assets = completedAssets ?? (asset ? [asset] : []);
  const moderatedIndices = new Set(record.publishing?.moderatedIndices ?? []);
  const successfulIndices = record.rows
    .map((_row, index) => index)
    .filter((index) => !moderatedIndices.has(index));
  record = await updateUniformDelivery(record.submissionId, (item) => {
    if (item.publishing?.state !== "awaiting-result") {
      throw new Error("This publishing handoff is no longer awaiting a result.");
    }
    item.publishing.state = "publish-claimed";
    item.publishing.publisherName = publisherName;
    item.assets = assets;
    item.publishing!.approvedAssets = assets;
    item.rows.forEach((row, index) => {
      if (!row || row.length !== LOG_UNIFORM_COLUMN_COUNT) throw new Error("The pending uniform spreadsheet row is incomplete.");
      if (!moderatedIndices.has(index)) {
        const assetPosition = successfulIndices.indexOf(index);
        const completed = assets[assetPosition];
        if (!completed) throw new Error(`The published link for Shirt ${index + 1} is missing.`);
        row[row.length - 1] = completed.url;
        row[2] = publisherName;
      }
    });
  });
  try {
    const successfulRows = record.rows.filter((_row, index) => !moderatedIndices.has(index));
    const moderatedRows = record.rows.filter((_row, index) => moderatedIndices.has(index))
      .map((row) => [row[0] ?? "", publisherName, row[3] ?? record.customerName, ""]);
    if (successfulRows.length > 0) {
      await appendUniformRows({
        config: record.spreadsheet,
        logKind: "log",
        rows: successfulRows,
        submissionId: `${record.submissionId}:published`,
      });
    }
    if (moderatedRows.length > 0) {
      await appendUniformRows({
        config: record.spreadsheet,
        logKind: "moderated",
        rows: moderatedRows,
        submissionId: `${record.submissionId}:moderated`,
      });
    }
    record = await updateUniformDelivery(record.submissionId, (item) => {
      if (!item.publishing || item.publishing.state !== "publish-claimed") {
        throw new Error("The published upload state changed before completion.");
      }
      item.sheetState = "saved";
      item.logNoticeState = "sent";
      item.publishing.state = "published";
      item.publishing.completedAt = new Date().toISOString();
    });
    await editPublishingHandoff(record, guild, uploadAuditEmbed(record)).catch(() => undefined);
    return sendPendingDelivery(record, guild);
  } catch (error) {
    const latest = await getUniformDelivery(record.submissionId).catch(() => undefined);
    if (latest?.sheetState !== "saved") {
      await updateUniformDelivery(record.submissionId, (item) => {
        if (item.publishing?.state === "publish-claimed") item.publishing.state = "awaiting-result";
      }).catch(() => undefined);
    }
    throw new UniformDeliveryRecoveryError(
      record.submissionId,
      error instanceof Error ? error.message : "The published uniform could not be completed.",
      retryControlFor(latest),
    );
  }
}

export async function handleUniformPublishingModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const [, control, submissionId] = interaction.customId.split(":");
  if (control !== "publish-modal") throw new Error("That publishing completion is unavailable.");
  if (!submissionId) throw new Error("That publishing completion is unavailable.");
  let record = await publishingRecordFor(interaction, submissionId);
  if (record.publishing!.state !== "awaiting-result") {
    throw new Error("This publishing handoff has already been completed or is being processed.");
  }
  const shirtCount = record.publishing!.attachments?.length ?? 1;
  const moderated = new Set(record.publishing!.moderatedIndices ?? []);
  const successfulIndices = Array.from({ length: shirtCount }, (_value, index) => index)
    .filter((index) => !moderated.has(index));
  const submittedAssets = successfulIndices.map((index) => parseUniformAssetInput(
    interaction.fields.getTextInputValue(shirtCount === 1 ? "catalog_link" : `catalog_link_${index}`),
  ));
  const asset = submittedAssets[0]!;
  await interaction.deferReply({ ephemeral: true });
  if (record.publishing!.stage !== "publisher") {
    const seqmName = await discordPublisherName(interaction);
    record = await updateUniformDelivery(submissionId, (item) => {
      if (!item.publishing || item.publishing.state !== "awaiting-result") {
        throw new Error("This Senior Quartermaster review is no longer awaiting a result.");
      }
      const row = item.rows[0];
      if (!row || row.length !== LOG_UNIFORM_COLUMN_COUNT) throw new Error("The pending uniform row is incomplete.");
      item.seqmId = interaction.user.id;
      item.assets = submittedAssets;
      successfulIndices.forEach((originalIndex, assetIndex) => {
        const successfulRow = item.rows[originalIndex];
        const successfulAsset = submittedAssets[assetIndex];
        if (!successfulRow || successfulRow.length !== LOG_UNIFORM_COLUMN_COUNT || !successfulAsset) {
          throw new Error(`The pending row for Shirt ${originalIndex + 1} is incomplete.`);
        }
        successfulRow[1] = seqmName;
        successfulRow[successfulRow.length - 1] = successfulAsset.url;
      });
      item.publishing.seqmName = seqmName;
      item.publishing.approvedAsset = asset;
      item.publishing.approvedAssets = submittedAssets;
      item.publishing.approvedAssetIndices = successfulIndices;
    });
    const verified = await Promise.all(submittedAssets.map(async (candidate) => {
      try {
        await verifyPublishedClassicShirt(candidate.id);
        return true;
      } catch {
        return false;
      }
    }));
    if (verified.every(Boolean)) {
      const delivered = await completePublishedUniform(
        record,
        interaction.guild!,
        asset,
        seqmName,
        submittedAssets,
      );
      await interaction.editReply({
        embeds: [presentationEmbed(
          "Uniform Already Published and Delivered",
          `The shirt was already on sale, so it bypassed publishers and was delivered to <#${delivered.destinationChannelId}>.`,
          "success",
          undefined,
          [
            { name: "Publisher", value: safePresentationText(seqmName), inline: true },
            { name: "Catalog link", value: asset.url },
          ],
        )],
        components: [],
        allowedMentions: noMentions,
      });
      return;
    }
    const forwarded = await forwardApprovedUniform(record, interaction.guild!);
    await interaction.editReply({
      embeds: [presentationEmbed(
        "Forwarded to Publishers",
        "The approved Classic Shirt was sent to the configured publisher channel.",
        "success",
        undefined,
        [{ name: "Approved asset", value: `[${asset.id}](${asset.url})` }],
      )],
      components: [],
      allowedMentions: noMentions,
    });
    return;
  }
  const approvedAsset = record.publishing!.approvedAsset;
  const approvedAssets = record.publishing!.approvedAssets ?? (approvedAsset ? [approvedAsset] : []);
  const approvedIndices = record.publishing!.approvedAssetIndices ??
    approvedAssets.map((_candidate, index) => index);
  const approvedByOriginalIndex = new Map(
    approvedAssets.map((candidate, index) => [approvedIndices[index]!, candidate] as const),
  );
  if (approvedAssets.length > 0 && submittedAssets.some((submitted, index) => {
    const approved = approvedByOriginalIndex.get(successfulIndices[index]!);
    return !approved || approved.id !== submitted.id;
  })) {
    const expected = successfulIndices.map((originalIndex) => {
      const candidate = approvedByOriginalIndex.get(originalIndex);
      return `Shirt ${originalIndex + 1}: ${candidate?.id ?? "not approved"}`;
    }).join(", ");
    throw new Error(`Publish the exact approved Classic Shirt assets (${expected}).`);
  }
  if (approvedAsset && approvedAsset.id !== asset.id) {
    throw new Error(`Publish the exact approved Classic Shirt asset (${approvedAsset.id}).`);
  }
  for (const candidate of submittedAssets) {
    const published = await verifyPublishedClassicShirt(candidate.id);
    if (published.name !== record.customerName) {
      throw new Error(`The published Classic Shirt must be named exactly "${record.customerName}".`);
    }
  }
  const publisherName = await discordPublisherName(interaction);
  try {
    const delivered = await completePublishedUniform(
      record,
      interaction.guild!,
      asset,
      publisherName,
      submittedAssets,
    );
    await interaction.editReply({
      embeds: [presentationEmbed(
        "Uniform Published and Delivered",
        `The catalog link was saved and the customer delivery was posted to <#${delivered.destinationChannelId}>.`,
        "success",
        undefined,
        [{ name: "Catalog link", value: asset.url }],
      )],
      components: [],
      allowedMentions: noMentions,
    });
  } catch (error) {
    throw error;
  }
}

async function sendPendingDelivery(
  record: UniformDeliveryRecord,
  guild: Guild,
): Promise<UniformDeliveryRecord> {
  const logChannel = await requireUniformChannel(
    guild, record.uploadLogChannelId, record.command,
  );
  const destination = await requireUniformChannel(guild, record.destinationChannelId, record.command);
  let current = await getUniformDelivery(record.submissionId) ?? record;
  if (current.logNoticeState === "unresolved" || current.customerDeliveryState === "unresolved") {
    throw new Error("A prior Discord delivery outcome is unresolved. No duplicate message will be sent; an administrator must verify the recorded channel.");
  }
  if (current.logNoticeState === "claimed" || current.customerDeliveryState === "claimed") {
    // A process can stop after persisting the outbox claim and before (or just
    // after) Discord accepts it. Never replay that ambiguous request.
    current = await updateUniformDelivery(record.submissionId, (item) => {
      if (item.logNoticeState === "claimed") item.logNoticeState = "unresolved";
      if (item.customerDeliveryState === "claimed") item.customerDeliveryState = "unresolved";
    });
    throw new Error("A prior Discord delivery attempt is unresolved. No duplicate message will be sent; an administrator must verify the recorded channel.");
  }
  if (current.logNoticeState !== "sent") {
    current = await claimUniformDeliveryStage(record.submissionId, "logNotice");
    let notice: unknown;
    try {
      const noticePayload = {
        content: "",
        embeds: [uploadAuditEmbed(current)],
        allowedMentions: noMentions, nonce: uniformDiscordNonce("notice", record.submissionId), enforceNonce: true,
      };
      try {
        notice = await logChannel.send(noticePayload);
      } catch (error) {
        const { code } = discordFailureDetails(error);
        if (code !== 10008) throw error;
        // Discord can retain an enforced nonce after its message is deleted.
        // A retry with that nonce then fails definitively with Unknown Message,
        // so omit only the stale nonce and recreate the missing notice once.
        const { nonce: _nonce, enforceNonce: _enforceNonce, ...freshNoticePayload } = noticePayload;
        logger.warn(
          { stage: "upload-log notice", discordCode: code },
          "Recreating a deleted Discord upload-log notice without its stale nonce",
        );
        notice = await logChannel.send(freshNoticePayload);
      }
    } catch (error) {
      const failure = discordDeliveryFailure("upload-log notice", error);
      await updateUniformDelivery(record.submissionId, (item) => {
        item.logNoticeState = failure.retryable ? "pending" : "unresolved";
      });
      throw failure;
    }
    try {
      const auditMessageId = sentMessageId(notice);
      if (!auditMessageId) throw new Error("Discord did not return a message ID for the upload audit.");
      current = await updateUniformDelivery(record.submissionId, (item) => {
        item.auditMessageId = auditMessageId;
      });
      await markUniformRowsNotified(record.spreadsheet, record.command, record.submissionId, sentMessageId(notice));
      current = await updateUniformDelivery(record.submissionId, (item) => { item.logNoticeState = "sent"; });
    } catch (error) {
      await updateUniformDelivery(record.submissionId, (item) => { item.logNoticeState = "unresolved"; });
      throw error;
    }
  }
  if (current.customerDeliveryState !== "sent") {
    current = await claimUniformDeliveryStage(record.submissionId, "customerDelivery");
    let message: unknown;
    try {
      message = await destination.send({
        content: `<@${record.customerId}>`, embeds: [customerDeliveryEmbed(current)],
        components: current.assets.length > 0 ? customerDeliveryButtons(current) : [],
        allowedMentions: { parse: [], users: [record.customerId] },
        nonce: uniformDiscordNonce("customer", record.submissionId), enforceNonce: true,
      });
    } catch (error) {
      const failure = discordDeliveryFailure("customer delivery", error);
      await updateUniformDelivery(record.submissionId, (item) => {
        item.customerDeliveryState = failure.retryable ? "pending" : "unresolved";
      });
      throw failure;
    }
    try {
      const messageId = sentMessageId(message);
      if (!messageId) throw new Error("Discord did not return a message ID for the customer delivery.");
      current = await updateUniformDelivery(record.submissionId, (item) => {
        item.customerMessageId = messageId;
        item.customerDeliveryState = "sent";
      });
    } catch (error) {
      await updateUniformDelivery(record.submissionId, (item) => { item.customerDeliveryState = "unresolved"; });
      throw error;
    }
  }
  return current;
}

export async function handleUniformSubmitButton(
  interaction: ButtonInteraction,
  maintenanceIsActive: (guildId: string) => Promise<boolean>,
): Promise<void> {
  const [, , nonce] = interaction.customId.split(":");
  if (!nonce) throw new Error("That uniform submission is unavailable.");
  const pending = pendingUniform(nonce, interaction);
  if (!pending.customerId) {
    throw new Error("Select the required Discord user(s) before submitting.");
  }
  await interaction.deferUpdate();
  if (await maintenanceIsActive(pending.guildId)) {
    throw new Error("Bot maintenance mode is active. Commands are temporarily unavailable.");
  }
  const latest = await getGuildSetup(pending.guildId);
  if (!latest) throw new Error("This server no longer has a valid bot setup.");
  const settings = uniformAccessSettings(latest, pending.command);
  await requireUniformSubmitter(interaction.guild!, pending.actorId, settings);
  if (settings.spreadsheet && pending.workbookGeneration !== undefined &&
      pending.workbookGeneration !== await payoutWorkbookGeneration(settings.spreadsheet.spreadsheetId)) {
    pendingUniformConfirmations.delete(nonce);
    throw new Error("This uniform confirmation predates a completed payout reset. Start a fresh uniform command.");
  }
  let record = await getUniformDelivery(pending.submissionId);
  if (record && (record.guildId !== pending.guildId || record.actorId !== pending.actorId)) {
    throw new Error("The durable uniform submission record does not match this confirmation.");
  }
  if (!record) {
    await fetchedMember(interaction.guild!, pending.customerId);
    const uploadLogChannelId = pending.command === "log"
      ? settings.seqmReviewChannelId ?? settings.logChannelId
      : settings.moderatedChannelId;
    await requireUniformChannel(interaction.guild!, uploadLogChannelId, pending.command);
    await requireUniformChannel(interaction.guild!, pending.destinationChannelId, pending.command);
    const spreadsheet = configuredSpreadsheet(settings);
    if (!spreadsheet) throw new Error("Google Sheets is not configured. The submission was not saved.");
    const initialRows = uniformSheetRows(pending.submission, {
      id: pending.submissionId, user: { id: pending.actorId }, guildId: pending.guildId,
    } as Pick<ChatInputCommandInteraction, "id" | "user" | "guildId">, new Date());
    const rows = pending.submission.sourceAttachments && pending.submission.sourceAttachments.length > 1
      ? pending.submission.sourceAttachments.map((_attachment, index) => {
        const row = [...(initialRows[0] ?? [])];
        if (row.length === LOG_UNIFORM_COLUMN_COUNT) row[row.length - 1] = "";
        if (index > 0 && row.length > 0) row[0] = row[0] ?? "";
        return row;
      })
      : initialRows;
    record = await saveUniformDelivery({
      submissionId: pending.submissionId, guildId: pending.guildId, command: pending.command,
      actorId: pending.actorId, customerId: pending.customerId, seqmId: pending.seqmId ?? "",
      destinationChannelId: pending.destinationChannelId, uploadLogChannelId: uploadLogChannelId!,
      spreadsheet, rows, sheetState: "prepared", assets: pending.submission.assets,
      customerName: pending.submission.users.customer.name,
      customerRobloxId: pending.submission.users.customer.id,
      logNoticeState: "pending",
      customerDeliveryState: "pending", ticketChannelName: pending.ticketChannelName,
      ...(pending.command === "log" && pending.submission.sourceAttachment && pending.submission.uniformType
        ? {
            publishing: {
              state: "handoff-pending" as const,
              uniformType: pending.submission.uniformType,
              ...(pending.submission.uniformTypes ? { uniformTypes: pending.submission.uniformTypes } : {}),
              publisherName: "Pending",
              stage: pending.twoStage ? "seqm-review" as const : "publisher" as const,
              publisherChannelId: pending.twoStage
                ? settings.publisherChannelId ?? settings.logChannelId
                : uploadLogChannelId,
              moderatedChannelId: settings.moderatedChannelId,
              ...(pending.twoStage && latest.seniorQuartermasterRoleId
                ? { seqmRoleId: latest.seniorQuartermasterRoleId }
                : {}),
              attachment: pending.submission.sourceAttachment!,
              ...(pending.submission.sourceAttachments ? { attachments: pending.submission.sourceAttachments } : {}),
              ...(pending.attachmentBuffer
                ? { sourceDataBase64: pending.attachmentBuffer.toString("base64") }
                : {}),
              ...(pending.attachmentBuffers
                ? { sourceDataBase64s: pending.attachmentBuffers.map((buffer) => buffer.toString("base64")) }
                : {}),
            },
          }
        : {}),
      createdAt: new Date().toISOString(),
    });
  }
  // The durable record is now authoritative. It outlives the private review
  // and prevents changed settings/selections from changing a retry.
  pendingUniformConfirmations.delete(nonce);
  const key = `${pending.guildId}:${pending.submissionId}`;
  if (activeUniformSubmissions.has(key)) throw new Error("This uniform submission is already being processed.");
  activeUniformSubmissions.add(key);
  try {
    if (record.publishing && record.publishing.state !== "published" && record.publishing.state !== "moderated") {
      const handoff = await sendPublishingHandoff(record, interaction.guild!, pending.attachmentBuffer, pending.attachmentBuffers);
      await interaction.editReply({
        embeds: [presentationEmbed(
          "Awaiting Roblox Upload",
          "The validated PNG and upload instructions were posted to the configured upload-log channel. Complete the Roblox upload there; no spreadsheet row or customer message has been sent yet.",
          "info",
          undefined,
          [
            { name: "Uniform type", value: safePresentationText(handoff.publishing!.uniformType), inline: true },
            { name: "Customer ticket", value: `<#${handoff.destinationChannelId}>`, inline: true },
          ],
        )],
        components: [],
        allowedMentions: noMentions,
      });
      return;
    }
    if (record.sheetState !== "saved") {
      try {
        await appendUniformRows({ config: record.spreadsheet, logKind: record.command, rows: record.rows, submissionId: record.submissionId });
        record = await updateUniformDelivery(record.submissionId, (item) => { item.sheetState = "saved"; });
      } catch {
        await interaction.editReply({
          ...recoveryPayload(
            record.submissionId,
            "Submission Pending",
            "The original Sheets target and rows are durably preserved, but the write outcome was not confirmed. Do not run the slash command again; Retry Delivery uses only that original target.",
            "warning",
            retryControlFor(record),
          ),
        });
        return;
      }
    }
    let delivered: UniformDeliveryRecord;
    try {
      delivered = await sendPendingDelivery(record, interaction.guild!);
    } catch (error) {
      const current = await getUniformDelivery(record.submissionId);
      const retryControl = retryControlFor(current);
      await interaction.editReply(recoveryPayload(
        record.submissionId,
        hasRetryableDelivery(current)
          ? "Saved, Delivery Needs Retry"
          : current?.sheetState === "saved" ? "Saved, Delivery Unresolved" : "Submission Outcome Unresolved",
        current?.sheetState === "saved" && error instanceof UniformDiscordDeliveryError
          ? `The uniform rows are saved, but ${error.message} The original rows will not be written again.`
          : current?.sheetState === "saved"
          ? "The uniform rows are saved, but a Discord delivery outcome could not be confirmed. No duplicate message will be sent automatically; an administrator must verify the recorded channel."
          : "The original Sheets target is durably reserved, but its write outcome could not be confirmed. Do not run the slash command again; an administrator must verify the original sheet target.",
        "warning",
        retryControl,
      ));
      return;
    }
    await interaction.editReply({
      embeds: [presentationEmbed(
        "Uniform Submitted",
        `The /${pending.command} rows were saved, one short upload-log notice was sent, and the customer delivery was posted to <#${delivered.destinationChannelId}>.`,
        "success",
      )],
      components: [],
      allowedMentions: noMentions,
    });
  } finally {
    activeUniformSubmissions.delete(key);
  }
}

export async function handleUniformRetryButton(
  interaction: ButtonInteraction,
  maintenanceIsActive: (guildId: string) => Promise<boolean>,
): Promise<void> {
  const [, , submissionId] = interaction.customId.split(":");
  if (!submissionId) throw new Error("That delivery retry is unavailable.");
  const record = await getUniformDelivery(submissionId);
  if (!record || record.guildId !== interaction.guildId) {
    throw new Error("This recorded delivery is unavailable.");
  }
  await interaction.deferUpdate();
  let authorizationVerified = false;
  try {
    if (await maintenanceIsActive(record.guildId)) {
      throw new Error("Bot maintenance mode is active. Commands are temporarily unavailable.");
    }
    const latest = await getGuildSetup(record.guildId);
    if (!latest) throw new Error("This server no longer has a valid bot setup.");
    const settings = uniformAccessSettings(latest, record.command);
    if (record.relog || record.relogHandoff) {
      if (!await relogAuthorized(interaction.guild!, interaction.user.id, record, latest)) {
        throw new Error(record.command === "log"
          ? "Only the assigned Senior Quartermaster or a current Administrator can retry this relog."
          : "Only the original moderated actor or a current Administrator can retry this relog.");
      }
    } else if (record.actorId === interaction.user.id) {
      await requireUniformSubmitter(interaction.guild!, record.actorId, settings);
    } else {
      const member = await currentMember(interaction.guild!, interaction.user.id);
      if (interaction.guild!.ownerId !== member.id && !member.permissions.has(PermissionFlagsBits.Administrator)) {
        throw new Error("Only the original authorized submitter or a current Administrator can retry this recorded delivery.");
      }
    }
    // Re-check authorization on every click. A saved record never grants
    // access by itself, and the guild binding above is checked before any
    // provider work.
    authorizationVerified = true;
    if (record.relogHandoff?.state === "handoff-pending") {
      const handoff = await sendRelogPublishingHandoff(record, interaction.guild!);
      await interaction.editReply(relogHandoffStartedPayload(handoff));
      return;
    }
    if (record.relogHandoff?.state === "publish-claimed") {
      const operation = record.relogHandoff;
      let delivered = record;
      if (!delivered.relog) {
        if (!operation.publishedAsset) {
          throw new Error("The verified replacement asset is missing, so recovery cannot continue.");
        }
        delivered = await selectAndStartRelog(
          delivered,
          operation.rowIndex,
          operation.publishedAsset,
          interaction.guild!,
        );
      } else {
        delivered = await continueRelog(delivered, interaction.guild!);
      }
      if (delivered.relog?.state !== "sent") {
        throw new Error("The replacement delivery has not reached a confirmed sent state.");
      }
      delivered = await updateUniformDelivery(record.submissionId, (item) => {
        if (item.relogHandoff?.nonce !== operation.nonce) {
          throw new Error("The replacement handoff changed during recovery.");
        }
        item.relogHandoff.state = "published";
        item.relogHandoff.completedAt = new Date().toISOString();
      });
      await editRelogPublishingHandoff(delivered, interaction.guild!, relogAuditEmbed(delivered)).catch(() => undefined);
      await interaction.editReply(relogSuccessPayload(delivered));
      return;
    }
    if (record.relogHandoff &&
        record.relogHandoff.state !== "published" &&
        record.relogHandoff.state !== "moderated") {
      throw new Error("This replacement publishing handoff is awaiting a result or unresolved. Retry Delivery cannot bypass Roblox publication.");
    }
    if (record.publishing) {
      const state = record.publishing.state;
      if (state === "handoff-pending") {
        const handoff = await sendPublishingHandoff(record, interaction.guild!);
        await interaction.editReply({
          embeds: [presentationEmbed(
            "Publishing Handoff Restored",
            "The original pending handoff was posted. Complete it in the upload-log channel; no spreadsheet row or customer message was sent.",
            "success",
          )],
          components: [],
          allowedMentions: noMentions,
        });
        return;
      }
      if (state === "handoff-claimed" || state === "moderation-claimed") {
        await updateUniformDelivery(record.submissionId, (item) => {
          if (item.publishing?.state === state) item.publishing.state = "unresolved";
        });
        throw new Error("The publishing provider outcome is unresolved and will not be replayed automatically.");
      }
      if (state === "awaiting-result") {
        throw new Error("This uniform is still awaiting a Roblox publishing result in the upload-log channel.");
      }
      if (state === "moderated") {
        throw new Error("This uniform was rejected by Roblox moderation and has no customer delivery to retry.");
      }
      if (state === "unresolved") {
        throw new Error("The publishing handoff outcome is unresolved and will not be replayed automatically.");
      }
      if (state === "publish-claimed") {
        await appendUniformRows({
          config: record.spreadsheet,
          logKind: "log",
          rows: record.rows,
          submissionId: record.submissionId,
        });
        await updateUniformDelivery(record.submissionId, (item) => {
          if (item.publishing?.state !== "publish-claimed") {
            throw new Error("The publishing result changed during recovery.");
          }
          item.sheetState = "saved";
          item.logNoticeState = "sent";
          item.publishing.state = "published";
          item.publishing.completedAt = new Date().toISOString();
        });
      } else if (record.sheetState !== "saved") {
        throw new Error("The published uniform has no confirmed spreadsheet row and will not be delivered.");
      }
    }
    await fetchedMember(interaction.guild!, record.customerId);
    if (record.command === "log") await fetchedMember(interaction.guild!, record.seqmId);
    await requireUniformChannel(interaction.guild!, record.destinationChannelId, record.command);
    if (record.relog) {
      const delivered = await continueRelog(record, interaction.guild!);
      await interaction.editReply(relogSuccessPayload(delivered));
      return;
    }
    await requireUniformChannel(interaction.guild!, record.uploadLogChannelId, record.command);
    if (!record.publishing && record.sheetState !== "saved") {
      await appendUniformRows({ config: record.spreadsheet, logKind: record.command, rows: record.rows, submissionId: record.submissionId });
      await updateUniformDelivery(record.submissionId, (item) => { item.sheetState = "saved"; });
    }
    const current = await getUniformDelivery(submissionId);
    if (!current || current.logNoticeState === "unresolved" || current.customerDeliveryState === "unresolved") {
      throw new Error("This delivery outcome is unresolved and will not be replayed automatically.");
    }
    const delivered = await sendPendingDelivery(current, interaction.guild!);
    await interaction.editReply({
      embeds: [presentationEmbed("Uniform Delivery Completed", `The existing saved submission was delivered to <#${delivered.destinationChannelId}> without writing Sheets rows again.`, "success", undefined, [
        { name: "Submission ID", value: displayId(delivered.submissionId), inline: true },
      ])],
      components: [],
      allowedMentions: noMentions,
    });
  } catch (error) {
    const current = await getUniformDelivery(submissionId).catch(() => record);
    const retryControl = authorizationVerified ? retryControlFor(current) : "none";
    if (error instanceof UniformDeliveryRecoveryError) throw error;
    throw new UniformDeliveryRecoveryError(
      submissionId,
      error instanceof Error ? error.message : "The saved delivery could not be retried.",
      retryControl,
    );
  }
}

export async function handleUniformCancelButton(interaction: ButtonInteraction): Promise<void> {
  const [, , nonce] = interaction.customId.split(":");
  if (!nonce) throw new Error("That uniform submission is unavailable.");
  pendingUniform(nonce, interaction);
  pendingUniformConfirmations.delete(nonce);
  await interaction.update({
    embeds: [presentationEmbed("Uniform Submission Cancelled", "No Google Sheets rows or Discord messages were sent.", "info")],
    components: [],
    allowedMentions: noMentions,
  });
}

function escapedAssistanceReason(value: string): string {
  // The reason is displayed as literal text, never as customer-controlled
  // markdown, links, or a mention. presentation text also removes controls.
  return safePresentationText(value, 1000).replace(/[\\`*_~|[\]()]/g, "\\$&");
}
interface DeliveryActionExpectation {
  customerMessageId: string;
  customerMessageRevision: number;
}

async function boundDelivery(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  submissionId: string,
  expected?: DeliveryActionExpectation,
): Promise<UniformDeliveryRecord> {
  const record = await getUniformDelivery(submissionId);
  if (!record || record.guildId !== interaction.guildId || record.destinationChannelId !== interaction.channelId) {
    throw new Error("This uniform delivery control is no longer valid.");
  }
  if (interaction.user.id !== record.customerId) throw new Error("Only the selected customer can use this uniform delivery control.");
  if ("message" in interaction && (!interaction.message || record.customerMessageId !== interaction.message.id)) {
    throw new Error("This uniform delivery control is not attached to its recorded customer message.");
  }
  if (expected && (
    record.customerMessageId !== expected.customerMessageId ||
    (record.customerMessageRevision ?? 0) !== expected.customerMessageRevision
  )) {
    throw new Error("This uniform delivery control is not attached to its recorded customer message.");
  }
  await fetchedMember(interaction.guild!, record.customerId);
  return record;
}

async function completePurchasedAudit(record: UniformDeliveryRecord, guild: Guild): Promise<UniformDeliveryRecord> {
  let current = await getUniformDelivery(record.submissionId) ?? record;
  const auditState = current.action?.auditState ?? "pending";
  if (current.terminal !== "purchased" || auditState === "sent") return current;
  if (auditState === "unresolved") {
    throw new Error("The purchase audit outcome is unresolved. The customer confirmation was already delivered and will not be sent again.");
  }
  if (auditState === "claimed") {
    await updateUniformDelivery(current.submissionId, (item) => {
      if (item.action?.auditState === "claimed") item.action.auditState = "unresolved";
    });
    throw new Error("The purchase audit outcome is unresolved. The customer confirmation was already delivered and will not be sent again.");
  }
  current = await updateUniformDelivery(current.submissionId, (item) => {
    if (item.terminal !== "purchased" || !item.action || (item.action.auditState && item.action.auditState !== "pending")) {
      throw new Error("The purchase audit is no longer ready to send.");
    }
    item.action.auditState = "claimed";
  });
  try {
    const channel = await requireUniformChannel(guild, current.uploadLogChannelId, current.command);
    if (current.auditMessageId) {
      const original = await channel.messages?.fetch(current.auditMessageId);
      if (!original) throw new Error("The recorded original upload audit message could not be fetched.");
      await original.edit({
        content: "",
        embeds: [uploadAuditEmbed(current, "Uniform Sold Successfully")],
        allowedMentions: noMentions,
      });
    } else {
      // Older records did not retain the initial audit message ID. Their
      // dedicated nonce keeps this explicit fallback from creating duplicates.
      const message = await channel.send({
        content: "",
        embeds: [uploadAuditEmbed(current, "Uniform Sold Successfully")],
        allowedMentions: noMentions,
        nonce: uniformDiscordNonce("sold", current.submissionId),
        enforceNonce: true,
      });
      const auditMessageId = sentMessageId(message);
      if (!auditMessageId) throw new Error("Discord did not return a message ID for the sold audit.");
      current = await updateUniformDelivery(current.submissionId, (item) => {
        item.auditMessageId = auditMessageId;
      });
    }
    return updateUniformDelivery(current.submissionId, (item) => {
      if (item.action?.auditState === "claimed") item.action.auditState = "sent";
    });
  } catch (error) {
    const failure = error instanceof UniformDiscordDeliveryError
      ? error
      : discordDeliveryFailure("purchase audit", error);
    await updateUniformDelivery(current.submissionId, (item) => {
      if (item.action?.auditState === "claimed") item.action.auditState = failure.retryable ? "pending" : "unresolved";
    }).catch(() => undefined);
    throw failure;
  }
}

export async function handleUniformCustomerButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, submissionId] = interaction.customId.split(":");
  if ((action !== "purchase" && action !== "assist") || !submissionId) throw new Error("That uniform delivery control is unavailable.");
  let record = await boundDelivery(interaction, submissionId);
  let purchaseRowsAlreadyMarked = false;
  if (record.terminal) {
    // A prior terminal outbox send succeeded but the message edit may have
    // failed. Repair the visible controls without sending another outcome.
    await interaction.update({ components: customerDeliveryButtons(record, true) });
    if (record.terminal === "purchased") await completePurchasedAudit(record, interaction.guild!);
    return;
  }
  if (record.action) {
    const recoverablePublishedPurchase =
      action === "purchase" &&
      record.command === "log" &&
      record.action.kind === "purchased" &&
      record.action.state === "unresolved" &&
      !record.action.purchaseSheetState &&
      !record.terminal &&
      record.publishing?.state === "published";
    if (!recoverablePublishedPurchase) {
      throw new Error("This customer outcome is already claimed or unresolved. It will not be sent again automatically.");
    }
    // Published handoffs historically looked up the base submission ID even
    // though their successful rows were recorded under the :published ledger
    // ID. That deterministic pre-send failure is safe to release for retry.
    await markUniformRowsSold(
      record.spreadsheet,
      record.command,
      `${record.submissionId}:published`,
    );
    purchaseRowsAlreadyMarked = true;
    record = await updateUniformDelivery(record.submissionId, (item) => {
      if (item.action?.kind !== "purchased" ||
          item.action.state !== "unresolved" ||
          item.action.purchaseSheetState ||
          item.terminal) {
        throw new Error("This customer outcome is no longer eligible for spreadsheet recovery.");
      }
      delete item.action;
    });
  }
  if (action === "assist") {
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(
          `uniform:assist-modal:${submissionId}:${interaction.message.id}:${record.customerMessageRevision ?? 0}`,
        )
        .setTitle("Request Senior Quartermaster Assistance")
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("reason").setLabel("How can we help?").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
        )),
    );
    return;
  }
  await interaction.deferUpdate();
  if (!record.customerRobloxId) {
    await interaction.editReply({
      embeds: [presentationEmbed(
        "Ownership Check Unavailable",
        "This older delivery does not contain the Roblox user ID required for automatic verification. Request Senior Quartermaster assistance.",
        "warning",
      )],
      components: ownershipRetryComponents(record),
      allowedMentions: noMentions,
    });
    return;
  }
  let ownership: Array<{ asset: { id: number; url: string }; owned: boolean }>;
  try {
    ownership = await Promise.all(
      record.assets.map(async (asset) => ({
        asset,
        owned: await ownsRobloxAsset(record.customerRobloxId!, asset.id),
      })),
    );
  } catch (error) {
    await interaction.editReply(ownershipFailureResponse(record, error));
    return;
  }
  const missing = ownership.filter((result) => !result.owned);
  if (missing.length > 0) {
    await interaction.editReply(
      ownershipFailureResponse(
        record,
        undefined,
        missing.map(({ asset }) => asset),
      ),
    );
    return;
  }
  const claimed = await claimUniformDeliveryAction(submissionId, "purchased", undefined, {
    customerMessageId: interaction.message.id,
    customerMessageRevision: record.customerMessageRevision ?? 0,
  });
  if (claimed.action?.kind !== "purchased" || claimed.action.state !== "claimed") {
    throw new Error("This customer outcome is already claimed or unresolved. It will not be sent again automatically.");
  }
  try {
    // A /log acknowledgement is not successful unless its immutable original
    // ledger rows were marked in the fixed Sold column first.
    if (record.command === "log") {
      if (!purchaseRowsAlreadyMarked) {
        await markUniformRowsSold(
          record.spreadsheet,
          record.command,
          record.publishing ? `${submissionId}:published` : submissionId,
        );
      }
      await updateUniformDelivery(submissionId, (item) => {
        if (item.action?.kind !== "purchased" || item.action.state !== "claimed") {
          throw new Error("The purchase outcome changed before its spreadsheet update was recorded.");
        }
        item.action.purchaseSheetState = "sold";
      });
    }
    const channel = await requireUniformChannel(interaction.guild!, record.destinationChannelId, record.command);
    await channel.send({
      content: record.command === "log" ? `<@${record.seqmId}>` : "A customer has confirmed their purchase.",
      embeds: [purchaseConfirmationEmbed(record)],
      allowedMentions: record.command === "log" ? { parse: [], users: [record.seqmId] } : noMentions,
      nonce: claimed.action.nonce,
      enforceNonce: true,
    });
    await updateUniformDelivery(submissionId, (item) => {
      item.terminal = "purchased";
      if (item.action) {
        item.action.state = "sent";
        item.action.auditState = "pending";
      }
    });
    await completePurchasedAudit(record, interaction.guild!);
  } catch (error) {
    await updateUniformDelivery(submissionId, (item) => {
      if (item.action?.state === "claimed") item.action.state = "unresolved";
    }).catch(() => undefined);
    throw error;
  }
  await interaction.editReply({
    embeds: [presentationEmbed(
      "Ownership Verified",
      "Roblox confirmed ownership of every submitted uniform. The purchase has been recorded.",
      "success",
    )],
    components: customerDeliveryButtons(claimed, true),
    allowedMentions: noMentions,
  });
}

export async function handleUniformAssistanceModal(interaction: ModalSubmitInteraction): Promise<void> {
  const [, , submissionId, customerMessageId, revisionText] = interaction.customId.split(":");
  const customerMessageRevision = Number(revisionText);
  if (!submissionId || !customerMessageId || !Number.isSafeInteger(customerMessageRevision) || customerMessageRevision < 0) {
    throw new Error("That assistance request is unavailable. Open Request Assistance again from the current delivery message.");
  }
  const expected = { customerMessageId, customerMessageRevision };
  const record = await boundDelivery(interaction, submissionId, expected);
  if (record.terminal) throw new Error("This uniform delivery has already been completed.");
  if (record.action) throw new Error("This customer outcome is already claimed or unresolved. It will not be sent again automatically.");
  let reason = "";
  try { reason = interaction.fields.getTextInputValue("reason").trim(); } catch { /* reply below */ }
  if (!reason || reason.length > 1000) throw new Error("An assistance reason of up to 1000 characters is required.");
  const claimed = await claimUniformDeliveryAction(submissionId, "assistance", reason, expected);
  if (claimed.action?.kind !== "assistance" || claimed.action.state !== "claimed") {
    throw new Error("This customer outcome is already claimed or unresolved. It will not be sent again automatically.");
  }
  try {
    await interaction.deferReply({ ephemeral: true });
    const channel = await requireUniformChannel(interaction.guild!, record.destinationChannelId, record.command);
    await channel.send({
      content: record.command === "log" ? `<@${record.seqmId}>` : "A customer assistance request was posted.",
      embeds: [presentationEmbed(
        "Customer Assistance Requested",
        "The customer needs Senior Quartermaster assistance and will be in touch shortly.",
        "warning",
        undefined,
        [{ name: "Reason", value: escapedAssistanceReason(reason) }],
      )],
      allowedMentions: record.command === "log" ? { parse: [], users: [record.seqmId] } : noMentions,
      nonce: claimed.action.nonce,
      enforceNonce: true,
    });
    await updateUniformDelivery(submissionId, (item) => {
      item.terminal = "assistance";
      if (item.action) item.action.state = "sent";
    });
    const original = await interaction.channel?.messages.fetch(record.customerMessageId!);
    await original?.edit({ components: customerDeliveryButtons(claimed, true) });
    await interaction.editReply({
      embeds: [presentationEmbed("Assistance Requested", "Your request was sent. A Senior Quartermaster will be in touch shortly.", "success")],
      allowedMentions: noMentions,
    });
  } catch (error) {
    await updateUniformDelivery(submissionId, (item) => {
      if (item.action?.state === "claimed") item.action.state = "unresolved";
    }).catch(() => undefined);
    throw error;
  }
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
  if (normalized.seqmReviewChannelId) {
    await requireUniformChannel(guild, normalized.seqmReviewChannelId, "log");
  }
  if (normalized.publisherChannelId) {
    await requireUniformChannel(guild, normalized.publisherChannelId, "log");
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
  return updateGuildSetup(setup.guildId, async (latest) => {
    const existing = uniformSettingsFor(latest ?? setup);
    const normalized: UniformSettings = {
      ...existing,
      ...settings,
      authorizedRoleIds: [...new Set(settings.authorizedRoleIds ?? [])],
      authorizedMemberIds: [...new Set(settings.authorizedMemberIds ?? [])],
      ...(Object.prototype.hasOwnProperty.call(settings, "spreadsheet")
        ? { spreadsheet: settings.spreadsheet }
        : existing.spreadsheet
          ? { spreadsheet: existing.spreadsheet }
          : {}),
    };
    // This screen edits destinations only. Permission grants are preserved
    // verbatim and are validated by the application-owner permissions flow.
    await validateUniformSettings(guild, {
      ...normalized,
      authorizedRoleIds: [],
      authorizedMemberIds: [],
    });
    const base = latest ?? setup;
    return {
      ...base,
      uniforms: normalized,
      updatedBy: actorId,
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function resetUniformSettings(
  setup: GuildSetup,
  actorId: string,
): Promise<GuildSetup> {
  return updateGuildSetup(setup.guildId, (latest) => {
    const updated = { ...(latest ?? setup) } as GuildSetup & { uniforms?: UniformSettings };
    const existing = uniformSettingsFor(updated);
    updated.uniforms = {
      authorizedRoleIds: existing.authorizedRoleIds,
      authorizedMemberIds: existing.authorizedMemberIds,
    };
    updated.updatedBy = actorId;
    updated.updatedAt = new Date().toISOString();
    return updated;
  });
}

export function uniformSettingsEmbed(
  setup: GuildSetup,
  avatarUrl?: string,
  recoverableSubmissionId?: string,
): EmbedBuilder {
  const settings = uniformSettingsFor(setup);
  const mentionList = (ids: string[], prefix: string): string =>
    ids.length ? ids.map((id) => `${prefix}${id}>`).join(", ") : "None — Administrators only";
  return presentationEmbed(
    "Uniforms",
    "Separate uniform logging destinations and submitter access. Administrators and the server owner can always submit. Access grants are read-only here and can only be changed by the Discord application owner under Global → Permissions.",
    "info",
    avatarUrl,
    [
      { name: "SEQM review channel", value: settings.seqmReviewChannelId ? `<#${settings.seqmReviewChannelId}>` : "Not configured", inline: true },
      { name: "Publisher channel", value: settings.publisherChannelId ? `<#${settings.publisherChannelId}>` : "Not configured", inline: true },
      { name: "/moderated destination", value: settings.moderatedChannelId ? `<#${settings.moderatedChannelId}>` : "Not configured", inline: true },
      { name: "Authorized roles", value: mentionList(settings.authorizedRoleIds, "<@&"), inline: false },
      { name: "Authorized members", value: mentionList(settings.authorizedMemberIds, "<@"), inline: false },
      {
        name: "Google Sheets",
        value: settings.spreadsheet
          ? `${safePresentationText(settings.spreadsheet.spreadsheetId)}\n/log: ${safePresentationText(settings.spreadsheet.logTab)} · ${safePresentationText(settings.spreadsheet.logRange ?? "A2:E")}\n/moderated: ${safePresentationText(settings.spreadsheet.moderatedTab)} · ${safePresentationText(settings.spreadsheet.moderatedRange ?? "A2:D")}`
          : "Not configured — submissions require Spreadsheet Configuration",
        inline: false,
      },
      ...(recoverableSubmissionId
        ? [{
            name: "Recoverable saved delivery",
            value: `Legacy nonce rejection: \`${safePresentationText(recoverableSubmissionId)}\`\nUse Recover Delivery to safely enable its existing delivery retry. No Sheets rows will be written again.`,
            inline: false,
          }]
        : []),
    ],
  );
}

export async function renderUniformSettings(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  setup: GuildSetup,
  avatarUrl?: string,
): Promise<void> {
  const recoverable = await findLegacyNonceRejectedDelivery(setup.guildId);
  await interaction.update({
    embeds: [uniformSettingsEmbed(setup, avatarUrl, recoverable?.submissionId)],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("setup:uniforms-config")
          .setLabel("Uploading Configuration")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("setup:uniforms-spreadsheet-config")
          .setLabel("Spreadsheet Configuration")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("setup:uniforms-spreadsheet-reset")
          .setLabel("Reset Spreadsheet")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("setup:uniforms-reset")
          .setLabel("Reset Uniforms")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("setup:uniforms-recover")
          .setLabel("Recover Delivery")
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!recoverable),
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
  if (id === "setup:uniforms-spreadsheet-reset") {
    const updated = await resetUniformSpreadsheetSettings(setup, interaction.user.id);
    await interaction.update({
      embeds: [uniformSettingsEmbed(updated)],
      components: [],
    });
    return;
  }
  if (id === "setup:uniforms-spreadsheet-config") {
    const spreadsheet = uniformSettingsFor(setup).spreadsheet;
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId("setup-modal:uniforms-spreadsheet")
        .setTitle("Uniform Spreadsheet Configuration")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("spreadsheet_id")
              .setLabel("Google Sheets URL or spreadsheet ID")
              .setStyle(TextInputStyle.Short)
              .setValue(spreadsheet?.spreadsheetId ?? "")
              .setRequired(true)
              .setMaxLength(300),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("log_tab")
              .setLabel("/log worksheet tab (default: Uniform Logs)")
              .setStyle(TextInputStyle.Short)
              .setValue(spreadsheet?.logTab ?? "Uniform Logs")
              .setRequired(true)
              .setMaxLength(100),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("moderated_tab")
              .setLabel("/moderated tab (default: Moderated Logs)")
              .setStyle(TextInputStyle.Short)
              .setValue(spreadsheet?.moderatedTab ?? "Moderated Logs")
              .setRequired(true)
              .setMaxLength(100),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("log_range")
              .setLabel("/log data range (exactly 5 columns)")
              .setStyle(TextInputStyle.Short)
              .setValue(spreadsheet?.logRange ?? "A2:E")
              .setRequired(true)
              .setMaxLength(40),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("moderated_range")
              .setLabel("/moderated data range (exactly 4 columns)")
              .setStyle(TextInputStyle.Short)
              .setValue(spreadsheet?.moderatedRange ?? "A2:D")
              .setRequired(true)
              .setMaxLength(40),
          ),
        ),
    );
    return;
  }
  if (id === "setup:uniforms-recover") {
    const recoverable = await findLegacyNonceRejectedDelivery(setup.guildId);
    if (!recoverable) {
      throw new Error("There is no saved delivery eligible for legacy nonce recovery.");
    }
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId("setup-modal:uniforms-recover")
        .setTitle("Recover Saved Uniform Delivery")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("submission_id")
              .setLabel("Saved delivery submission ID")
              .setStyle(TextInputStyle.Short)
              .setValue(recoverable.submissionId)
              .setRequired(true)
              .setMaxLength(25),
          ),
        ),
    );
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
            .setCustomId("seqm_review_channel_id")
            .setLabel("SEQM review channel ID")
            .setStyle(TextInputStyle.Short)
            .setValue(settings.seqmReviewChannelId ?? "")
            .setRequired(true)
            .setMaxLength(25),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("publisher_channel_id")
            .setLabel("Publisher channel ID")
            .setStyle(TextInputStyle.Short)
            .setValue(settings.publisherChannelId ?? "")
            .setRequired(true)
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
  const member = await currentMember(interaction.guild!, interaction.user.id);
  if (interaction.guild!.ownerId !== member.id &&
      !member.permissions.has(PermissionFlagsBits.Administrator)) {
    throw new Error("Only the server owner or a current Administrator can change Uniforms settings.");
  }
  const existing = uniformSettingsFor(setup);
  const settings: UniformSettings = {
    ...existing,
    seqmReviewChannelId: optionalChannelId(
      uniformModalValue(interaction, "seqm_review_channel_id"),
      "SEQM review channel ID",
    ),
    publisherChannelId: optionalChannelId(
      uniformModalValue(interaction, "publisher_channel_id"),
      "Publisher channel ID",
    ),
    moderatedChannelId: optionalChannelId(
      uniformModalValue(interaction, "moderated_channel_id"),
      "/moderated channel ID",
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
      "Uniform destinations were validated and saved. Blank destinations disable that command. Access grants were preserved and remain editable only under Global → Permissions.",
      "success",
      undefined,
      [
        { name: "SEQM review", value: updated.uniforms?.seqmReviewChannelId ? `<#${updated.uniforms.seqmReviewChannelId}>` : "Not configured", inline: true },
        { name: "Publishers", value: updated.uniforms?.publisherChannelId ? `<#${updated.uniforms.publisherChannelId}>` : "Not configured", inline: true },
        { name: "/moderated", value: updated.uniforms?.moderatedChannelId ? `<#${updated.uniforms.moderatedChannelId}>` : "Not configured", inline: true },
      ],
    )],
    allowedMentions: noMentions,
    ephemeral: true,
  });
  return updated;
}

export async function handleUniformRecoveryModal(
  interaction: ModalSubmitInteraction,
  setup: GuildSetup,
): Promise<void> {
  const submissionId = uniformModalValue(interaction, "submission_id").trim();
  if (!/^\d{17,25}$/.test(submissionId)) {
    throw new Error("The saved delivery submission ID must contain 17 to 25 digits.");
  }
  try {
    const recovered = await recoverLegacyNonceRejectedDelivery(setup.guildId, submissionId);
    await interaction.reply({
      ...recoveryPayload(
        recovered.submissionId,
        "Delivery Recovery Ready",
        "The confirmed legacy nonce rejection was reset to pending. Retry Delivery will use the original saved delivery and will not write Google Sheets rows again.",
        "warning",
        retryControlFor(recovered),
      ),
      ephemeral: true,
    });
  } catch (error) {
    const record = await getUniformDelivery(submissionId).catch(() => undefined);
    throw new UniformDeliveryRecoveryError(
      submissionId,
      error instanceof Error ? error.message : "The saved delivery could not be recovered.",
      retryControlFor(record),
    );
  }
}

export async function handleUniformSpreadsheetSettingsModal(
  interaction: ModalSubmitInteraction,
  setup: GuildSetup,
): Promise<GuildSetup> {
  const spreadsheet = {
    spreadsheetId: uniformModalValue(interaction, "spreadsheet_id"),
    logTab: uniformModalValue(interaction, "log_tab") || "Uniform Logs",
    moderatedTab: uniformModalValue(interaction, "moderated_tab") || "Moderated Logs",
    logRange: normalizeUniformDataRange(
      uniformModalValue(interaction, "log_range"), 5, "The /log data range",
    ),
    moderatedRange: normalizeUniformDataRange(
      uniformModalValue(interaction, "moderated_range"), 4, "The /moderated data range",
    ),
  };
  const updated = await saveUniformSpreadsheetSettings(
    interaction.guild!,
    setup,
    interaction.user.id,
    spreadsheet,
  );
  await interaction.reply({
    content: "",
    embeds: [presentationEmbed(
      "Spreadsheet Configuration Saved",
      "Google Sheets tabs and data ranges were validated before saving. Submissions write only their configured 5 or 4 user-data cells with RAW values; headers and surrounding sheet data are never changed.",
      "success",
      undefined,
      [
        { name: "Spreadsheet", value: safePresentationText(updated.uniforms?.spreadsheet?.spreadsheetId ?? "") },
        { name: "/log tab", value: safePresentationText(updated.uniforms?.spreadsheet?.logTab ?? "Uniform Logs"), inline: true },
        { name: "/moderated tab", value: safePresentationText(updated.uniforms?.spreadsheet?.moderatedTab ?? "Moderated Logs"), inline: true },
        { name: "/log range", value: safePresentationText(updated.uniforms?.spreadsheet?.logRange ?? "A2:E"), inline: true },
        { name: "/moderated range", value: safePresentationText(updated.uniforms?.spreadsheet?.moderatedRange ?? "A2:D"), inline: true },
      ],
    )],
    allowedMentions: noMentions,
    ephemeral: true,
  });
  return updated;
}
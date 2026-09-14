import { Colors, EmbedBuilder, type APIEmbedField } from "discord.js";

/**
 * Keep bot presentation deliberately quiet: one outcome color, a readable
 * heading, and the bot avatar where Discord exposes it.  The helpers also
 * enforce Discord's per-part limits so provider/user supplied values cannot
 * make an otherwise useful response fail to send.
 */
export type PresentationTone = "info" | "success" | "warning" | "error";

const toneColors: Record<PresentationTone, number> = {
  info: Colors.Blue,
  success: Colors.Green,
  warning: Colors.Yellow,
  error: Colors.Red,
};

export const noMentions = { parse: [] as never[] };

export function embedOnlyResponse(embed: EmbedBuilder) {
  return {
    content: "",
    embeds: [embed],
    allowedMentions: noMentions,
  };
}

export function truncatePresentation(value: string, maximum: number): string {
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (normalized.length <= maximum) return normalized || "None";
  return `${normalized.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

/** Clean untrusted text without allowing markdown delimiters to escape. */
export function safePresentationText(value: string, maximum = 1_024): string {
  return trustedPresentationText(value.replaceAll("`", "'"), maximum);
}

/** Preserve trusted markdown/code formatting while neutralizing mentions. */
export function trustedPresentationText(value: string, maximum = 1_024): string {
  return truncatePresentation(value.replaceAll("@", "@\u200b"), maximum);
}

export function titleCaseHeading(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/(^|[\s/:-])([a-z])/g, (_match, prefix: string, letter: string) =>
      `${prefix}${letter.toUpperCase()}`,
    );
}

export function displayId(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === ""
    ? "Not available"
    : `\`${trustedPresentationText(String(value), 100)}\``;
}

export function readableDate(value: string | Date | null | undefined): string {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return "Not available";
  const seconds = Math.floor(timestamp / 1_000);
  return `<t:${seconds}:f>`;
}

export function presentationEmbed(
  title: string,
  description: string,
  tone: PresentationTone = "info",
  avatarUrl?: string,
  fields?: APIEmbedField[],
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(trustedPresentationText(`Quartermaster | ${titleCaseHeading(title)}`, 256))
    .setDescription(trustedPresentationText(description, 4_096))
    .setColor(toneColors[tone]);
  if (avatarUrl) embed.setThumbnail(avatarUrl);
  if (fields?.length) {
    const titleLength = String(embed.data.title ?? "").length;
    const descriptionLength = String(embed.data.description ?? "").length;
    // Leave room for future footer/author metadata and avoid adding a field
    // when only a single character remains in the aggregate budget.
    let remaining = Math.max(0, 6_000 - titleLength - descriptionLength - 64);
    const boundedFields: APIEmbedField[] = [];
    for (const field of fields.slice(0, 25)) {
      if (remaining < 2) break;
      const name = trustedPresentationText(field.name, Math.min(256, remaining - 1));
      const valueBudget = Math.min(1_024, remaining - name.length);
      if (!name || valueBudget < 1) break;
      const value = trustedPresentationText(field.value, valueBudget);
      if (!value) break;
      boundedFields.push({ name, value, inline: field.inline });
      remaining -= name.length + value.length;
    }
    if (boundedFields.length) embed.addFields(boundedFields);
  }
  return embed;
}

export function outcomeLabel(tone: PresentationTone): string {
  return titleCaseHeading(tone);
}
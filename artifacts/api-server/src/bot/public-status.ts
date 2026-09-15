export type PublicBotStatus = "online" | "maintenance" | "offline";

export function mapDiscordPresenceToPublicStatus(
  presence: string,
  maintenance: boolean,
  ready: boolean,
): PublicBotStatus {
  if (!ready || presence === "offline" || presence === "invisible") {
    return "offline";
  }
  if (maintenance || presence === "idle") {
    return "maintenance";
  }
  return presence === "online" || presence === "dnd" ? "online" : "offline";
}
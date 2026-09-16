import { Collection, type Guild, type GuildMember } from "discord.js";

const requests = new WeakMap<Guild, Promise<Collection<string, GuildMember>>>();

type DiscordHttpFailure = {
  status?: unknown;
  method?: unknown;
  url?: unknown;
};

function safePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).pathname;
  } catch {
    return undefined;
  }
}

export class GuildMemberListError extends Error {
  readonly status?: number;
  readonly method?: string;
  readonly path?: string;

  constructor(error: unknown) {
    const failure = error && typeof error === "object"
      ? error as DiscordHttpFailure
      : {};
    const status = typeof failure.status === "number" && Number.isInteger(failure.status)
      ? failure.status
      : undefined;
    const method = typeof failure.method === "string" ? failure.method : undefined;
    const path = safePath(failure.url);
    const message = status === 403
      ? "Discord rejected the member-list request (HTTP 403). Enable the Server Members intent for the Discord application and verify the bot can access this server."
      : status === 429
        ? "Discord rate-limited the member-list request (HTTP 429). The next scheduled synchronization will retry."
        : status !== undefined && status >= 500
          ? `Discord member-list service returned HTTP ${status}. The next scheduled synchronization will retry.`
          : `Discord member-list request failed${status === undefined ? "" : ` (HTTP ${status})`}.`;
    super(message);
    this.name = "GuildMemberListError";
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

/** REST pagination uses discord.js's rate-limit queue instead of Gateway chunks. */
export function fetchGuildMembers(guild: Guild): Promise<Collection<string, GuildMember>> {
  const pending = requests.get(guild);
  if (pending) return pending;
  const request = (async () => {
    const members = new Collection<string, GuildMember>();
    let after: string | undefined;
    while (true) {
      let page;
      try {
        page = await guild.members.list({ limit: 1000, ...(after ? { after } : {}) });
      } catch (error) {
        throw new GuildMemberListError(error);
      }
      for (const [id, member] of page) members.set(id, member);
      if (page.size < 1000) return members;
      const next = page.lastKey();
      if (!next || next === after) throw new Error("Discord member pagination did not advance.");
      after = next;
    }
  })();
  requests.set(guild, request);
  void request.then(
    () => requests.delete(guild),
    () => requests.delete(guild),
  );
  return request;
}
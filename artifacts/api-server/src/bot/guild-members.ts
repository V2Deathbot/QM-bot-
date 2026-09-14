import { Collection, type Guild, type GuildMember } from "discord.js";

const requests = new WeakMap<Guild, Promise<Collection<string, GuildMember>>>();

/** REST pagination uses discord.js's rate-limit queue instead of Gateway chunks. */
export function fetchGuildMembers(guild: Guild): Promise<Collection<string, GuildMember>> {
  const pending = requests.get(guild);
  if (pending) return pending;
  const request = (async () => {
    const members = new Collection<string, GuildMember>();
    let after: string | undefined;
    while (true) {
      const page = await guild.members.list({ limit: 1000, ...(after ? { after } : {}) });
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
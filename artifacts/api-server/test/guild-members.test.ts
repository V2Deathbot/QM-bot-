import assert from "node:assert/strict";
import { test } from "node:test";
import { Collection, type Guild } from "discord.js";
import {
  fetchGuildMembers,
  GuildMemberListError,
} from "../src/bot/guild-members.ts";

test("member scans paginate through REST and share in-flight requests", async () => {
  const calls: unknown[] = [];
  const first = new Collection(Array.from({ length: 1000 }, (_, i) => [String(i + 1), { id: String(i + 1) }]));
  const last = new Collection([["1001", { id: "1001" }]]);
  const guild = {
    members: {
      fetch: () => { throw new Error("Gateway bulk fetch must not be used"); },
      list: async (options: { after?: string }) => {
        calls.push(options);
        return options.after ? last : first;
      },
    },
  } as unknown as Guild;
  const [a, b] = await Promise.all([fetchGuildMembers(guild), fetchGuildMembers(guild)]);
  assert.equal(a, b);
  assert.equal(a.size, 1001);
  assert.deepEqual(calls, [{ limit: 1000 }, { limit: 1000, after: "1000" }]);
  await fetchGuildMembers(guild);
  assert.equal(calls.length, 4, "later scans refresh rather than using stale member lists");
});

test("failed member requests reject explicitly and can be retried", async () => {
  let attempts = 0;
  const guild = {
    members: {
      list: async () => {
        if (++attempts === 1) throw new Error("Discord unavailable");
        return new Collection();
      },
    },
  } as unknown as Guild;
  await assert.rejects(fetchGuildMembers(guild), /member-list request failed/i);
  assert.equal((await fetchGuildMembers(guild)).size, 0);
  assert.equal(attempts, 2);
});

test("turns Discord member-list HTTP failures into actionable safe errors", async () => {
  const guild = {
    members: {
      list: async () => {
        throw Object.assign(new Error("Forbidden"), {
          name: "HTTPError",
          status: 403,
          method: "GET",
          url: "https://discord.com/api/v10/guilds/123/members?limit=1000",
        });
      },
    },
  } as unknown as Guild;

  await assert.rejects(
    fetchGuildMembers(guild),
    (error: unknown) => {
      assert.ok(error instanceof GuildMemberListError);
      assert.equal(error.status, 403);
      assert.equal(error.method, "GET");
      assert.equal(error.path, "/api/v10/guilds/123/members");
      assert.match(error.message, /Server Members intent/i);
      assert.doesNotMatch(error.message, /discord\.com|123/);
      return true;
    },
  );
});
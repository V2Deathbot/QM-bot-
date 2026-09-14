import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildBlacklistIndex,
  parseBlacklistTitle,
  type BlacklistIndexCard,
} from "../src/bot/blacklist-index.ts";
import {
  RobloxUserNotFoundError,
  type RobloxUser,
} from "../src/bot/roblox.ts";

function card(
  id: string,
  name: string,
  listType: BlacklistIndexCard["listType"],
  dateLastActivity?: string,
  closed = false,
): BlacklistIndexCard {
  return {
    id,
    name,
    desc: "",
    idList: `list-${listType ?? "other"}`,
    idLabels: [],
    url: `https://trello.test/${id}`,
    dateLastActivity: dateLastActivity ?? "2025-01-01T00:00:00.000Z",
    closed,
    listType,
  };
}

function lookup(users: Record<number, RobloxUser>) {
  const calls: number[] = [];
  const callback = async (id: number): Promise<RobloxUser> => {
    calls.push(id);
    const user = users[id];
    if (!user) throw new RobloxUserNotFoundError();
    return user;
  };
  return { callback, calls };
}

test("classifies active and revoked cards and reconciles renamed users", async () => {
  const { callback, calls } = lookup({
    10: { id: 10, name: "CurrentName", displayName: "CurrentName" },
    20: { id: 20, name: "StillName", displayName: "StillName" },
  });
  const result = await buildBlacklistIndex(
    [
      card("active", " OldName  |  10 ", "appealable"),
      card("revoked", "StillName | 20", "revoked"),
    ],
    callback,
  );

  assert.deepEqual(calls, [10, 20]);
  assert.deepEqual(result.active.map(({ robloxId, username }) => [robloxId, username]), [
    [10, "CurrentName"],
  ]);
  assert.deepEqual(result.revoked.map(({ robloxId }) => [robloxId]), [[20]]);
  assert.deepEqual(result.issues.map(({ code }) => code), ["renamed_username"]);
  assert.equal(result.active[0]?.card.name, " OldName  |  10 ");
});

test("reports malformed titles, invalid ids, and unknown ids without aborting", async () => {
  const { callback } = lookup({
    30: { id: 30, name: "Known", displayName: "Known" },
  });
  const result = await buildBlacklistIndex(
    [
      card("malformed", "not a canonical title", "permanent"),
      card("zero", "Zero | 0", "permanent"),
      card("unsafe", `Unsafe | ${Number.MAX_SAFE_INTEGER + 1}`, "permanent"),
      card("unknown", "Unknown | 999", "permanent"),
      card("valid", "Known | 30", "permanent"),
    ],
    callback,
  );

  assert.deepEqual(
    result.issues.map(({ code, cardId }) => [code, cardId]),
    [
      ["malformed_title", "malformed"],
      ["unknown_roblox_id", "unknown"],
      ["invalid_roblox_id", "unsafe"],
      ["invalid_roblox_id", "zero"],
    ],
  );
  assert.deepEqual(result.active.map(({ robloxId }) => robloxId), [30]);
});

test("uses latest activity, revoked timestamp ties, and card id tie breaks", async () => {
  const { callback } = lookup({
    40: { id: 40, name: "User", displayName: "User" },
    41: { id: 41, name: "Other", displayName: "Other" },
  });
  const result = await buildBlacklistIndex(
    [
      card("old", "User | 40", "permanent", "2025-01-01T00:00:00.000Z"),
      card("latest", "User | 40", "appealable", "2025-02-01T00:00:00.000Z"),
      card("active-tie", "Other | 41", "permanent", "2025-03-01T00:00:00.000Z"),
      card("revoked-tie", "Other | 41", "revoked", "2025-03-01T00:00:00.000Z"),
      card("z-card", "User | 40", "revoked", "2025-02-01T00:00:00.000Z"),
      card("a-card", "User | 40", "revoked", "2025-02-01T00:00:00.000Z"),
    ],
    callback,
  );

  assert.deepEqual(result.active.map(({ card: selected }) => selected.id), []);
  assert.deepEqual(
    result.revoked.map(({ card: selected, robloxId }) => [robloxId, selected.id]),
    [
      [40, "a-card"],
      [41, "revoked-tie"],
    ],
  );
});

test("excludes group and closed cards and accepts whitespace around titles", async () => {
  const parsed = parseBlacklistTitle("  Name   |   55  ");
  assert.deepEqual(parsed, {
    ok: true,
    value: { username: "Name", robloxId: 55 },
  });

  const { callback } = lookup({
    55: { id: 55, name: "Name", displayName: "Name" },
  });
  const result = await buildBlacklistIndex(
    [
      card("group", "Name | 55", undefined),
      card("closed", "Name | 55", "permanent", undefined, true),
      card("included", "Name | 55", "permanent"),
    ],
    callback,
  );

  assert.deepEqual(result.active.map(({ card: selected }) => selected.id), [
    "included",
  ]);
});

test("produces repeatable output independent of provider card order", async () => {
  const users = {
    60: { id: 60, name: "User", displayName: "User" },
  };
  const { callback } = lookup(users);
  const cards = [
    card("b", "User | 60", "permanent", "2025-01-01T00:00:00.000Z"),
    card("a", "User | 60", "permanent", "2025-01-01T00:00:00.000Z"),
  ];
  const first = await buildBlacklistIndex(cards, callback);
  const second = await buildBlacklistIndex([...cards].reverse(), callback);
  assert.deepEqual(second, first);
});

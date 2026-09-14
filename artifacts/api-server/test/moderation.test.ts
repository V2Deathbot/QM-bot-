import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Collection } from "discord.js";

const snapshotDirectory = await mkdtemp(
  path.join(os.tmpdir(), "blacklist-bot-tests-"),
);
const snapshotFile = path.join(snapshotDirectory, "role-snapshots.json");

process.env.NODE_ENV = "production";
process.env.ROLE_SNAPSHOT_FILE = snapshotFile;
process.env.TRELLO_API_KEY = "test-key";
process.env.TRELLO_TOKEN = "test-token";
process.env.TRELLO_BOARD_ID = "test-board";
process.env.TRELLO_LIST_REVOKED = "Revoked Blacklist";

const { findActiveSnapshot, revokeRoleSnapshot, saveRoleSnapshot } =
  await import("../src/bot/role-store.ts");
const { revokeBlacklistCard } = await import("../src/bot/trello.ts");
const { handleBlacklist } = await import("../src/bot/index.ts");

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestPath(input: RequestInfo | URL): string {
  return new URL(input.toString()).pathname;
}

test("persists snapshots and only considers matching active snapshots restorable", async () => {
  const snapshot = {
    key: "guild-1:roblox-1",
    guildId: "guild-1",
    discordUserId: "discord-1",
    robloxUserId: 1,
    robloxUsername: "Builder",
    roleIds: ["role-1", "role-2"],
    status: "active" as const,
    createdAt: "2026-09-14T00:00:00.000Z",
  };

  await saveRoleSnapshot(snapshot);

  assert.deepEqual(await findActiveSnapshot("guild-1", 1), snapshot);
  assert.equal(await findActiveSnapshot("other-guild", 1), undefined);
  assert.equal(await findActiveSnapshot("guild-1", 2), undefined);

  const persisted = JSON.parse(await readFile(snapshotFile, "utf8")) as {
    snapshots: (typeof snapshot)[];
  };
  assert.deepEqual(persisted.snapshots, [snapshot]);

  const revoked = await revokeRoleSnapshot(snapshot.key);
  assert.equal(revoked?.status, "revoked");
  assert.equal(await findActiveSnapshot("guild-1", 1), undefined);

  const persistedAfterRevoke = JSON.parse(
    await readFile(snapshotFile, "utf8"),
  ) as { snapshots: (typeof snapshot)[] };
  assert.equal(persistedAfterRevoke.snapshots[0]?.status, "revoked");
  assert.match(
    (
      persistedAfterRevoke.snapshots[0] as typeof snapshot & {
        revokedAt?: string;
      }
    ).revokedAt ?? "",
    /^\d{4}-\d{2}-\d{2}T/,
  );
});

test("moves a Trello blacklist card to revoked and updates its labels", async () => {
  const requests: Array<{
    path: string;
    method: string;
    body?: URLSearchParams;
  }> = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const pathname = requestPath(input);
    const method = init?.method ?? "GET";
    requests.push({
      path: pathname,
      method,
      body: init?.body instanceof URLSearchParams ? init.body : undefined,
    });

    if (pathname.endsWith("/lists")) {
      return jsonResponse([
        { id: "list-blacklist", name: "Appealable Blacklist" },
        { id: "list-revoked", name: "Revoked Blacklist" },
      ]);
    }
    if (pathname === "/1/cards/card-1") {
      return jsonResponse({ id: "card-1", idList: "list-revoked" });
    }
    if (pathname.endsWith("/labels")) {
      return jsonResponse([
        { id: "label-appealable", name: "Appealable", color: "orange" },
        { id: "label-revoked", name: "revoked", color: "green" },
      ]);
    }
    if (pathname === "/1/cards/card-1/idLabels/label-appealable") {
      return jsonResponse(undefined);
    }
    if (pathname === "/1/cards/card-1/idLabels") {
      return jsonResponse(undefined);
    }

    throw new Error(`Unexpected Trello request: ${method} ${pathname}`);
  };

  try {
    const card = await revokeBlacklistCard({
      id: "card-1",
      name: "Builder | 1",
      desc: "- policy",
      idList: "list-blacklist",
      idLabels: ["label-appealable"],
      url: "https://trello.test/card-1",
    });

    assert.equal(card.idList, "list-revoked");
    assert.deepEqual(
      requests.map(({ path: pathname, method }) => `${method} ${pathname}`),
      [
        "GET /1/boards/test-board/lists",
        "PUT /1/cards/card-1",
        "GET /1/boards/test-board/labels",
        "DELETE /1/cards/card-1/idLabels/label-appealable",
        "GET /1/boards/test-board/labels",
        "POST /1/cards/card-1/idLabels",
      ],
    );
    assert.equal(requests[1]?.body?.get("idList"), "list-revoked");
    assert.equal(requests[5]?.body?.get("value"), "label-revoked");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("restores removed roles when Trello blacklist card creation fails", async () => {
  const removed: string[][] = [];
  const added: string[][] = [];
  const roles = new Collection([
    ["role-1", { id: "role-1", managed: false, position: 1 }],
    ["role-2", { id: "role-2", managed: false, position: 2 }],
  ]);
  const botHighestRole = { position: 10 };
  const guild = {
    id: "guild-failure",
    roles: { cache: roles },
    members: {
      fetch: async (userId: string) => member,
      me: { roles: { highest: botHighestRole } },
    },
  };
  const member = {
    id: "discord-failure",
    guild,
    roles: {
      cache: roles,
      remove: async (roleIds: string[]) => {
        removed.push(roleIds);
      },
      add: async (roleIds: string[]) => {
        added.push(roleIds);
      },
    },
    send: async () => undefined,
  };
  const interaction = {
    guild,
    options: {
      getString: (name: string) => {
        const values = {
          user: "Builder",
          type: "appealable",
          reason: "policy violation",
        };
        return values[name as keyof typeof values];
      },
      getUser: () => ({ id: member.id }),
    },
    editReply: async () => undefined,
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const pathname = requestPath(input);
    if (pathname === "/v1/usernames/users") {
      return jsonResponse({
        data: [{ id: 42, name: "Builder", displayName: "Builder" }],
      });
    }
    if (pathname.endsWith("/lists")) {
      return jsonResponse({ error: "Trello unavailable" }, 503);
    }
    throw new Error(`Unexpected request while creating card: ${pathname}`);
  };

  try {
    await assert.rejects(
      handleBlacklist(interaction as never),
      /Trello request failed \(503\)/,
    );
    assert.deepEqual(removed, [["role-1", "role-2"]]);
    assert.deepEqual(added, [["role-1", "role-2"]]);

    const snapshot = await findActiveSnapshot("guild-failure", 42);
    assert.deepEqual(snapshot?.roleIds, ["role-1", "role-2"]);
    assert.equal(snapshot?.status, "active");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

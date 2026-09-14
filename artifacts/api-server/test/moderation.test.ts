import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
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

const { config } = await import("../src/bot/config.ts");
const { findActiveSnapshot, revokeRoleSnapshot, saveRoleSnapshot } =
  await import("../src/bot/role-store.ts");
const { checkTrelloReadiness, revokeBlacklistCard } =
  await import("../src/bot/trello.ts");
const { getBotStatus, handleBlacklist, refreshBot } =
  await import("../src/bot/index.ts");
const { default: app } = await import("../src/app.ts");

type MutableTrelloConfig = {
  discordToken: string | undefined;
  trelloApiKey: string | undefined;
  trelloToken: string | undefined;
  trelloBoardId: string | undefined;
  trelloRetryBaseDelayMs: number;
  trelloRetryMaxDelayMs: number;
};

const mutableTrelloConfig = config as unknown as MutableTrelloConfig;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestPath(input: RequestInfo | URL): string {
  return new URL(input.toString()).pathname;
}

async function requestBotStatus(): Promise<{
  statusCode: number;
  body: Record<string, unknown>;
  raw: string;
}> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The test server did not expose a TCP address.");
  }

  try {
    const response = await new Promise<{ statusCode: number; raw: string }>(
      (resolve, reject) => {
        const request = httpRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/api/bot/status",
            method: "GET",
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                statusCode: response.statusCode ?? 0,
                raw: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        request.on("error", reject);
        request.end();
      },
    );

    return {
      ...response,
      body: JSON.parse(response.raw) as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function restoreTrelloConfig(previous: MutableTrelloConfig): void {
  Object.assign(mutableTrelloConfig, previous);
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

test("reports Trello readiness when every configured list is available", async () => {
  const configuredListNames = [...new Set(Object.values(config.trelloListNames))];
  const requests: {
    url: string;
    method: string | undefined;
    body: BodyInit | null | undefined;
  }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: input.toString(),
      method: init?.method,
      body: init?.body,
    });
    return jsonResponse(
      configuredListNames.map((name, index) => ({ id: `list-${index}`, name })),
    );
  };

  try {
    const ready = await checkTrelloReadiness();
    assert.equal(ready.status, "ready");
    assert.equal(ready.ready, true);
    assert.deepEqual(ready.missingLists, []);
    assert.equal(requests.length, 1);
    assert.equal(requestPath(requests[0]!.url), "/1/boards/test-board/lists");
    assert.equal(new URL(requests[0]!.url).searchParams.get("filter"), "open");
    assert.equal(requests[0]!.method, undefined);
    assert.equal(requests[0]!.body, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports the exact missing Trello lists with actionable status details", async () => {
  const configuredListNames = [...new Set(Object.values(config.trelloListNames))];
  const missingLists = configuredListNames.slice(1);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, undefined);
    assert.equal(init?.body, undefined);
    assert.equal(requestPath(input), "/1/boards/test-board/lists");
    return jsonResponse([
      { id: "list-present", name: configuredListNames[0] },
    ]);
  };

  try {
    const status = await requestBotStatus();
    const trello = status.body.trello as {
      ready: boolean;
      status: string;
      missingLists: string[];
      error: string | null;
    };

    assert.equal(status.statusCode, 200);
    assert.equal(trello.ready, false);
    assert.equal(trello.status, "missing_lists");
    assert.deepEqual(trello.missingLists, missingLists);
    assert.match(trello.error ?? "", /Create or rename them, then refresh the bot/);
    assert.match(status.raw, new RegExp(missingLists.join("|")));
    assert.doesNotMatch(status.raw, /test-key|test-token/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports an unconfigured Trello integration without probing the API", async () => {
  const previousConfig = { ...mutableTrelloConfig };
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  Object.assign(mutableTrelloConfig, { trelloApiKey: undefined });
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("The Trello API should not be called when unconfigured.");
  };

  try {
    const readiness = await checkTrelloReadiness();
    assert.equal(readiness.ready, false);
    assert.equal(readiness.status, "not_configured");
    assert.deepEqual(readiness.missingLists, []);
    assert.match(readiness.error ?? "", /TRELLO_API_KEY/);
    assert.equal(fetchCalled, false);
    assert.doesNotMatch(readiness.error ?? "", /test-key|test-token/);
  } finally {
    restoreTrelloConfig(previousConfig);
    globalThis.fetch = originalFetch;
  }
});

test("reports Trello outages without exposing credentials", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, undefined);
    assert.equal(init?.body, undefined);
    assert.equal(requestPath(input), "/1/boards/test-board/lists");
    return jsonResponse({ error: "temporary Trello outage" }, 503);
  };

  try {
    const readiness = await checkTrelloReadiness();
    assert.equal(readiness.ready, false);
    assert.equal(readiness.status, "unavailable");
    assert.deepEqual(readiness.missingLists, []);
    assert.match(readiness.error ?? "", /Check the configured board and Trello access/);
    assert.doesNotMatch(readiness.error ?? "", /test-key|test-token/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps moderation commands disabled while Trello setup is incomplete", async () => {
  const configuredListNames = [...new Set(Object.values(config.trelloListNames))];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse([{ id: "list-present", name: configuredListNames[0] }]);

  try {
    const result = await refreshBot();
    assert.equal(result.commandsEnabled, false);
    assert.equal(result.trelloReady, false);
    assert.equal(result.trello.status, "missing_lists");
    assert.equal(result.recoveryStatus, "blocked");
    assert.match(result.error ?? "", /Create or rename them, then refresh the bot/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("shows the next automatic Trello retry in bot status", async () => {
  const previousConfig = { ...mutableTrelloConfig };
  const originalFetch = globalThis.fetch;
  Object.assign(mutableTrelloConfig, {
    trelloRetryBaseDelayMs: 60_000,
    trelloRetryMaxDelayMs: 120_000,
  });
  globalThis.fetch = async () =>
    jsonResponse({ error: "Trello temporarily unavailable" }, 503);

  try {
    const result = await refreshBot();
    const response = await requestBotStatus();
    const recovery = response.body.recovery as {
      retryCount: number;
      nextRetryAt: string | null;
      lastRetryAt: string | null;
      lastRetryOutcome: string | null;
    };
    const retryScheduledFor = Date.parse(recovery.nextRetryAt ?? "");

    assert.equal(result.trello.status, "unavailable");
    assert.equal(response.statusCode, 200);
    assert.equal(recovery.retryCount, 1);
    assert.equal(recovery.lastRetryAt, null);
    assert.equal(recovery.lastRetryOutcome, null);
    assert.ok(retryScheduledFor > Date.now());
    assert.ok(retryScheduledFor <= Date.now() + 120_000);
  } finally {
    Object.assign(mutableTrelloConfig, { trelloApiKey: undefined });
    await refreshBot();
    restoreTrelloConfig(previousConfig);
    globalThis.fetch = originalFetch;
  }
});

test("automatically retries Trello readiness and resets backoff after recovery", async () => {
  const previousConfig = { ...mutableTrelloConfig };
  const originalFetch = globalThis.fetch;
  const configuredListNames = [...new Set(Object.values(config.trelloListNames))];
  let requestCount = 0;
  Object.assign(mutableTrelloConfig, {
    discordToken: undefined,
    trelloRetryBaseDelayMs: 5,
    trelloRetryMaxDelayMs: 5,
  });
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return jsonResponse({ error: "Trello temporarily unavailable" }, 503);
    }
    return jsonResponse(
      configuredListNames.map((name, index) => ({ id: `list-${index}`, name })),
    );
  };

  try {
    await refreshBot();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const status = getBotStatus();
    assert.equal(requestCount, 2);
    assert.equal(status.recovery.retryCount, 0);
    assert.equal(status.recovery.nextRetryAt, null);
    assert.equal(status.recovery.lastRetryOutcome, "successful");
    assert.ok(status.recovery.lastRetryAt);
  } finally {
    await refreshBot();
    restoreTrelloConfig(previousConfig);
    globalThis.fetch = originalFetch;
  }
});

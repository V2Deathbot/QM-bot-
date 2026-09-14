import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChannelType,
  Client,
  Collection,
  Events,
  GuildManager,
  PermissionFlagsBits,
} from "discord.js";

const snapshotDirectory = await mkdtemp(
  path.join(os.tmpdir(), "blacklist-bot-tests-"),
);
const snapshotFile = path.join(snapshotDirectory, "role-snapshots.json");
const setupFile = path.join(snapshotDirectory, "guild-settings.json");

process.env.NODE_ENV = "production";
process.env.ROLE_SNAPSHOT_FILE = snapshotFile;
process.env.BOT_SETUP_FILE = setupFile;
process.env.TRELLO_API_KEY = "test-key";
process.env.TRELLO_TOKEN = "test-token";
process.env.TRELLO_BOARD_ID = "test-board";
process.env.TRELLO_LIST_REVOKED = "Revoked Blacklist";

const { config } = await import("../src/bot/config.ts");
const { findActiveSnapshot, revokeRoleSnapshot, saveRoleSnapshot } =
  await import("../src/bot/role-store.ts");
const { getGuildSetup, saveGuildSetup } =
  await import("../src/bot/setup-store.ts");
const { requireAuditChannel, sendAuditEvent } =
  await import("../src/bot/audit.ts");
const { checkTrelloReadiness, createBlacklistCard, validateTrelloMappings, revokeBlacklistCard } =
  await import("../src/bot/trello.ts");
const {
  canUseModerationCommands,
  getBotStatus,
  handleBlacklist,
  handleSetup,
  refreshBot,
} =
  await import("../src/bot/index.ts");
const { default: app } = await import("../src/app.ts");

type MutableTrelloConfig = {
  discordGuildId: string | undefined;
  discordToken: string | undefined;
  trelloApiKey: string | undefined;
  trelloToken: string | undefined;
  trelloBoardId: string | undefined;
  trelloRetryBaseDelayMs: number;
  trelloRetryMaxDelayMs: number;
  setupFile: string;
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

async function requestBotEndpoint(
  method: "GET" | "POST",
  path: string,
): Promise<{
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
            path,
            method,
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

async function requestBotStatus() {
  return requestBotEndpoint("GET", "/api/bot/status");
}

async function requestBotRefresh() {
  const result = await refreshBot();
  return {
    statusCode: result.commandsEnabled ? 200 : 503,
    body: result as unknown as Record<string, unknown>,
    raw: JSON.stringify(result),
  };
}

function restoreTrelloConfig(previous: MutableTrelloConfig): void {
  Object.assign(mutableTrelloConfig, previous);
}

test("does not expose unauthenticated bot refresh mutation", async () => {
  const response = await requestBotEndpoint("POST", "/api/bot/refresh");
  assert.equal(response.statusCode, 403);
  assert.match(String(response.body.error), /disabled/i);
});

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

test("persists and safely updates guild setup", async () => {
  const initial = {
    guildId: "guild-settings",
    moderatorRoleId: "role-1",
    auditChannelId: "12345",
    updatedBy: "owner-1",
    updatedAt: "2026-09-14T00:00:00.000Z",
  };
  await saveGuildSetup(initial);
  assert.deepEqual(await getGuildSetup(initial.guildId), initial);

  const updated = {
    ...initial,
    moderatorRoleId: "role-2",
    auditChannelId: "67890",
    updatedAt: "2026-09-14T01:00:00.000Z",
  };
  await saveGuildSetup(updated);
  assert.deepEqual(await getGuildSetup(initial.guildId), updated);

  const persisted = JSON.parse(await readFile(setupFile, "utf8")) as {
    guilds: typeof updated[];
  };
  assert.equal(
    persisted.guilds.filter((setup) => setup.guildId === initial.guildId)
      .length,
    1,
  );
});

test("validates and persists all per-guild Trello list and label mappings", async () => {
  const mappings = {
    lists: {
      appealable: "Appeals",
      conditional: "Conditions",
      permanent: "Permanents",
      group: "Groups",
      revoked: "Revocations",
    },
    labels: {
      blacklisted: "BLACKLISTED",
      appealable: "APPEALABLE",
      conditional: "CONDITIONAL",
      permanent: "PERMANENT",
      group: "GROUP BLACKLIST",
      revoked: "REVOKED",
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const pathname = requestPath(input);
    if (pathname.endsWith("/lists")) {
      return jsonResponse(Object.values(mappings.lists).map((name, index) => ({ id: `list-${index}`, name })));
    }
    if (pathname.endsWith("/labels")) {
      return jsonResponse(Object.values(mappings.labels).map((name, index) => ({ id: `label-${index}`, name, color: "blue" })));
    }
    if (pathname === "/1/cards" && init?.method === "POST") {
      assert.equal((init.body as URLSearchParams).get("idList"), "list-2");
      return jsonResponse({ id: "card-custom", url: "https://trello.test/card-custom" });
    }
    if (pathname === "/1/cards/card-custom/idLabels") return jsonResponse(undefined);
    throw new Error(`Unexpected custom mapping request: ${pathname}`);
  };
  try {
    await validateTrelloMappings(mappings);
    await saveGuildSetup({
      guildId: "mapping-guild", moderatorRoleId: "legacy", auditChannelId: "12345",
      trello: mappings, updatedBy: "owner", updatedAt: new Date().toISOString(),
    });
    assert.deepEqual((await getGuildSetup("mapping-guild"))?.trello, mappings);
    await createBlacklistCard({ name: "Builder | 9", reason: "policy", type: "permanent", mappings });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requires a current Administrator permission while recognizing server owner", async () => {
  let highestPosition = 4;
  let administrator = false;
  const member = {
    id: "moderator",
    permissions: {
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.Administrator && administrator,
    },
    roles: { highest: { position: highestPosition } },
  };
  const guild = {
    id: "guild-permissions",
    ownerId: "owner",
    members: {
      fetch: async () => ({
        ...member,
        roles: { highest: { position: highestPosition } },
      }),
    },
    roles: {
      fetch: async () => ({ id: "moderator-role", position: 5 }),
    },
  };
  const interaction = {
    guild,
    user: { id: member.id },
  };
  const setup = {
    guildId: guild.id,
    moderatorRoleId: "moderator-role",
    auditChannelId: "12345",
    updatedBy: "owner",
    updatedAt: new Date().toISOString(),
  };

  highestPosition = 5;
  assert.equal(
    await canUseModerationCommands(interaction as never, setup),
    false,
  );
  highestPosition = 4;
  administrator = true;
  assert.equal(
    await canUseModerationCommands(interaction as never, setup),
    true,
  );
  guild.ownerId = member.id;
  administrator = false;
  assert.equal(
    await canUseModerationCommands(interaction as never, setup),
    true,
  );
});

test("validates audit channels and redacts credentials from audit messages", async () => {
  const sent: unknown[] = [];
  let channelType = ChannelType.GuildText;
  let allowed = true;
  const channel = {
    type: channelType,
    permissionsFor: () => ({ has: () => allowed }),
    send: async (payload: unknown) => {
      sent.push(payload);
    },
  };
  const guild = {
    id: "guild-audit",
    members: { me: { id: "bot" } },
    channels: {
      fetch: async () => ({ ...channel, type: channelType }),
    },
  };
  const setup = {
    guildId: guild.id,
    moderatorRoleId: "role-audit",
    auditChannelId: "12345",
    updatedBy: "owner",
    updatedAt: new Date().toISOString(),
  };

  await sendAuditEvent(guild as never, setup, {
    action: "Moderation command failed",
    status: "failed",
    actorId: "moderator",
    fields: [
      {
        name: "Sensitive provider response",
        value: `key=${config.trelloApiKey}&token=${config.trelloToken}`,
      },
    ],
  });
  const serialized = JSON.stringify(sent);
  assert.match(serialized, /\[redacted\]/);
  assert.doesNotMatch(serialized, /test-key|test-token/);

  allowed = false;
  await assert.rejects(
    requireAuditChannel(guild as never, setup),
    /cannot view, send messages, and embed links/,
  );
  allowed = true;
  channelType = ChannelType.GuildVoice;
  await assert.rejects(
    requireAuditChannel(guild as never, setup),
    /missing or is not a text channel/,
  );
});

test("setup persists settings, audits the change, and enables moderation commands", async () => {
  const auditMessages: unknown[] = [];
  const registeredCommandNames: string[][] = [];
  const replies: string[] = [];
  const guild = {
    id: "guild-setup-command",
    ownerId: "owner-setup",
    members: {
      me: {
        permissions: { has: () => true },
        roles: { highest: { position: 10 } },
      },
      fetch: async () => ({
        id: "owner-setup",
        permissions: { has: () => false },
      }),
    },
    roles: {
      fetch: async () => role,
    },
    channels: {
      fetch: async () => ({
        type: ChannelType.GuildText,
        permissionsFor: () => ({ has: () => true }),
        send: async (payload: unknown) => {
          auditMessages.push(payload);
        },
      }),
    },
    commands: {
      set: async (commandData: Array<{ name: string }>) => {
        registeredCommandNames.push(commandData.map((command) => command.name));
      },
    },
  };
  const role = {
    id: "role-setup",
    name: "Moderators",
    managed: false,
    position: 5,
    guild,
  };
  const interaction = {
    guild,
    user: { id: "owner-setup" },
    options: {
      getRole: () => role,
      getString: () => "12345678901234567",
    },
    editReply: async (reply: string) => {
      replies.push(reply);
    },
  };

  await handleSetup(interaction as never);

  const saved = await getGuildSetup(guild.id);
  assert.equal(saved?.moderatorRoleId, role.id);
  assert.equal(saved?.auditChannelId, "12345678901234567");
  assert.equal(auditMessages.length, 1);
  assert.deepEqual(registeredCommandNames, [
    ["settings", "blacklist", "revoke_blacklist", "blacklist_lookup"],
  ]);
  assert.match(replies[0] ?? "", /Setup complete/);
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
      return jsonResponse({
        id: "card-1",
        name: "Builder | 1",
        desc: "- policy",
        idList: "list-blacklist",
        idLabels: ["label-appealable"],
        url: "https://trello.test/card-1",
        dateLastActivity: "2026-01-01T00:00:00.000Z",
        closed: false,
      });
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
        "GET /1/cards/card-1",
        "GET /1/boards/test-board/lists",
        "PUT /1/cards/card-1",
        "GET /1/boards/test-board/labels",
        "DELETE /1/cards/card-1/idLabels/label-appealable",
        "GET /1/boards/test-board/labels",
        "POST /1/cards/card-1/idLabels",
      ],
    );
    assert.equal(requests[2]?.body?.get("idList"), "list-revoked");
    assert.equal(requests[6]?.body?.get("value"), "label-revoked");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not change roles or leave a snapshot when Trello card creation fails", async () => {
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
    assert.deepEqual(removed, []);
    assert.deepEqual(added, []);

    const snapshot = await findActiveSnapshot("guild-failure", 42);
    assert.equal(snapshot, undefined);
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

test("keeps commands disabled after registration failure and enables them on retry", async () => {
  const previousConfig = { ...mutableTrelloConfig };
  const originalFetch = globalThis.fetch;
  const originalLogin = Client.prototype.login;
  const originalGuildFetch = GuildManager.prototype.fetch;
  const configuredListNames = [...new Set(Object.values(config.trelloListNames))];
  let trelloReady = false;
  let registrationAttempts = 0;
  const registeredCommandNames: string[][] = [];

  Object.assign(mutableTrelloConfig, {
    discordGuildId: "test-guild",
    discordToken: "test-discord-token",
  });
  globalThis.fetch = async () =>
    jsonResponse(
      trelloReady
        ? configuredListNames.map((name, index) => ({
            id: `list-${index}`,
            name,
          }))
        : [{ id: "list-present", name: configuredListNames[0] }],
    );
  (Client.prototype as unknown as {
    login: (token?: string) => Promise<string>;
  }).login = async function (this: Client) {
    (this as unknown as { user: { tag: string } }).user = {
      tag: "test-bot#0000",
    };
    this.emit(Events.ClientReady, this);
    return "test-discord-token";
  };
  const fakeGuild = {
    id: "test-guild",
    members: {
      me: {
        permissions: { has: () => true },
        roles: { highest: { position: 10 } },
      },
    },
    roles: {
      fetch: async () => moderatorRole,
    },
    channels: {
      fetch: async () => ({
        type: ChannelType.GuildText,
        permissionsFor: () => ({ has: () => true }),
        send: async () => undefined,
      }),
    },
    commands: {
      set: async (commandData: Array<{ name: string }>) => {
        registrationAttempts += 1;
        registeredCommandNames.push(
          commandData.map((command) => command.name),
        );
        if (registrationAttempts === 1) {
          throw new Error("Discord command registration failed");
        }
      },
    },
  };
  const moderatorRole = {
    id: "moderator-role",
    name: "Moderators",
    managed: false,
    position: 5,
    guild: fakeGuild,
  };
  (GuildManager.prototype as unknown as {
    fetch: () => Promise<typeof fakeGuild>;
  }).fetch = async () => fakeGuild;

  try {
    const blocked = await refreshBot();
    assert.equal(blocked.trelloReady, false);
    assert.equal(blocked.commandsEnabled, false);
    assert.equal(blocked.recoveryStatus, "blocked");

    trelloReady = true;
    const failedRefresh = await requestBotRefresh();
    const failedBody = failedRefresh.body as {
      commandsEnabled: boolean;
      recoveryStatus: string;
      error: string | null;
    };
    assert.equal(failedRefresh.statusCode, 503);
    assert.equal(failedBody.commandsEnabled, false);
    assert.equal(failedBody.recoveryStatus, "blocked");
    assert.match(failedBody.error ?? "", /Discord command registration failed/);
    assert.equal(getBotStatus().commandsEnabled, false);

    const setupOnlyRefresh = await requestBotRefresh();
    const setupOnlyBody = setupOnlyRefresh.body as {
      commandsEnabled: boolean;
      setupCommandAvailable: boolean;
      recoveryStatus: string;
    };
    assert.equal(setupOnlyRefresh.statusCode, 503);
    assert.equal(setupOnlyBody.commandsEnabled, false);
    assert.equal(setupOnlyBody.setupCommandAvailable, true);
    assert.equal(setupOnlyBody.recoveryStatus, "blocked");
    assert.deepEqual(registeredCommandNames[1], ["settings"]);

    await saveGuildSetup({
      guildId: "test-guild",
      moderatorRoleId: moderatorRole.id,
      auditChannelId: "12345678901234567",
      updatedBy: "owner",
      updatedAt: new Date().toISOString(),
    });

    const successfulRefresh = await requestBotRefresh();
    const successfulBody = successfulRefresh.body as {
      commandsEnabled: boolean;
      recoveryStatus: string;
      trelloReady: boolean;
    };
    assert.equal(successfulRefresh.statusCode, 200);
    assert.equal(successfulBody.commandsEnabled, true);
    assert.equal(successfulBody.recoveryStatus, "successful");
    assert.equal(successfulBody.trelloReady, true);
    assert.equal(getBotStatus().commandsEnabled, true);
    assert.equal(registrationAttempts, 3);
    assert.deepEqual(registeredCommandNames[2], [
      "settings",
      "blacklist",
      "revoke_blacklist",
      "blacklist_lookup",
    ]);
  } finally {
    await refreshBot();
    (Client.prototype as unknown as { login: typeof originalLogin }).login =
      originalLogin;
    (
      GuildManager.prototype as unknown as {
        fetch: typeof originalGuildFetch;
      }
    ).fetch = originalGuildFetch;
    restoreTrelloConfig(previousConfig);
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

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ChannelType,
  Client,
  Collection,
  Events,
  GuildManager,
  PermissionFlagsBits,
} from "discord.js";

// These values must be in place before any bot module (and its config module)
// is imported.  This file deliberately has its own state files: security
// decisions must never leak between test runs or other test files.
const directory = await mkdtemp(path.join(os.tmpdir(), "blacklist-security-"));
process.env.NODE_ENV = "production";
process.env.DISCORD_BOT_TOKEN = "security-test-token";
process.env.DISCORD_GUILD_ID = "security-guild";
process.env.TRELLO_API_KEY = "security-test-key";
process.env.TRELLO_TOKEN = "security-test-trello-token";
process.env.TRELLO_BOARD_ID = "security-test-board";
process.env.BOT_SETUP_FILE = path.join(directory, "setup.json");
process.env.BOT_SECURITY_FILE = path.join(directory, "security.json");
process.env.ROLE_SNAPSHOT_FILE = path.join(directory, "snapshots.json");

const { config } = await import("../src/bot/config.ts");
const { saveGuildSetup } = await import("../src/bot/setup-store.ts");
const { getSecurityState, mutateSecurityState } =
  await import("../src/bot/security-store.ts");
const { findActiveSnapshot } = await import("../src/bot/role-store.ts");
const { refreshBot } = await import("../src/bot/index.ts");

type MemberRecord = {
  administrator: boolean;
  owner?: boolean;
  username?: string;
  globalName?: string;
  nickname?: string;
  roleIds?: string[];
};

type Member = {
  id: string;
  permissions: { has(permission: bigint): boolean };
  guild: object;
  roles: {
    highest: { position: number };
    cache: Collection<string, { id: string; name: string; position: number; managed: boolean }>;
    remove: () => Promise<void>;
    add: () => Promise<void>;
  };
  user: { id: string; username: string; globalName: string };
  nickname: string;
  send: () => Promise<void>;
};

const members = new Map<string, MemberRecord>();
const replies: string[] = [];
const auditEvents: unknown[] = [];
const trelloWrites: string[] = [];
const trelloCardCreations: string[] = [];
let client: Client | undefined;

function memberFor(id: string): Member {
  const record = members.get(id) ?? { administrator: false };
  const roles = new Collection(
    (record.roleIds ?? []).map((roleId) => [
      roleId,
      { id: roleId, name: roleId, position: 1, managed: false },
    ]),
  );
  return {
    id,
    guild,
    permissions: {
      has: (permission) =>
        permission === PermissionFlagsBits.Administrator && record.administrator === true,
    },
    roles: {
      highest: { position: 1 },
      cache: roles,
      remove: async () => undefined,
      add: async () => undefined,
    },
    user: {
      id,
      username: record.username ?? id,
      globalName: record.globalName ?? record.username ?? id,
    },
    nickname: record.nickname ?? record.username ?? id,
    send: async () => undefined,
  };
}

const guildRoles = new Collection<string, {
  id: string; name: string; position: number; managed: boolean;
}>();

const guild = {
  id: "security-guild",
  ownerId: "owner",
  client: { user: { id: "security-bot" } },
  members: {
    me: {
      id: "security-bot",
      permissions: { has: () => true },
      roles: { highest: { position: 100 } },
    },
    fetch: async (input?: string | { user: string; force: boolean }) => {
      const id = typeof input === "string" ? input : input?.user;
      if (id) return memberFor(id);
      return new Collection([...members.keys()].map((memberId) => [memberId, memberFor(memberId)]));
    },
    list: async () => new Collection([...members.keys()].map((memberId) => [memberId, memberFor(memberId)])),
  },
  roles: {
    cache: guildRoles,
    fetch: async (id?: string) => {
      const role = guildRoles.get(id ?? "") ?? {
        id: id ?? "moderator-role",
        name: "Moderators",
        managed: false,
        position: 2,
      };
      return { ...role, guild };
    },
  },
  channels: {
    fetch: async () => ({
      type: ChannelType.GuildText,
      permissionsFor: () => ({ has: () => true }),
      send: async (event: unknown) => {
        auditEvents.push(event);
      },
    }),
  },
  commands: { set: async () => undefined },
};

function command(
  userId: string,
  commandName: string,
  values: Record<string, string | undefined> = {},
  discordUserId?: string,
) {
  const localReplies: unknown[] = [];
  return {
    inGuild: () => true,
    isChatInputCommand: () => true,
    guild,
    guildId: guild.id,
    user: { id: userId },
    commandName,
    deferred: false,
    replied: false,
    options: {
      getString: (name: string, required?: boolean) => {
        const value = values[name];
        if (required && value === undefined) throw new Error(`missing ${name}`);
        return value ?? null;
      },
      getUser: (name: string) =>
        name === "discord_user" && discordUserId ? { id: discordUserId } : null,
      getRole: () => null,
    },
    deferReply: async () => undefined,
    editReply: async (value: unknown) => {
      localReplies.push(value);
      if (typeof value === "string") replies.push(value);
    },
    reply: async (value: { content?: string }) => {
      localReplies.push(value);
      if (value.content) replies.push(value.content);
    },
    localReplies,
  };
}

function button(userId: string, customId: string) {
  return {
    isChatInputCommand: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    customId,
    guild,
    guildId: guild.id,
    user: { id: userId },
    deferred: false,
    replied: false,
    deferUpdate: async () => undefined,
    update: async () => undefined,
    reply: async (value: { content?: string }) => {
      if (value.content) replies.push(value.content);
    },
    followUp: async (value: { content?: string }) => {
      if (value.content) replies.push(value.content);
    },
  };
}

async function settle(): Promise<void> {
  // The Discord event listener intentionally starts asynchronous command work
  // without awaiting it. A few turns lets a mocked interaction complete.
  await new Promise((resolve) => setTimeout(resolve, 15));
}

async function dispatch(interaction: ReturnType<typeof command>): Promise<void> {
  client!.emit("interactionCreate", interaction);
  await settle();
}

async function setSecurity(overrides: Record<string, unknown>): Promise<void> {
  await saveGuildSetup({
    guildId: guild.id,
    moderatorRoleId: "moderator-role",
    auditChannelId: "12345678901234567",
    security: {
      perAdminLimit: 20,
      globalLimit: 20,
      windowMinutes: 5,
      automaticLockdown: true,
      automaticLockdownThreshold: 20,
      confirmationsRequired: false,
      protectedUserIds: [],
      protectedRoleIds: [],
      altDetectionEnabled: true,
      robloxAltDetectionEnabled: true,
      historicalAssociationWarnings: true,
      recentPermissionEscalationProtection: false,
      securityAuditAlerts: true,
      ...overrides,
    },
    updatedBy: "owner",
    updatedAt: new Date().toISOString(),
  });
  await mutateSecurityState(guild.id, (state) => {
    state.lockdown = {
      active: false, automatic: false, reason: "", startedAt: null, startedBy: null,
    };
    state.destructiveActions = [];
    state.observedAdministrators = {};
  });
}

function lastConfirmationId(interaction: ReturnType<typeof command>): string {
  const payload = interaction.localReplies.find(
    (reply): reply is { components: Array<{ components: Array<{ data: { custom_id: string } }> }> } =>
      typeof reply === "object" && reply !== null && "components" in reply,
  );
  const id = payload?.components[0]?.components[0]?.data.custom_id;
  assert.ok(id?.startsWith("confirm:"), "command should produce a confirmation button");
  return id;
}

const originalLogin = Client.prototype.login;
const originalGuildFetch = GuildManager.prototype.fetch;
const originalFetch = globalThis.fetch;

// No test issues a real Discord or Trello request. The client still uses the
// production interactionCreate listener, which is the important boundary for
// these regression tests.
(Client.prototype as unknown as { login(token?: string): Promise<string> }).login =
  async function (this: Client, token?: string) {
    client = this;
    Object.defineProperty(this, "user", {
      configurable: true,
      value: {
        id: "security-bot",
        tag: "security-bot#0000",
        setPresence: async () => undefined,
      },
    });
    queueMicrotask(() => this.emit(Events.ClientReady, this));
    return token ?? "";
  };
(GuildManager.prototype as unknown as { fetch(id: string): Promise<typeof guild> }).fetch =
  async () => guild;
globalThis.fetch = async (input, init) => {
  const url = new URL(input.toString());
  if (url.pathname === "/v1/usernames/users") {
    return new Response(JSON.stringify({
      data: [{ id: 9001, name: "Builder", displayName: "Builder" }],
    }));
  }
  if (url.pathname.endsWith("/lists")) {
    return new Response(JSON.stringify(
      Object.values(config.trelloListNames).map((name, index) => ({ id: `list-${index}`, name })),
    ));
  }
  if (url.pathname === "/1/cards") {
    if ((init?.method ?? "GET") === "POST") {
      trelloWrites.push(url.pathname);
      trelloCardCreations.push(url.pathname);
      return new Response(JSON.stringify({
        id: `card-${trelloCardCreations.length}`,
        url: "https://trello.test/card",
      }));
    }
    return new Response(JSON.stringify([]));
  }
  if (url.pathname.endsWith("/labels")) {
    return new Response(JSON.stringify([
      { id: "label-blacklisted", name: "blacklisted" },
      { id: "label-appealable", name: "appealable" },
      { id: "label-conditional", name: "conditional" },
      { id: "label-permanent", name: "permanent" },
      { id: "label-group", name: "group blacklist" },
      { id: "label-revoked", name: "revoked" },
    ]));
  }
  if (url.pathname.includes("/cards") && (init?.method ?? "GET") === "POST") {
    trelloWrites.push(url.pathname);
    return new Response(JSON.stringify({ id: `card-${trelloWrites.length}`, url: "https://trello.test/card" }));
  }
  return new Response(JSON.stringify([]));
};

test.before(async () => {
  members.set("owner", { administrator: false, owner: true });
  members.set("admin-a", { administrator: true });
  members.set("admin-b", { administrator: true });
  members.set("admin-c", { administrator: true });
  members.set("moderator", { administrator: false });
  members.set("member", { administrator: false });
  members.set("setup-owner", { administrator: true });
  members.set("setup-other", { administrator: true });
  await setSecurity({});
  await refreshBot();
});

test.after(() => {
  (Client.prototype as unknown as { login: typeof originalLogin }).login = originalLogin;
  (GuildManager.prototype as unknown as { fetch: typeof originalGuildFetch }).fetch =
    originalGuildFetch;
  globalThis.fetch = originalFetch;
});

test("denies normal members and non-Administrator moderators before administrative handlers execute", async () => {
  await setSecurity({});
  const before = trelloWrites.length;
  await dispatch(command("member", "group_blacklist", { id: "123", reason: "test" }));
  await dispatch(command("moderator", "security_status"));
  assert.equal(trelloWrites.length, before);
  assert.ok(replies.some((reply) => /Only a current Discord Administrator/i.test(reply)));
});

test("allows a current Administrator through an administrative handler", async () => {
  await setSecurity({});
  const before = trelloCardCreations.length;
  await dispatch(command("admin-a", "group_blacklist", { id: "123", reason: "authorized" }));
  assert.equal(trelloCardCreations.length, before + 1);
  assert.match(replies.at(-1) ?? "", /Blacklisted group/);
});

test("enforces the per-Administrator destructive-action limit", async () => {
  await setSecurity({ perAdminLimit: 1 });
  const before = trelloCardCreations.length;
  await dispatch(command("admin-a", "group_blacklist", { id: "124", reason: "first" }));
  await dispatch(command("admin-a", "group_blacklist", { id: "125", reason: "second" }));
  assert.equal(trelloCardCreations.length, before + 1);
  assert.match(replies.at(-1) ?? "", /Blacklist rate limit reached/i);
});

test("counts multiple administrators globally, activates lockdown, and blocks later destructive commands", async () => {
  await setSecurity({
    perAdminLimit: 5, globalLimit: 2, automaticLockdownThreshold: 2,
  });
  const before = trelloCardCreations.length;
  await dispatch(command("admin-a", "group_blacklist", { id: "201", reason: "one" }));
  await dispatch(command("admin-b", "group_blacklist", { id: "202", reason: "two" }));
  assert.equal((await getSecurityState(guild.id)).lockdown.active, true);
  await dispatch(command("admin-c", "group_blacklist", { id: "203", reason: "blocked" }));
  assert.equal(trelloCardCreations.length, before + 2);
  assert.match(replies.at(-1) ?? "", /Security lockdown is active/i);
  assert.ok(auditEvents.length > 0, "security decisions are audited through the real handler");
});

test("rechecks permission when a confirmation is pressed", async () => {
  await setSecurity({ confirmationsRequired: true });
  members.set("admin-a", { administrator: true });
  const before = trelloCardCreations.length;
  const pending = command("admin-a", "group_blacklist", { id: "300", reason: "confirm" });
  await dispatch(pending);
  const confirmation = lastConfirmationId(pending);
  members.set("admin-a", { administrator: false });
  try {
    client!.emit("interactionCreate", button("admin-a", confirmation));
    await settle();
    assert.equal(trelloCardCreations.length, before);
    assert.match(replies.at(-1) ?? "", /Only a current Discord Administrator/i);
  } finally {
    members.set("admin-a", { administrator: true });
  }
});

test("server owner is authorized but remains subject to the same limit", async () => {
  await setSecurity({ perAdminLimit: 1 });
  const before = trelloCardCreations.length;
  await dispatch(command("owner", "group_blacklist", { id: "401", reason: "owner first" }));
  await dispatch(command("owner", "group_blacklist", { id: "402", reason: "owner second" }));
  assert.equal(trelloCardCreations.length, before + 1);
  assert.match(replies.at(-1) ?? "", /Blacklist rate limit reached/i);
});

test("audits an Administrator security-setting change through the setup interaction handler", async () => {
  await setSecurity({ confirmationsRequired: true });
  const beforeAudits = auditEvents.length;
  await dispatch(command("setup-owner", "setup"));
  client!.emit("interactionCreate", button("setup-owner", "setup:confirmation"));
  await settle();
  const saved = await (await import("../src/bot/setup-store.ts")).getGuildSetup(guild.id);
  assert.equal(saved?.security?.confirmationsRequired, false);
  assert.ok(auditEvents.length > beforeAudits, "configuration change must emit an audit event");
});

test("manual lockdown stops destructive handlers without stopping authorized status commands", async () => {
  await setSecurity({});
  const before = trelloCardCreations.length;
  await dispatch(command("admin-a", "security_lockdown", { reason: "incident response" }));
  assert.equal((await getSecurityState(guild.id)).lockdown.active, true);
  await dispatch(command("admin-a", "group_blacklist", { id: "450", reason: "must stop" }));
  await dispatch(command("admin-a", "security_status"));
  assert.equal(trelloCardCreations.length, before);
  assert.match(replies.at(-1) ?? "", /Security: LOCKED/i);
});

test("global-limit overflow activates and persists automatic lockdown even above its configured threshold", async () => {
  await setSecurity({
    perAdminLimit: 5,
    globalLimit: 2,
    automaticLockdownThreshold: 5,
    automaticLockdown: true,
  });
  const before = trelloCardCreations.length;
  await dispatch(command("admin-a", "group_blacklist", { id: "461", reason: "first" }));
  await dispatch(command("admin-b", "group_blacklist", { id: "462", reason: "second" }));
  await dispatch(command("admin-c", "group_blacklist", { id: "463", reason: "overflow" }));

  const locked = await getSecurityState(guild.id);
  assert.equal(trelloCardCreations.length, before + 2);
  assert.equal(locked.lockdown.active, true);
  assert.equal(locked.lockdown.automatic, true);
  assert.match(locked.lockdown.reason, /Global blacklist rate limit reached/i);

  const restarted = await import(`../src/bot/security-store.ts?global-overflow=${Date.now()}`);
  assert.equal((await restarted.getSecurityState(guild.id)).lockdown.active, true);
});

test("setup unlock always presents and requires a confirmation, even if normal confirmations are disabled", async () => {
  await setSecurity({ confirmationsRequired: false });
  await mutateSecurityState(guild.id, (state) => {
    state.lockdown = {
      active: true,
      automatic: false,
      reason: "unlock regression",
      startedAt: new Date().toISOString(),
      startedBy: "admin-a",
    };
  });
  await dispatch(command("setup-owner", "setup"));
  client!.emit("interactionCreate", button("setup-owner", "setup:unlock-now"));
  await settle();
  assert.equal(
    (await getSecurityState(guild.id)).lockdown.active,
    true,
    "opening setup unlock must not unlock the server",
  );

  client!.emit("interactionCreate", button("setup-owner", "setup:confirm-unlock"));
  await settle();
  assert.equal((await getSecurityState(guild.id)).lockdown.active, false);
});

test("a confirmation remains bound to its original member when usernames change before confirmation", async () => {
  await setSecurity({ confirmationsRequired: true });
  members.set("target-original", {
    administrator: false,
    username: "Builder",
    globalName: "Builder",
    nickname: "Builder",
  });
  const pending = command("admin-a", "blacklist", {
    user: "Builder",
    type: "appealable",
    reason: "immutable target",
  });
  await dispatch(pending);
  const confirmation = lastConfirmationId(pending);

  // The old name is now held by another member. Confirmation must act on the
  // member selected when the command was opened, not re-resolve this name.
  members.set("target-original", {
    administrator: false,
    username: "Renamed",
    globalName: "Renamed",
    nickname: "Renamed",
  });
  members.set("target-replacement", {
    administrator: false,
    username: "Builder",
    globalName: "Builder",
    nickname: "Builder",
  });
  client!.emit("interactionCreate", button("admin-a", confirmation));
  await settle();

  const snapshot = await findActiveSnapshot(guild.id, 9001);
  assert.equal(snapshot?.discordUserId, "target-original");
});

test("a target holding a configured protected role is denied before any Trello write", async () => {
  await setSecurity({
    confirmationsRequired: false,
    protectedRoleIds: ["protected-role"],
  });
  members.set("protected-target", {
    administrator: false,
    username: "Builder",
    globalName: "Builder",
    nickname: "Builder",
    roleIds: ["protected-role"],
  });
  const before = trelloCardCreations.length;
  await dispatch(command(
    "admin-a",
    "blacklist",
    { user: "Builder", type: "appealable", reason: "protected role" },
    "protected-target",
  ));
  assert.equal(trelloCardCreations.length, before);
  assert.match(replies.at(-1) ?? "", /protected by server security settings/i);
});

test("rejects setup controls clicked by another administrator and expired setup controls", async () => {
  await setSecurity({});
  const setup = command("setup-owner", "setup");
  await dispatch(setup);
  client!.emit("interactionCreate", button("setup-other", "setup:security"));
  await settle();
  assert.match(replies.at(-1) ?? "", /setup session has expired|belongs to another administrator/i);

  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60_000;
  try {
    client!.emit("interactionCreate", button("setup-owner", "setup:security"));
    await settle();
    assert.match(replies.at(-1) ?? "", /setup session has expired/i);
  } finally {
    Date.now = realNow;
  }
});

test("persists lockdown and rate actions across a fresh security-store module instance", async () => {
  await setSecurity({});
  await mutateSecurityState(guild.id, (state) => {
    state.lockdown = {
      active: true, automatic: false, reason: "restart regression",
      startedAt: new Date().toISOString(), startedBy: "admin-a",
    };
    state.destructiveActions = [{
      actorId: "admin-a", action: "group_blacklist", at: new Date().toISOString(),
    }];
  });
  const restarted = await import(`../src/bot/security-store.ts?restart=${Date.now()}`);
  const afterRestart = await restarted.getSecurityState(guild.id);
  assert.equal(afterRestart.lockdown.active, true);
  assert.equal(afterRestart.destructiveActions.length, 1);
  assert.equal(afterRestart.lockdown.reason, "restart regression");
});

test("serializes concurrent destructive reservations so a rate limit cannot be overspent", async () => {
  await setSecurity({ perAdminLimit: 1 });
  const before = trelloCardCreations.length;
  const first = command("admin-a", "group_blacklist", { id: "501", reason: "one" });
  const second = command("admin-a", "group_blacklist", { id: "502", reason: "two" });
  client!.emit("interactionCreate", first);
  client!.emit("interactionCreate", second);
  await settle();
  await settle();
  assert.equal(trelloCardCreations.length, before + 1);
  assert.equal((await getSecurityState(guild.id)).destructiveActions.length, 1);
});

test("fails closed for corrupt and structurally malformed persisted security state", async () => {
  await setSecurity({ confirmationsRequired: false });
  const before = trelloCardCreations.length;
  await writeFile(config.securityFile, "{ definitely not json", "utf8");
  await dispatch(command("admin-a", "group_blacklist", { id: "601", reason: "corrupt" }));
  assert.equal(trelloCardCreations.length, before);

  await writeFile(
    config.securityFile,
    JSON.stringify({ guilds: [{ guildId: guild.id, lockdown: null }] }),
    "utf8",
  );
  await dispatch(command("admin-a", "group_blacklist", { id: "602", reason: "malformed" }));
  assert.equal(trelloCardCreations.length, before);
  assert.match(replies.at(-1) ?? "", /Could not complete the command/i);

  // Restore a well-formed store so this test cannot poison any subsequent test.
  await writeFile(config.securityFile, JSON.stringify({ guilds: [] }), "utf8");
  const persisted = JSON.parse(await readFile(config.securityFile, "utf8")) as { guilds: unknown[] };
  assert.deepEqual(persisted.guilds, []);
});
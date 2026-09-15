import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ChannelType,
  Collection,
  PermissionFlagsBits,
} from "discord.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "uniform-log-tests-"));
process.env.NODE_ENV = "production";
process.env.BOT_SETUP_FILE = path.join(directory, "setup.json");
process.env.BOT_SECURITY_FILE = path.join(directory, "security.json");
process.env.ROLE_SNAPSHOT_FILE = path.join(directory, "snapshots.json");

const {
  canSubmitUniforms,
  handleUniformCommand,
  parseUniformAssetInput,
  saveUniformSettings,
  resetUniformSettings,
  uniformCommands,
  uniformSubmissionEmbed,
  validateUniformSettings,
} = await import("../src/bot/uniforms.ts");
const {
  getGuildSetup,
  defaultUniformSettings,
} = await import("../src/bot/setup-store.ts");

const users = new Map([
  ["Customer", { id: 101, name: "Customer", displayName: "Customer" }],
  ["Shared", { id: 102, name: "Shared", displayName: "Shared" }],
  ["Senior", { id: 103, name: "Senior", displayName: "Senior" }],
  ["Uploader", { id: 104, name: "Uploader", displayName: "Uploader" }],
  ["Publisher", { id: 105, name: "Publisher", displayName: "Publisher" }],
]);

const originalFetch = globalThis.fetch;
let lookupCalls: string[] = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(input.toString());
  if (url.pathname !== "/v1/usernames/users") {
    throw new Error(`Unexpected Roblox request: ${url.pathname}`);
  }
  const body = init?.body as string | undefined;
  // Tests call the real resolver, so count and answer the exact request body.
  const requested = body ? JSON.parse(body).usernames?.[0] as string : "";
  lookupCalls.push(requested);
  const user = users.get(requested);
  return new Response(JSON.stringify({ data: user ? [user] : [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

type ChannelState = {
  type: ChannelType;
  allowed: boolean;
  sends: unknown[];
};

const channels = new Map<string, ChannelState>([
  ["log-channel", { type: ChannelType.GuildText, allowed: true, sends: [] }],
  ["moderated-channel", { type: ChannelType.GuildText, allowed: true, sends: [] }],
]);
const roleGuild = { id: "uniform-guild" };
const roles = new Map<string, { id: string; guild: typeof roleGuild }>([
  ["20000000000000001", { id: "20000000000000001", guild: roleGuild }],
]);
const memberRecords = new Map<string, { admin: boolean; roles: string[] }>([
  ["owner", { admin: false, roles: [] }],
  ["admin", { admin: true, roles: [] }],
  ["role-member", { admin: false, roles: ["20000000000000001"] }],
  ["20000000000000002", { admin: false, roles: [] }],
]);

function memberFor(id: string) {
  const record = memberRecords.get(id);
  if (!record) throw new Error("member not found");
  const roleCache = new Collection(
    record.roles.map((roleId) => [roleId, { id: roleId }]),
  );
  return {
    id,
    guild: roleGuild,
    permissions: {
      has: (permission: bigint) =>
        permission === PermissionFlagsBits.Administrator && record.admin,
    },
    roles: {
      cache: roleCache,
      highest: { position: 10 },
    },
  };
}

const guild = {
  id: "uniform-guild",
  ownerId: "owner",
  members: {
    me: { id: "bot" },
    fetch: async (input?: string | { user: string }) => {
      const id = typeof input === "string" ? input : input?.user;
      if (!id) throw new Error("member id required");
      return memberFor(id);
    },
  },
  roles: {
    fetch: async (id: string) => roles.get(id) ?? null,
  },
  channels: {
    fetch: async (id: string) => {
      const channel = channels.get(id);
      if (!channel) return null;
      return {
        ...channel,
        permissionsFor: () => ({ has: () => channel.allowed }),
        send: async (payload: unknown) => {
          channel.sends.push(payload);
        },
      };
    },
  },
};

const setup = {
  guildId: guild.id,
  moderatorRoleId: guild.id,
  auditChannelId: "audit-channel",
  uniforms: {
    logChannelId: "log-channel",
    moderatedChannelId: "moderated-channel",
    authorizedRoleIds: ["20000000000000001"],
    authorizedMemberIds: ["20000000000000002"],
  },
  updatedBy: "owner",
  updatedAt: new Date().toISOString(),
};

function interaction(
  commandName: "log" | "moderated",
  values: Record<string, string | undefined>,
  userId = "20000000000000002",
) {
  const privateReplies: unknown[] = [];
  return {
    commandName,
    guild,
    guildId: guild.id,
    user: { id: userId },
    options: {
      getString: (name: string, required?: boolean) => {
        const value = values[name];
        if (required && !value) throw new Error(`missing ${name}`);
        return value ?? null;
      },
    },
    editReply: async (payload: unknown) => {
      privateReplies.push(payload);
    },
    privateReplies,
  };
}

function logValues(assets: string[]): Record<string, string> {
  return {
    customer: "Customer",
    qm: "Shared",
    seqm: "Senior",
    publisher: "Publisher",
    ...Object.fromEntries(assets.map((asset, index) => [`shirtid${index + 1}`, asset])),
  };
}

test.after(() => {
  globalThis.fetch = originalFetch;
});

test("registers the exact six-command uniform contract and parses only Roblox assets", () => {
  assert.deepEqual(uniformCommands.map((command) => command.name), ["log", "moderated"]);
  const log = uniformCommands[0]!.toJSON();
  const moderated = uniformCommands[1]!.toJSON();
  assert.deepEqual(log.options?.map((option) => option.name), [
    "customer", "qm", "seqm", "publisher",
    "shirtid1", "shirtid2", "shirtid3", "shirtid4", "shirtid5",
    "shirtid6", "shirtid7", "shirtid8", "shirtid9", "shirtid10",
  ]);
  assert.equal(log.options?.find((option) => option.name === "shirtid1")?.required, true);
  assert.equal(log.options?.find((option) => option.name === "shirtid10")?.required, false);
  assert.deepEqual(moderated.options?.map((option) => option.name), [
    "customer", "uploader", "publisher", "shirtid",
  ]);
  assert.equal(parseUniformAssetInput("123").url, "https://www.roblox.com/catalog/123");
  assert.equal(
    parseUniformAssetInput("https://www.roblox.com/catalog/123/Classic-Shirt?source=test").id,
    123,
  );
  assert.equal(
    parseUniformAssetInput("https://create.roblox.com/store/asset/456/shirt").id,
    456,
  );
  assert.throws(() => parseUniformAssetInput("https://evil.example/catalog/123"), /allowlisted|valid/i);
  assert.throws(() => parseUniformAssetInput("0"), /positive/i);
  assert.throws(() => parseUniformAssetInput("https://www.roblox.com/catalog/not-an-id"), /supported|valid/i);
});

test("authorizes administrators, configured roles, and members while denying the default", async () => {
  const settings = setup.uniforms!;
  assert.equal(await canSubmitUniforms(guild as never, "owner", settings), true);
  assert.equal(await canSubmitUniforms(guild as never, "admin", settings), true);
  assert.equal(await canSubmitUniforms(guild as never, "role-member", settings), true);
  assert.equal(await canSubmitUniforms(guild as never, "20000000000000002", settings), true);
  assert.equal(
    await canSubmitUniforms(guild as never, "20000000000000002", defaultUniformSettings()),
    false,
  );
});

test("logs all /log participants and ten assets once, with canonical IDs and no mentions", async () => {
  lookupCalls = [];
  channels.get("log-channel")!.sends.length = 0;
  const result = interaction("log", logValues([
    "101",
    "https://www.roblox.com/catalog/102/Shared",
    "103", "104", "105", "106", "107", "108", "109", "110",
  ]));
  await handleUniformCommand(result as never, setup);
  assert.deepEqual(lookupCalls.sort(), ["Customer", "Publisher", "Senior", "Shared"].sort());
  assert.equal(channels.get("log-channel")!.sends.length, 1);
  const publicPayload = channels.get("log-channel")!.sends[0] as {
    embeds: Array<{ data: { fields?: Array<{ name: string; value: string }> } }>;
    allowedMentions: { parse: unknown[] };
  };
  const fields = publicPayload.embeds[0]!.data.fields ?? [];
  assert.equal(fields.filter((field) => field.name.startsWith("Uniform ")).length, 10);
  assert.match(fields.find((field) => field.name === "Customer")?.value ?? "", /Customer/);
  assert.match(fields.find((field) => field.name === "Customer")?.value ?? "", /101/);
  assert.match(fields.find((field) => field.name === "Uniform 10")?.value ?? "", /110/);
  assert.deepEqual(publicPayload.allowedMentions.parse, []);
  assert.match(JSON.stringify(result.privateReplies), /Uniform Log Submitted/);
});

test("validates /moderated uploader and posts only to its separate channel", async () => {
  lookupCalls = [];
  channels.get("log-channel")!.sends.length = 0;
  channels.get("moderated-channel")!.sends.length = 0;
  const result = interaction("moderated", {
    customer: "Customer",
    uploader: "Uploader",
    publisher: "Publisher",
    shirtid: "https://www.roblox.com/library/77/Uniform",
  });
  await handleUniformCommand(result as never, setup);
  assert.deepEqual(lookupCalls.sort(), ["Customer", "Publisher", "Uploader"].sort());
  assert.equal(channels.get("log-channel")!.sends.length, 0);
  assert.equal(channels.get("moderated-channel")!.sends.length, 1);
  const serialized = JSON.stringify(channels.get("moderated-channel")!.sends[0]);
  assert.match(serialized, /Uploader/);
  assert.match(serialized, /Moderated Uniform Logged/);
  assert.match(serialized, /77/);
});

test("rejects invalid accounts/assets and malformed gaps before sending anything", async () => {
  channels.get("log-channel")!.sends.length = 0;
  const invalidAccount = interaction("log", { ...logValues(["1"]), customer: "Unknown" });
  await assert.rejects(handleUniformCommand(invalidAccount as never, setup), /Could not validate Customer/i);
  const malformed = interaction("log", {
    ...logValues(["1", "2"]),
    shirtid1: "not-a-roblox-asset",
  });
  await assert.rejects(handleUniformCommand(malformed as never, setup), /uniform asset/i);
  const gap = interaction("log", {
    customer: "Customer", qm: "Shared", seqm: "Senior", publisher: "Publisher",
    shirtid1: "1", shirtid3: "3",
  });
  await assert.rejects(handleUniformCommand(gap as never, setup), /without gaps/i);
  assert.equal(channels.get("log-channel")!.sends.length, 0);
});

test("fails clearly when a configured destination is missing or cannot embed", async () => {
  const noDestination: GuildSetup = {
    ...setup,
    uniforms: { ...setup.uniforms!, logChannelId: undefined },
  };
  await assert.rejects(
    handleUniformCommand(interaction("log", logValues(["1"])) as never, noDestination),
    /destination is not configured/i,
  );
  channels.get("log-channel")!.allowed = false;
  await assert.rejects(
    handleUniformCommand(interaction("log", logValues(["1"])) as never, setup),
    /cannot view, send messages, and embed links/i,
  );
  channels.get("log-channel")!.allowed = true;
  channels.get("log-channel")!.type = ChannelType.GuildVoice;
  await assert.rejects(
    handleUniformCommand(interaction("log", logValues(["1"])) as never, setup),
    /not a text channel/i,
  );
  channels.get("log-channel")!.type = ChannelType.GuildText;
});

test("validates config channels and guild-owned role/member IDs, saves and resets whole setup", async () => {
  await validateUniformSettings(guild as never, setup.uniforms!);
  const saved = await saveUniformSettings(guild as never, setup, "admin", {
    logChannelId: "log-channel",
    moderatedChannelId: "moderated-channel",
    authorizedRoleIds: ["20000000000000001"],
    authorizedMemberIds: ["20000000000000002"],
  });
  assert.equal((await getGuildSetup(guild.id))?.uniforms?.logChannelId, "log-channel");
  assert.deepEqual(saved.uniforms?.authorizedRoleIds, ["20000000000000001"]);
  await assert.rejects(
    validateUniformSettings(guild as never, {
      ...defaultUniformSettings(),
      logChannelId: "foreign-channel",
    }),
    /destination|configured/i,
  );
  const foreignRole = { id: "foreign-role", guild: { id: "other-guild" } };
  roles.set("20000000000000003", foreignRole as never);
  await assert.rejects(
    validateUniformSettings(guild as never, {
      ...defaultUniformSettings(),
      authorizedRoleIds: ["20000000000000003"],
    }),
    /does not belong/i,
  );
  roles.delete("20000000000000003");
  const reset = await resetUniformSettings(saved, "admin");
  assert.equal(reset.uniforms, undefined);
  assert.equal((await getGuildSetup(guild.id))?.uniforms, undefined);
});

test("uniform embeds remain within Discord limits and include actor/timestamp", () => {
  const embed = uniformSubmissionEmbed({
    command: "log",
    users: {
      customer: users.get("Customer")!,
      qm: users.get("Shared")!,
      seqm: users.get("Senior")!,
      publisher: users.get("Publisher")!,
    },
    assets: Array.from({ length: 10 }, (_, index) => ({ id: index + 1, url: `https://www.roblox.com/catalog/${index + 1}` })),
  }, "actor-id");
  const data = embed.toJSON();
  const total = [
    data.title ?? "",
    data.description ?? "",
    ...(data.fields ?? []).flatMap((field) => [field.name, field.value]),
  ].join("").length;
  assert.ok(total <= 6_000);
  assert.ok(data.fields?.some((field) => field.name === "Actor ID"));
  assert.ok(data.fields?.some((field) => field.name === "Timestamp"));
});
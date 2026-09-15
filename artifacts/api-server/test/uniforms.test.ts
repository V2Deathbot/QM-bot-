import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
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
  saveUniformSpreadsheetSettings,
  resetUniformSettings,
  uniformCommands,
  uniformSubmissionEmbed,
  validateUniformSettings,
  resetUniformSubmissionStateForTests,
} = await import("../src/bot/uniforms.ts");
const {
  getGuildSetup,
  saveGuildSetup,
  defaultUniformSettings,
} = await import("../src/bot/setup-store.ts");
const {
  resetGoogleSheetsProxyForTests,
  setGoogleSheetsProxyForTests,
  UNIFORM_SHEET_HEADERS,
} = await import("../src/bot/google-sheets.ts");

const users = new Map([
  ["Customer", { id: 101, name: "Customer", displayName: "Customer" }],
  ["Shared", { id: 102, name: "Shared", displayName: "Shared" }],
  ["Senior", { id: 103, name: "Senior", displayName: "Senior" }],
  ["Uploader", { id: 104, name: "Uploader", displayName: "Uploader" }],
  ["Publisher", { id: 105, name: "Publisher", displayName: "Publisher" }],
]);

const originalFetch = globalThis.fetch;
let lookupCalls: string[] = [];
let interactionCounter = 0;
let sheetsCalls: Array<{ path: string; options?: { method?: string; body?: unknown } }> = [];
let sheetFailure: string | undefined;
let appendFailureAfterCommit = false;
let sheetValidationGate: Promise<void> | undefined;
let notificationStatusFailure = false;
const sheetRows = new Map<string, unknown[][]>();

function resetSheetState(): void {
  sheetsCalls = [];
  sheetFailure = undefined;
  appendFailureAfterCommit = false;
  sheetValidationGate = undefined;
  notificationStatusFailure = false;
  sheetRows.clear();
  sheetRows.set("Uniform Logs", [Array.from(UNIFORM_SHEET_HEADERS)]);
  sheetRows.set("Moderated Logs", [Array.from(UNIFORM_SHEET_HEADERS)]);
  resetUniformSubmissionStateForTests();
}

function sheetResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sheetTab(pathname: string): string {
  const decoded = decodeURIComponent(pathname);
  const match = /\/values\/'((?:''|[^'])+)'!/.exec(decoded);
  if (!match) throw new Error(`Unexpected Sheets range: ${decoded}`);
  return match[1]!.replaceAll("''", "'");
}

function sheetTabFromRange(range: string): string {
  const decoded = decodeURIComponent(range);
  const match = /^'((?:''|[^'])+)'!/.exec(decoded);
  if (!match) throw new Error(`Unexpected Sheets range: ${decoded}`);
  return match[1]!.replaceAll("''", "'");
}

setGoogleSheetsProxyForTests(async (pathname, options) => {
  sheetsCalls.push({ path: pathname, options });
  if (sheetFailure) throw new Error(sheetFailure);
  const method = options?.method ?? "GET";
  if (pathname.includes("?fields=")) {
    return sheetResponse({
      sheets: [
        { properties: { title: "Uniform Logs", sheetId: 1 } },
        { properties: { title: "Moderated Logs", sheetId: 2 } },
      ],
    });
  }
  if (method === "GET") {
    if (sheetValidationGate) await sheetValidationGate;
    return sheetResponse({ values: sheetRows.get(sheetTab(pathname)) ?? [] });
  }
  if (method === "POST" && pathname.includes(":append")) {
    const body = options?.body as { values?: unknown[][] } | undefined;
    const tab = sheetTab(pathname);
    const rows = sheetRows.get(tab) ?? [Array.from(UNIFORM_SHEET_HEADERS)];
    rows.push(...(body?.values ?? []));
    sheetRows.set(tab, rows);
    if (appendFailureAfterCommit) {
      appendFailureAfterCommit = false;
      throw new Error("Sheets append response timed out after commit");
    }
    return sheetResponse({ updates: { updatedRows: body?.values?.length ?? 0 } });
  }
  if (method === "POST" && pathname.includes("/values:batchUpdate")) {
    if (notificationStatusFailure) throw new Error("notification status update failed");
    const body = options?.body as {
      data?: Array<{ range?: string; values?: unknown[][] }>;
    } | undefined;
    for (const entry of body?.data ?? []) {
      const match = /!R(\d+):S\1$/.exec(decodeURIComponent(entry.range ?? ""));
      if (!match) throw new Error(`Unexpected status range: ${entry.range}`);
      const rows = sheetRows.get(sheetTabFromRange(entry.range ?? ""))!;
      const row = rows[Number(match[1]) - 1]!;
      row[17] = entry.values?.[0]?.[0] ?? "";
      row[18] = entry.values?.[0]?.[1] ?? "";
    }
    return sheetResponse({ totalUpdatedCells: (body?.data ?? []).length * 2 });
  }
  if (method === "PUT") {
    const tab = sheetTab(pathname);
    sheetRows.set(tab, [Array.from(UNIFORM_SHEET_HEADERS)]);
    return sheetResponse({ updatedRows: 1 });
  }
  throw new Error(`Unexpected Sheets method/path: ${method} ${pathname}`);
});

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
  sendFailure?: Error;
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
          if (channel.sendFailure) throw channel.sendFailure;
          const nonce = (payload as { nonce?: unknown }).nonce;
          if (
            (payload as { enforceNonce?: unknown }).enforceNonce === true &&
            typeof nonce === "string" &&
            channel.sends.some((entry) => (entry as { nonce?: unknown }).nonce === nonce)
          ) {
            const existing = channel.sends.find((entry) => (entry as { nonce?: unknown }).nonce === nonce);
            return { id: (existing as { id?: string }).id ?? `message-${channel.sends.length}` };
          }
          channel.sends.push(payload);
          return { id: `message-${channel.sends.length}` };
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
    spreadsheet: {
      spreadsheetId: "sheet-id",
      logTab: "Uniform Logs",
      moderatedTab: "Moderated Logs",
      createMissingTabs: false,
    },
  },
  updatedBy: "owner",
  updatedAt: new Date().toISOString(),
};

function interaction(
  commandName: "log" | "moderated",
  values: Record<string, string | undefined>,
  userId = "20000000000000002",
  id = `interaction-${++interactionCounter}`,
) {
  const privateReplies: unknown[] = [];
  return {
    id,
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

beforeEach(() => {
  resetSheetState();
  channels.get("log-channel")!.sendFailure = undefined;
  channels.get("moderated-channel")!.sendFailure = undefined;
  channels.get("log-channel")!.sends.length = 0;
  channels.get("moderated-channel")!.sends.length = 0;
  channels.get("log-channel")!.allowed = true;
  channels.get("moderated-channel")!.allowed = true;
  channels.get("log-channel")!.type = ChannelType.GuildText;
  channels.get("moderated-channel")!.type = ChannelType.GuildText;
});

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
  resetGoogleSheetsProxyForTests();
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

test("logs all /log participants as ten RAW sheet rows and one short channel message", async () => {
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
    content: string;
    embeds?: unknown[];
    allowedMentions: { parse: unknown[] };
  };
  assert.match(publicPayload.content, /^Uniform logged: \/log \(10 assets\)\.$/);
  assert.equal(publicPayload.embeds, undefined);
  assert.deepEqual(publicPayload.allowedMentions.parse, []);
  const detailedRows = sheetRows.get("Uniform Logs")!;
  assert.equal(detailedRows.length, 11);
  assert.deepEqual(detailedRows[0], Array.from(UNIFORM_SHEET_HEADERS));
  assert.equal(detailedRows.slice(1).length, 10);
  assert.equal(detailedRows[1]![1], "log");
  assert.equal(detailedRows[1]![2], "Customer");
  assert.equal(detailedRows[1]![3], "101");
  assert.equal(detailedRows[1]![12], "101");
  assert.equal(detailedRows[10]![12], "110");
  assert.equal(detailedRows[1]![16], result.id);
  assert.equal(detailedRows[1]![17], "NOTIFIED");
  assert.equal(detailedRows[1]![18], "message-1");
  assert.equal((channels.get("log-channel")!.sends[0] as { nonce: string; enforceNonce: boolean }).nonce, result.id);
  assert.equal((channels.get("log-channel")!.sends[0] as { enforceNonce: boolean }).enforceNonce, true);
  assert.equal(
    sheetsCalls.filter(({ path, options }) => path.includes(":append") && options?.method === "POST").length,
    1,
  );
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
  const publicPayload = channels.get("moderated-channel")!.sends[0] as { content: string };
  assert.equal(publicPayload.content, "Uniform logged: /moderated (1 asset).");
  const detailedRows = sheetRows.get("Moderated Logs")!;
  assert.equal(detailedRows.length, 2);
  assert.equal(detailedRows[1]![1], "moderated");
  assert.equal(detailedRows[1]![8], "Uploader");
  assert.equal(detailedRows[1]![9], "104");
  assert.equal(detailedRows[1]![12], "77");
  assert.equal(detailedRows[1]![16], result.id);
  assert.equal(detailedRows[1]![17], "NOTIFIED");
});

test("does not announce when the sheet connector fails", async () => {
  sheetFailure = "connector unavailable";
  const result = interaction("log", logValues(["1"]));
  await assert.rejects(
    handleUniformCommand(result as never, setup),
    /Google Sheets.*failed|connector unavailable/i,
  );
  assert.equal(channels.get("log-channel")!.sends.length, 0);
  assert.equal(sheetRows.get("Uniform Logs")!.length, 1);
});

test("reports durable sheet save when Discord notification fails and rejects resubmission", async () => {
  const result = interaction("moderated", {
    customer: "Customer",
    uploader: "Uploader",
    publisher: "Publisher",
    shirtid: "77",
  }, "20000000000000002", "notification-failure");
  channels.get("moderated-channel")!.sendFailure = new Error("Discord channel unavailable");
  await assert.rejects(
    handleUniformCommand(result as never, setup),
    /saved to Google Sheets.*Discord notification failed.*Do not resubmit/i,
  );
  assert.equal(sheetRows.get("Moderated Logs")!.length, 2);
  assert.equal(channels.get("moderated-channel")!.sends.length, 0);

  channels.get("moderated-channel")!.sendFailure = undefined;
  await assert.rejects(
    handleUniformCommand(result as never, setup),
    /already been processed|already present/i,
  );
  assert.equal(sheetRows.get("Moderated Logs")!.length, 2);
  assert.equal(channels.get("moderated-channel")!.sends.length, 0);
});

test("retries a pending notice after process state is lost without appending rows", async () => {
  const result = interaction("moderated", {
    customer: "Customer",
    uploader: "Uploader",
    publisher: "Publisher",
    shirtid: "77",
  }, "20000000000000002", "pending-notice-retry");
  channels.get("moderated-channel")!.sendFailure = new Error("temporary Discord failure");
  await assert.rejects(handleUniformCommand(result as never, setup), /Discord notification failed/i);
  channels.get("moderated-channel")!.sendFailure = undefined;
  resetUniformSubmissionStateForTests();
  await handleUniformCommand(result as never, setup);
  assert.equal(sheetRows.get("Moderated Logs")!.length, 2);
  assert.equal(sheetRows.get("Moderated Logs")![1]![17], "NOTIFIED");
  assert.equal(channels.get("moderated-channel")!.sends.length, 1);
});

test("retries notification bookkeeping after a notice succeeds but status update fails", async () => {
  const result = interaction("log", logValues(["1"]), "20000000000000002", "status-timeout");
  notificationStatusFailure = true;
  await assert.rejects(
    handleUniformCommand(result as never, setup),
    /notification status could not be recorded.*Do not resubmit/i,
  );
  assert.equal(channels.get("log-channel")!.sends.length, 1);
  assert.equal(sheetRows.get("Uniform Logs")![1]![17], "PENDING");
  notificationStatusFailure = false;
  await handleUniformCommand(result as never, setup);
  assert.equal(channels.get("log-channel")!.sends.length, 1);
  assert.equal(sheetRows.get("Uniform Logs")![1]![17], "NOTIFIED");
});

test("verifies an append committed before timeout and still posts its notice", async () => {
  appendFailureAfterCommit = true;
  const result = interaction("log", logValues(["1"]), "20000000000000002", "append-timeout");
  await handleUniformCommand(result as never, setup);
  assert.equal(channels.get("log-channel")!.sends.length, 1);
  assert.equal(sheetRows.get("Uniform Logs")![1]![16], result.id);
  assert.equal(sheetRows.get("Uniform Logs")![1]![17], "NOTIFIED");
  assert.equal(sheetRows.get("Uniform Logs")![1]![18], "message-1");
});

test("does not send a duplicate when persisted rows already record the notice", async () => {
  const result = interaction("log", logValues(["1"]), "20000000000000002", "already-notified");
  await handleUniformCommand(result as never, setup);
  resetUniformSubmissionStateForTests();
  await handleUniformCommand(result as never, setup);
  assert.equal(channels.get("log-channel")!.sends.length, 1);
  assert.match(JSON.stringify(result.privateReplies), /already saved.*notice is already recorded/i);
});

test("does not append duplicate rows for duplicate interaction delivery", async () => {
  const result = interaction("log", logValues(["1", "2"]), "20000000000000002", "duplicate-interaction");
  await handleUniformCommand(result as never, setup);
  const callsAfterFirst = sheetsCalls.length;
  await assert.rejects(
    handleUniformCommand(result as never, setup),
    /already been processed|already present/i,
  );
  assert.equal(sheetRows.get("Uniform Logs")!.length, 3);
  assert.equal(sheetsCalls.length, callsAfterFirst);
  assert.equal(channels.get("log-channel")!.sends.length, 1);
});

test("explains missing spreadsheet configuration without posting a channel message", async () => {
  const withoutSpreadsheet = {
    ...setup,
    uniforms: { ...setup.uniforms!, spreadsheet: undefined },
  };
  const result = interaction("log", logValues(["1"]));
  await assert.rejects(
    handleUniformCommand(result as never, withoutSpreadsheet),
    /Spreadsheet Configuration.*spreadsheet URL or ID/i,
  );
  assert.equal(channels.get("log-channel")!.sends.length, 0);
});

test("serializes slow Spreadsheet Configuration saves against latest uploading settings", async () => {
  await saveGuildSetup(setup as never);
  let releaseValidation!: () => void;
  sheetValidationGate = new Promise<void>((resolve) => {
    releaseValidation = resolve;
  });
  const spreadsheetSave = saveUniformSpreadsheetSettings(
    guild as never,
    setup as never,
    "sheet-admin",
    {
      spreadsheetId: "new-sheet-id",
      logTab: "Uniform Logs",
      moderatedTab: "Moderated Logs",
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const uploadingSave = saveUniformSettings(guild as never, setup as never, "upload-admin", {
    logChannelId: "moderated-channel",
    moderatedChannelId: "log-channel",
    authorizedRoleIds: ["20000000000000001"],
    authorizedMemberIds: ["20000000000000002"],
  });
  await uploadingSave;
  releaseValidation();
  await spreadsheetSave;

  const saved = await getGuildSetup(guild.id);
  assert.equal(saved?.uniforms?.spreadsheet?.spreadsheetId, "new-sheet-id");
  assert.equal(saved?.uniforms?.logChannelId, "moderated-channel");
  assert.equal(saved?.uniforms?.moderatedChannelId, "log-channel");
  assert.deepEqual(saved?.uniforms?.authorizedRoleIds, ["20000000000000001"]);
  assert.deepEqual(saved?.uniforms?.authorizedMemberIds, ["20000000000000002"]);
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
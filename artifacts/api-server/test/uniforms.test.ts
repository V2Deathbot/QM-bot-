import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "uniform-command-tests-"));
process.env.BOT_SETUP_FILE = path.join(directory, "setup.json");
process.env.UNIFORM_SUBMISSION_LEDGER_FILE = path.join(directory, "ledger.json");

const {
  canSubmitUniforms, handleUniformCommand, parseUniformAssetInput,
  resetUniformSubmissionStateForTests, saveUniformSettings,
  saveUniformSpreadsheetSettings, uniformCommands, uniformSheetRows,
  validateUniformSettings,
} = await import("../src/bot/uniforms.ts");
const { setGoogleSheetsProxyForTests, resetGoogleSheetsProxyForTests } =
  await import("../src/bot/google-sheets.ts");
const { getGuildSetup, saveGuildSetup, defaultUniformSettings } =
  await import("../src/bot/setup-store.ts");

const originalFetch = globalThis.fetch;
const users = new Map([
  ["QM", { id: 1, name: "QM", displayName: "QM" }],
  ["SEQM", { id: 2, name: "SEQM", displayName: "SEQM" }],
  ["Publisher", { id: 3, name: "Publisher", displayName: "Publisher" }],
  ["Customer", { id: 4, name: "Customer", displayName: "Customer" }],
  ["Uploader", { id: 5, name: "Uploader", displayName: "Uploader" }],
]);
globalThis.fetch = async (_input, init) => {
  const username = JSON.parse(String(init?.body)).usernames[0] as string;
  return new Response(JSON.stringify({ data: users.has(username) ? [users.get(username)] : [] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};

const rows = new Map<string, unknown[][]>();
let sends: unknown[] = [];
let sendFailure: Error | undefined;
let sheetFailure: Error | undefined;
let sheetValidationGate: Promise<void> | undefined;
let interactionCount = 0;
function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}
setGoogleSheetsProxyForTests(async (pathname, options) => {
  if (sheetFailure) throw sheetFailure;
  if (pathname.includes("?fields=")) {
    if (sheetValidationGate) await sheetValidationGate;
    return response({ sheets: [
      { properties: { title: "Uniform Logs", gridProperties: { columnCount: 10 } } },
      { properties: { title: "Moderated Logs", gridProperties: { columnCount: 10 } } },
    ] });
  }
  const tab = /\/values\/'([^']+)'!/.exec(decodeURIComponent(pathname))?.[1]!;
  if (options?.method === "GET") return response({ values: rows.get(tab) ?? [] });
  const body = options?.body as { values: unknown[][] };
  rows.set(tab, [...(rows.get(tab) ?? []), ...body.values]);
  return response({});
});

const member = {
  id: "submitter",
  permissions: { has: (permission: bigint) => permission === PermissionFlagsBits.Administrator ? false : false },
  roles: { cache: new Collection([["20000000000000001", { id: "20000000000000001" }]]) },
};
const guild = {
  id: "guild", ownerId: "owner", members: {
    me: { id: "bot" },
    fetch: async (request: string | { user: string }) => ({
      ...member, id: typeof request === "string" ? request : request.user,
      guild: { id: "guild" },
    }),
  },
  channels: { fetch: async (id: string) => {
    if (id === "missing") return null;
    if (id === "voice") return {
      type: ChannelType.GuildVoice, permissionsFor: () => ({ has: () => true }), send: async () => ({ id: "voice" }),
    };
    if (id === "blocked") return {
      type: ChannelType.GuildText, permissionsFor: () => ({ has: () => false }), send: async () => ({ id: "blocked" }),
    };
    return {
      type: ChannelType.GuildText,
      permissionsFor: () => ({ has: () => true }),
      send: async (payload: unknown) => {
        if (sendFailure) throw sendFailure;
        sends.push({ id, payload });
        return { id: `notice-${sends.length}` };
      },
    };
  } },
  roles: { fetch: async () => ({ guild: { id: "guild" } }) },
};
const setup = {
  guildId: "guild", moderatorRoleId: "mod", auditChannelId: "audit", updatedBy: "owner", updatedAt: new Date().toISOString(),
  uniforms: {
    logChannelId: "log", moderatedChannelId: "moderated",
    authorizedRoleIds: ["20000000000000001"], authorizedMemberIds: [],
    spreadsheet: { spreadsheetId: "sheet", logTab: "Uniform Logs", moderatedTab: "Moderated Logs", logRange: "A2:E", moderatedRange: "A2:D" },
  },
};
function interaction(commandName: "log" | "moderated", values: Record<string, string>, id = `submission-${++interactionCount}`) {
  return {
    id, commandName, guild, guildId: guild.id, user: { id: "submitter" },
    options: { getString: (name: string, required?: boolean) => {
      const value = values[name];
      if (required && !value) throw new Error(`missing ${name}`);
      return value ?? null;
    } },
    editReply: async () => undefined,
  };
}
beforeEach(() => {
  rows.clear(); sends = []; sendFailure = undefined; sheetFailure = undefined;
  sheetValidationGate = undefined; resetUniformSubmissionStateForTests();
});
after(() => { globalThis.fetch = originalFetch; resetGoogleSheetsProxyForTests(); });

test("registers username inputs in the requested order", () => {
  assert.deepEqual(uniformCommands[0]!.toJSON().options?.slice(0, 4).map((option) => option.name),
    ["qm", "seqm", "publisher", "customer"]);
  assert.deepEqual(uniformCommands[1]!.toJSON().options?.slice(0, 3).map((option) => option.name),
    ["uploader", "publisher", "customer"]);
  assert.equal(parseUniformAssetInput("123").url, "https://www.roblox.com/catalog/123");
});

test("maps /log and /moderated values to only their visible worksheet columns", () => {
  const common = { id: "mapping", user: { id: "discord" }, guildId: "guild" } as never;
  const log = uniformSheetRows({
    command: "log", assets: [{ id: 7, url: "https://www.roblox.com/catalog/7" }],
    users: { qm: users.get("QM")!, seqm: users.get("SEQM")!, publisher: users.get("Publisher")!, customer: users.get("Customer")! },
  }, common, new Date());
  assert.deepEqual(log, [["QM", "SEQM", "Publisher", "Customer", "https://www.roblox.com/catalog/7"]]);
  const moderated = uniformSheetRows({
    command: "moderated", assets: [{ id: 8, url: "https://www.roblox.com/catalog/8" }],
    users: { uploader: users.get("Uploader")!, publisher: users.get("Publisher")!, customer: users.get("Customer")! },
  }, common, new Date());
  assert.deepEqual(moderated, [["Uploader", "Publisher", "Customer", "https://www.roblox.com/catalog/8"]]);
});

test("writes before notice and resumes a failed notice from persisted local state", async () => {
  const value = { qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "42" };
  const first = interaction("log", value, "notice-retry");
  sendFailure = new Error("channel unavailable");
  await assert.rejects(handleUniformCommand(first as never, setup as never), /saved to Google Sheets.*notification failed/i);
  assert.deepEqual(rows.get("Uniform Logs"), [["QM", "SEQM", "Publisher", "Customer", "https://www.roblox.com/catalog/42"]]);
  sendFailure = undefined;
  resetUniformSubmissionStateForTests();
  await handleUniformCommand(first as never, setup as never);
  assert.equal((rows.get("Uniform Logs") ?? []).length, 1);
  assert.equal(sends.length, 1);
});

test("authorizes a configured uniform role", async () => {
  assert.equal(await canSubmitUniforms(guild as never, "submitter", setup.uniforms as never), true);
});

test("denies an unconfigured member but permits the server owner and Administrator", async () => {
  const noAccess = { ...setup.uniforms!, authorizedRoleIds: [], authorizedMemberIds: [] };
  const denyGuild = {
    ...guild,
    members: { ...guild.members, fetch: async (request: string | { user: string }) => {
      const id = typeof request === "string" ? request : request.user;
      return {
        ...member, id, guild: { id: "guild" },
        permissions: { has: () => id === "admin" },
        roles: { cache: new Collection() },
      };
    } },
  };
  assert.equal(await canSubmitUniforms(denyGuild as never, "member", noAccess), false);
  assert.equal(await canSubmitUniforms(denyGuild as never, "owner", noAccess), true);
  assert.equal(await canSubmitUniforms(denyGuild as never, "admin", noAccess), true);
});

test("rejects invalid usernames, malformed assets, and asset gaps before notification", async () => {
  await assert.rejects(
    handleUniformCommand(interaction("log", {
      qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Unknown", shirtid1: "1",
    }) as never, setup as never), /Could not validate Customer/i,
  );
  await assert.rejects(
    handleUniformCommand(interaction("log", {
      qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "bad",
    }) as never, setup as never), /uniform asset/i,
  );
  await assert.rejects(
    handleUniformCommand(interaction("log", {
      qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "1", shirtid3: "3",
    }) as never, setup as never), /without gaps/i,
  );
  assert.equal(sends.length, 0);
});

test("rejects missing, wrong-type, and unwritable uniform channels", async () => {
  for (const [channelId, expected] of [
    [undefined, /not configured/i],
    ["missing", /missing|not a text/i],
    ["voice", /not a text/i],
    ["blocked", /cannot view, send messages, and embed links/i],
  ] as const) {
    await assert.rejects(
      handleUniformCommand(interaction("log", {
        qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "1",
      }) as never, { ...setup, uniforms: { ...setup.uniforms!, logChannelId: channelId } } as never),
      expected,
    );
  }
});

test("writes ten /log rows before one notice and routes /moderated separately", async () => {
  await handleUniformCommand(interaction("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer",
    ...Object.fromEntries(Array.from({ length: 10 }, (_value, index) => [`shirtid${index + 1}`, String(index + 1)])),
  }) as never, setup as never);
  assert.equal(rows.get("Uniform Logs")?.length, 10);
  assert.equal(sends.length, 1);
  await handleUniformCommand(interaction("moderated", {
    uploader: "Uploader", publisher: "Publisher", customer: "Customer", shirtid: "77",
  }) as never, setup as never);
  assert.deepEqual(rows.get("Moderated Logs"), [["Uploader", "Publisher", "Customer", "https://www.roblox.com/catalog/77"]]);
  assert.equal((sends[1] as { id: string }).id, "moderated");
});

test("does not notify when Google Sheets fails and rejects duplicate interaction delivery", async () => {
  sheetFailure = new Error("connector unavailable");
  await assert.rejects(
    handleUniformCommand(interaction("log", {
      qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "1",
    }) as never, setup as never),
    /connector unavailable/i,
  );
  assert.equal(sends.length, 0);
  sheetFailure = undefined;
  const duplicate = interaction("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "2",
  }, "duplicate-delivery");
  await handleUniformCommand(duplicate as never, setup as never);
  await assert.rejects(handleUniformCommand(duplicate as never, setup as never), /already been processed/i);
  assert.equal(rows.get("Uniform Logs")?.length, 1);
  assert.equal(sends.length, 1);
});

test("preserves current upload settings during a slow spreadsheet configuration save", async () => {
  await saveGuildSetup(setup as never);
  let release!: () => void;
  sheetValidationGate = new Promise<void>((resolve) => { release = resolve; });
  const spreadsheetSave = saveUniformSpreadsheetSettings(guild as never, setup as never, "sheet-admin", {
    spreadsheetId: "new-sheet", logTab: "Uniform Logs", moderatedTab: "Moderated Logs",
    logRange: "C5:G", moderatedRange: "C5:F",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await saveUniformSettings(guild as never, setup as never, "upload-admin", {
    logChannelId: "moderated", moderatedChannelId: "log",
    authorizedRoleIds: ["20000000000000001"], authorizedMemberIds: [],
  });
  release();
  await spreadsheetSave;
  const saved = await getGuildSetup("guild");
  assert.equal(saved?.uniforms?.logChannelId, "moderated");
  assert.equal(saved?.uniforms?.spreadsheet?.logRange, "C5:G");
  assert.equal(saved?.uniforms?.spreadsheet?.moderatedRange, "C5:F");
  await assert.rejects(validateUniformSettings(guild as never, {
    ...defaultUniformSettings(), logChannelId: "missing",
  }), /destination/i);
});
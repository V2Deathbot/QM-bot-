import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "uniform-command-tests-"));
process.env.BOT_SETUP_FILE = path.join(directory, "setup.json");
process.env.UNIFORM_SUBMISSION_LEDGER_FILE = path.join(directory, "ledger.json");
process.env.UNIFORM_DELIVERY_FILE = path.join(directory, "deliveries.json");

const {
  canSubmitUniforms, handleUniformAssistanceModal, handleUniformCommand, handleUniformCustomerButton,
  handleUniformRetryButton, handleUniformSubmitButton, handleUniformUserSelection, parseUniformAssetInput,
  resetUniformSubmissionStateForTests, saveUniformSettings,
  saveUniformSpreadsheetSettings, uniformCommands, uniformSheetRows,
  validateUniformSettings,
} = await import("../src/bot/uniforms.ts");
const { setGoogleSheetsProxyForTests, resetGoogleSheetsProxyForTests } =
  await import("../src/bot/google-sheets.ts");
const {
  getUniformDelivery, resetUniformDeliveryStoreForTests, saveUniformDelivery,
} = await import("../src/bot/uniform-delivery-store.ts");
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
  const edits: unknown[] = [];
  return {
    id, commandName, guild, guildId: guild.id, user: { id: "submitter" },
    options: { getString: (name: string, required?: boolean) => {
      const value = values[name];
      if (required && !value) throw new Error(`missing ${name}`);
      return value ?? null;
    }, getChannel: (name: string, required?: boolean) => {
      const value = values[name] ?? "customer-channel";
      if (required && !value) throw new Error(`missing ${name}`);
      return { id: value, type: ChannelType.GuildText };
    } },
    edits,
    editReply: async (payload: unknown) => { edits.push(payload); },
  };
}
function componentId(payload: unknown, row: number): string {
  const component = (payload as { components: Array<{ components: Array<{ data: { custom_id: string } }> }> })
    .components[row]!.components[0]!;
  return component.data.custom_id;
}
async function prepareAndSubmit(command: "log" | "moderated", values: Record<string, string>, id?: string) {
  await saveGuildSetup(setup as never);
  const commandInteraction = interaction(command, values, id);
  await handleUniformCommand(commandInteraction as never, setup as never);
  const customerId = componentId(commandInteraction.edits[0], 0);
  const nonce = customerId.split(":")[2]!;
  await handleUniformUserSelection({
    customId: customerId, guild, guildId: guild.id, user: { id: "submitter" }, values: ["customer-discord"],
    update: async () => undefined,
  } as never);
  if (command === "log") {
    await handleUniformUserSelection({
      customId: `uniform:seqm:${nonce}`, guild, guildId: guild.id, user: { id: "submitter" }, values: ["seqm-discord"],
      update: async () => undefined,
    } as never);
  }
  await handleUniformSubmitButton({
    customId: `uniform:submit:${nonce}`, guild, guildId: guild.id, user: { id: "submitter" },
    deferUpdate: async () => undefined, editReply: async (payload: unknown) => { commandInteraction.edits.push(payload); },
  } as never, async () => false);
  return commandInteraction;
}
beforeEach(() => {
  rows.clear(); sends = []; sendFailure = undefined; sheetFailure = undefined;
  sheetValidationGate = undefined; resetUniformSubmissionStateForTests(); resetUniformDeliveryStoreForTests();
});
after(() => { globalThis.fetch = originalFetch; resetGoogleSheetsProxyForTests(); });

test("registers username inputs in the requested order", () => {
  assert.deepEqual(uniformCommands[0]!.toJSON().options?.slice(0, 4).map((option) => option.name),
    ["qm", "seqm", "publisher", "customer"]);
  assert.deepEqual(uniformCommands[1]!.toJSON().options?.slice(0, 3).map((option) => option.name),
    ["uploader", "publisher", "customer"]);
  assert.equal(parseUniformAssetInput("123").url, "https://www.roblox.com/catalog/123");
  for (const command of uniformCommands) {
    const options = command.toJSON().options ?? [];
    const firstOptional = options.findIndex((option) => option.required === false);
    const requiredPrefix = firstOptional < 0 ? options : options.slice(0, firstOptional);
    const optionalSuffix = firstOptional < 0 ? [] : options.slice(firstOptional);
    assert.ok(requiredPrefix.every((option) => option.required === true));
    assert.ok(optionalSuffix.every((option) => option.required !== true));
  }
  assert.equal(uniformCommands[0]!.toJSON().options?.[5]?.name, "channel");
  assert.equal(uniformCommands[1]!.toJSON().options?.[4]?.name, "channel");
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

test("writes before notice and conservatively preserves an unresolved notice", async () => {
  const value = { qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "42" };
  await saveGuildSetup(setup as never);
  const first = interaction("log", value, "notice-retry");
  sendFailure = new Error("channel unavailable");
  await handleUniformCommand(first as never, setup as never);
  const nonce = componentId(first.edits[0], 0).split(":")[2]!;
  await handleUniformUserSelection({ customId: `uniform:customer:${nonce}`, guild, guildId: guild.id, user: { id: "submitter" }, values: ["customer-discord"], update: async () => undefined } as never);
  await handleUniformUserSelection({ customId: `uniform:seqm:${nonce}`, guild, guildId: guild.id, user: { id: "submitter" }, values: ["seqm-discord"], update: async () => undefined } as never);
  await handleUniformSubmitButton({ customId: `uniform:submit:${nonce}`, guild, guildId: guild.id, user: { id: "submitter" }, deferUpdate: async () => undefined, editReply: async () => undefined } as never, async () => false);
  assert.deepEqual(rows.get("Uniform Logs"), [["QM", "SEQM", "Publisher", "Customer", "https://www.roblox.com/catalog/42"]]);
  sendFailure = undefined;
  resetUniformSubmissionStateForTests();
  await prepareAndSubmit("log", value, "notice-retry");
  assert.equal((rows.get("Uniform Logs") ?? []).length, 1);
  assert.equal(sends.length, 0);
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
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer",
    ...Object.fromEntries(Array.from({ length: 10 }, (_value, index) => [`shirtid${index + 1}`, String(index + 1)])),
  });
  assert.equal(rows.get("Uniform Logs")?.length, 10);
  assert.equal(sends.length, 2);
  await prepareAndSubmit("moderated", {
    uploader: "Uploader", publisher: "Publisher", customer: "Customer", shirtid: "77",
  });
  assert.deepEqual(rows.get("Moderated Logs"), [["Uploader", "Publisher", "Customer", "https://www.roblox.com/catalog/77"]]);
  assert.equal((sends[2] as { id: string }).id, "moderated");
  assert.doesNotMatch(JSON.stringify(sends.slice(2)), /seqm-discord/);
});

test("/moderated asks only for the customer and does not write before Submit", async () => {
  await saveGuildSetup(setup as never);
  const pending = interaction("moderated", {
    uploader: "Uploader", publisher: "Publisher", customer: "Customer", shirtid: "88",
  });
  await handleUniformCommand(pending as never, setup as never);
  const review = pending.edits[0] as { components: Array<{ components: Array<{ data: { custom_id: string } }> }> };
  assert.equal(review.components.length, 2);
  assert.match(componentId(review, 0), /^uniform:customer:/);
  assert.equal(rows.get("Moderated Logs"), undefined);
  assert.equal(sends.length, 0);
});

test("customer controls bind the saved message, survive store reload, and do not duplicate purchase pings", async () => {
  await saveUniformDelivery({
    submissionId: "customer-purchase", guildId: guild.id, command: "log", actorId: "submitter",
    customerId: "customer-discord", seqmId: "seqm-discord", destinationChannelId: "customer-channel",
    uploadLogChannelId: "log", spreadsheet: setup.uniforms!.spreadsheet!, rows: [],
    sheetState: "saved", customerName: "Customer", assets: [{ id: 99, url: "https://www.roblox.com/catalog/99" }],
    logNoticeState: "sent", customerDeliveryState: "sent", customerMessageId: "customer-message", createdAt: new Date().toISOString(),
  });
  resetUniformDeliveryStoreForTests();
  await assert.rejects(handleUniformCustomerButton({
    customId: "uniform:purchase:customer-purchase", guild, guildId: guild.id, channelId: "customer-channel",
    message: { id: "customer-message" }, user: { id: "other-user" },
  } as never), /Only the selected customer/i);
  const edits: unknown[] = [];
  const click = {
    customId: "uniform:purchase:customer-purchase", guild, guildId: guild.id, channelId: "customer-channel",
    message: { id: "customer-message" }, user: { id: "customer-discord" },
    deferUpdate: async () => undefined, editReply: async (payload: unknown) => { edits.push(payload); },
    update: async (payload: unknown) => { edits.push(payload); },
  };
  await handleUniformCustomerButton(click as never);
  assert.equal(sends.length, 1);
  const delivered = (sends[0] as { payload: { content: string; allowedMentions: { users: string[] } } }).payload;
  assert.equal(delivered.content, "<@seqm-discord>");
  assert.deepEqual(delivered.allowedMentions.users, ["seqm-discord"]);
  assert.equal((await getUniformDelivery("customer-purchase"))?.terminal, "purchased");
  await handleUniformCustomerButton(click as never);
  assert.equal(sends.length, 1);
  assert.equal((edits[0] as { components: unknown[] }).components.length, 1);
});

test("moderated assistance opens an initial modal and posts an escaped request without a SEQM ping", async () => {
  await saveUniformDelivery({
    submissionId: "customer-assist", guildId: guild.id, command: "moderated", actorId: "submitter",
    customerId: "customer-discord", seqmId: "", destinationChannelId: "customer-channel",
    uploadLogChannelId: "moderated", spreadsheet: setup.uniforms!.spreadsheet!, rows: [],
    sheetState: "saved", customerName: "Customer", assets: [{ id: 100, url: "https://www.roblox.com/catalog/100" }],
    logNoticeState: "sent", customerDeliveryState: "sent", customerMessageId: "assist-message", createdAt: new Date().toISOString(),
  });
  let modalShown = false;
  await handleUniformCustomerButton({
    customId: "uniform:assist:customer-assist", guild, guildId: guild.id, channelId: "customer-channel",
    message: { id: "assist-message" }, user: { id: "customer-discord" },
    showModal: async () => { modalShown = true; },
  } as never);
  assert.equal(modalShown, true);
  let originalDisabled = false;
  const replies: unknown[] = [];
  await handleUniformAssistanceModal({
    customId: "uniform:assist-modal:customer-assist", guild, guildId: guild.id, channelId: "customer-channel",
    user: { id: "customer-discord" }, fields: { getTextInputValue: () => "@everyone [spoof](https://bad.example)" },
    deferReply: async () => undefined,
    channel: { messages: { fetch: async () => ({ edit: async () => { originalDisabled = true; } }) } },
    editReply: async (payload: unknown) => { replies.push(payload); },
  } as never);
  assert.equal(originalDisabled, true);
  const request = (sends[0] as { payload: { content: string; allowedMentions: { users?: string[] }; embeds: Array<{ data: { fields: Array<{ value: string }> } }> } }).payload;
  assert.equal(request.content, "A customer assistance request was posted.");
  assert.deepEqual(request.allowedMentions, { parse: [] });
  assert.match(request.embeds[0]!.data.fields[0]!.value, /@\u200b+everyone.*\\\[/);
  assert.equal((await getUniformDelivery("customer-assist"))?.terminal, "assistance");
  assert.equal(replies.length, 1);
});

test("does not notify when Google Sheets is pending and keeps duplicate delivery idempotent", async () => {
  sheetFailure = new Error("connector unavailable");
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "1",
  });
  assert.equal(sends.length, 0);
  sheetFailure = undefined;
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "2",
  }, "duplicate-delivery");
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "2",
  }, "duplicate-delivery");
  assert.equal(rows.get("Uniform Logs")?.length, 1);
  assert.equal(sends.length, 2);
});

test("durable retry freezes original sheet configuration across settings changes", async () => {
  sheetFailure = new Error("temporary Sheets outage");
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "55",
  }, "frozen-retry");
  const pending = await getUniformDelivery("frozen-retry");
  assert.equal(pending?.sheetState, "prepared");
  assert.equal(pending?.spreadsheet.spreadsheetId, "sheet");
  sheetFailure = undefined;
  await saveUniformSpreadsheetSettings(guild as never, setup as never, "upload-admin", {
    spreadsheetId: "changed-sheet", logTab: "Uniform Logs", moderatedTab: "Moderated Logs",
    logRange: "C5:G", moderatedRange: "C5:F",
  });
  resetUniformDeliveryStoreForTests();
  const retryEdits: unknown[] = [];
  await handleUniformRetryButton({
    customId: "uniform:retry:frozen-retry", guild, guildId: guild.id, user: { id: "submitter" },
    deferUpdate: async () => undefined, editReply: async (payload: unknown) => { retryEdits.push(payload); },
  } as never, async () => false);
  const completed = await getUniformDelivery("frozen-retry");
  assert.equal(completed?.sheetState, "saved");
  assert.equal(completed?.spreadsheet.spreadsheetId, "sheet");
  assert.equal(rows.get("Uniform Logs")?.length, 1);
  assert.equal(sends.length, 2);
  assert.equal(retryEdits.length, 1);
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
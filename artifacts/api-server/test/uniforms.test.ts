import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { deflateSync } from "node:zlib";
import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";
import { purchaseFooterLines } from "../src/bot/purchase-footers";

const directory = await mkdtemp(path.join(os.tmpdir(), "uniform-command-tests-"));
process.env.BOT_SETUP_FILE = path.join(directory, "setup.json");
process.env.UNIFORM_SUBMISSION_LEDGER_FILE = path.join(directory, "ledger.json");
process.env.UNIFORM_DELIVERY_FILE = path.join(directory, "deliveries.json");

const {
  canSubmitUniforms, handleUniformAssistanceModal, handleUniformCommand, handleUniformCustomerButton,
  handleUniformPublishingButton, handleUniformPublishingModal, handleUniformPublishingModerationSelect, handleUniformRelogCommand,
  handleUniformRelogPublishingButton, handleUniformRelogPublishingModal,
  handleUniformRetryButton, handleUniformSubmitButton, handleUniformUserSelection, parseUniformAssetInput,
  recoverPendingUniformReviews, resetUniformSubmissionStateForTests, saveUniformSettings,
  saveUniformSpreadsheetSettings, uniformCommands, uniformSheetRows,
  UniformDeliveryRecoveryError, uniformDeliveryRecoveryResponse, validateUniformSettings,
} = await import("../src/bot/uniforms.ts");
const { getRobloxGroupUrl, verifyUploadedClassicShirt } = await import("../src/bot/roblox.ts");
const { setGoogleSheetsProxyForTests, resetGoogleSheetsProxyForTests } =
  await import("../src/bot/google-sheets.ts");
const {
  claimUniformDeliveryAction, claimUniformDeliveryStage, getUniformDelivery, recoverLegacyNonceRejectedDelivery, resetUniformDeliveryStoreForTests,
  saveUniformDelivery, uniformDiscordNonce,
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
let unownedAssetIds = new Set<number>();
let inventoryResponseStatus = 200;
let inventoryRequestCount = 0;
let economyResponseStatus = 200;
let economyRequestCount = 0;
let thumbnailState = "Pending";
function pngCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
}
const pngHeader = Buffer.alloc(13);
pngHeader.writeUInt32BE(585, 0);
pngHeader.writeUInt32BE(559, 4);
pngHeader.set([8, 6, 0, 0, 0], 8);
const rawPngRows = Buffer.alloc((1 + 585 * 4) * 559);
const classicShirtPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk("IHDR", pngHeader),
  pngChunk("IDAT", deflateSync(rawPngRows)),
  pngChunk("IEND", Buffer.alloc(0)),
]);
const malformedScanlinePng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk("IHDR", pngHeader),
  pngChunk("IDAT", deflateSync(Buffer.from([0]))),
  pngChunk("IEND", Buffer.alloc(0)),
]);
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url === "https://cdn.discordapp.com/uniform.png") {
    return new Response(classicShirtPng, { status: 200, headers: { "content-type": "image/png" } });
  }
  if (url === "https://cdn.discordapp.com/malformed.png") {
    return new Response(malformedScanlinePng, { status: 200, headers: { "content-type": "image/png" } });
  }
  const published = /economy\.roblox\.com\/v2\/assets\/(\d+)\/details/.exec(url);
  if (published) {
    economyRequestCount += 1;
    if (economyResponseStatus !== 200) {
      return new Response("", { status: economyResponseStatus });
    }
    const id = Number(published[1]);
    return response({ AssetId: id, AssetTypeId: 11, Name: "Customer", Description: "ClassA", IsForSale: true });
  }
  const thumbnail = /thumbnails\.roblox\.com\/v1\/assets\?assetIds=(\d+)/.exec(url);
  if (thumbnail) {
    return response({ data: [{ targetId: Number(thumbnail[1]), state: thumbnailState, imageUrl: "https://example.invalid/pending.png" }] });
  }
  const ownership = /inventory\.roblox\.com\/v1\/users\/(\d+)\/items\/Asset\/(\d+)\/is-owned/.exec(url);
  if (ownership) {
    inventoryRequestCount += 1;
    if (inventoryResponseStatus !== 200) {
      return new Response("", { status: inventoryResponseStatus });
    }
    return new Response(
      JSON.stringify(!unownedAssetIds.has(Number(ownership[2]))),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  const username = JSON.parse(String(init?.body)).usernames[0] as string;
  return new Response(JSON.stringify({ data: users.has(username) ? [users.get(username)] : [] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};

const rows = new Map<string, unknown[][]>();
let sends: unknown[] = [];
let auditMessageEdits: Array<{ id: string; payload: unknown }> = [];
const sentMessages = new Set<string>();
let auditEditFailure: Error | undefined;
let sendFailure: Error | undefined;
let rejectLongDiscordNonces = false;
let unknownMessageNonceFailures = 0;
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
  const relogRow = /\/values\/'[^']+'!A(\d+):E\1\?/.exec(decodeURIComponent(pathname));
  if (options?.method === "PUT" && relogRow) {
    const rowIndex = Number(relogRow[1]) - 2;
    const current = rows.get(tab) ?? [];
    if (current[rowIndex]) {
      current[rowIndex] = [...(body.values[0] ?? [])];
      rows.set(tab, current);
      return response({});
    }
  }
  const relogCell = /\/values\/'[^']+'!E(\d+)\?/.exec(decodeURIComponent(pathname));
  if (options?.method === "PUT" && relogCell) {
    const rowIndex = Number(relogCell[1]) - 2;
    const current = rows.get(tab) ?? [];
    if (current[rowIndex]) current[rowIndex]![current[rowIndex]!.length - 1] = body.values[0]?.[0];
    rows.set(tab, current);
    return response({});
  }
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
      ...member,
      id: typeof request === "string" ? request : request.user,
      displayName: (typeof request === "string" ? request : request.user) === "seqm-discord"
        ? "Senior Publisher"
        : "Publishing Quartermaster",
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
      name: id === "customer-channel" ? "ticket-uniforms" : `${id}-audit`,
      permissionsFor: () => ({ has: () => true }),
      send: async (payload: unknown) => {
        if (sendFailure) throw sendFailure;
        const nonce = (payload as { nonce?: unknown }).nonce;
        if (unknownMessageNonceFailures > 0 && typeof nonce === "string") {
          unknownMessageNonceFailures -= 1;
          throw Object.assign(new Error("Unknown Message"), { status: 404, code: 10008 });
        }
        if (rejectLongDiscordNonces && typeof nonce === "string" && nonce.length > 25) {
          throw Object.assign(new Error("Invalid Form Body"), { status: 400, code: 50035 });
        }
        sends.push({ id, payload });
        const messageId = `notice-${sends.length}`;
        sentMessages.add(messageId);
        return { id: messageId };
      },
      messages: {
        fetch: async (messageId: string) => sentMessages.has(messageId)
          ? { edit: async (payload: unknown) => {
            if (auditEditFailure) throw auditEditFailure;
            auditMessageEdits.push({ id: messageId, payload });
          } }
          : null,
      },
    };
  } },
  roles: { fetch: async () => ({ guild: { id: "guild" } }) },
};
const setup = {
  guildId: "guild", moderatorRoleId: "mod", auditChannelId: "audit", updatedBy: "owner", updatedAt: new Date().toISOString(),
  commandPermissions: {
    log: { roleIds: ["20000000000000001"], memberIds: [] },
    moderated: { roleIds: ["20000000000000001"], memberIds: [] },
    relog: { roleIds: ["20000000000000001"], memberIds: [] },
  },
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
    client: { user: { username: "QuartermasterBot" } },
    options: { getString: (name: string, required?: boolean) => {
      const value = values[name];
      if (required && !value) throw new Error(`missing ${name}`);
      return value ?? null;
    }, getAttachment: (name: string, required?: boolean) => {
      const value = values[name];
      if (required && !value) throw new Error(`missing ${name}`);
      return value ? {
        name: `${name}.png`,
        contentType: "image/png",
        size: value === "malformed" ? malformedScanlinePng.length : classicShirtPng.length,
        url: value === "malformed"
          ? "https://cdn.discordapp.com/malformed.png"
          : "https://cdn.discordapp.com/uniform.png",
      } : null;
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
  rows.clear(); sends = []; auditMessageEdits = []; sentMessages.clear(); auditEditFailure = undefined; sendFailure = undefined; sheetFailure = undefined;
  rejectLongDiscordNonces = false; unknownMessageNonceFailures = 0; sheetValidationGate = undefined;
  unownedAssetIds = new Set(); inventoryResponseStatus = 200; inventoryRequestCount = 0;
  economyResponseStatus = 200; economyRequestCount = 0; thumbnailState = "Pending";
  resetUniformSubmissionStateForTests(); resetUniformDeliveryStoreForTests();
});
after(() => { globalThis.fetch = originalFetch; resetGoogleSheetsProxyForTests(); });

test("registers /created with only its required customer and upload inputs", () => {
  assert.equal(uniformCommands[0]!.toJSON().name, "created");
  assert.deepEqual(uniformCommands[0]!.toJSON().options?.map((option) => option.name),
    ["customer", "uniform_type", "channel", "uniform", "uniform2", "uniform_type2", "uniform3", "uniform_type3", "uniform4", "uniform_type4", "uniform5", "uniform_type5"]);
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
  assert.equal(uniformCommands[0]!.toJSON().options?.[2]?.name, "channel");
  assert.equal(uniformCommands[0]!.toJSON().options?.[3]?.name, "uniform");
   assert.equal(uniformCommands[0]!.toJSON().options?.slice(3).filter((option) => option.required).length, 1);
  assert.equal(uniformCommands[1]!.toJSON().options?.[4]?.name, "channel");
});

test("submits two and five ordered shirt attachments in one publishing handoff", async () => {
  for (const [id, values, count] of [
    ["multi-two", { customer: "Customer", seqm: "SEQM", qm: "QM", uniform_type: "ClassA", uniform: "one", uniform2: "two", uniform_type2: "DressBlue" }, 2],
    ["multi-five", { customer: "Customer", seqm: "SEQM", qm: "QM", uniform_type: "ClassA", uniform: "one", uniform2: "two", uniform_type2: "DressBlue", uniform3: "three", uniform_type3: "Khaki", uniform4: "four", uniform_type4: "Flight", uniform5: "five", uniform_type5: "Overcoat" }, 5],
  ] as const) {
    await prepareAndSubmit("log", values, id);
    const record = await getUniformDelivery(id);
    assert.equal(record?.publishing?.attachments?.length, count);
    const handoff = sends.find((entry) => (entry as { id: string }).id === "log") as { payload: { files: unknown[] } };
    assert.equal(handoff.payload.files.length, count);
    rows.clear(); sends = []; sentMessages.clear();
    resetUniformSubmissionStateForTests(); resetUniformDeliveryStoreForTests();
  }
});

test("rejects a gap in ordered optional shirt attachments", async () => {
  await saveGuildSetup(setup as never);
  const commandInteraction = interaction("log", {
    customer: "Customer", seqm: "SEQM", qm: "QM", uniform_type: "ClassA", uniform: "one", uniform3: "three", uniform_type3: "DressBlue",
  }, "multi-gap");
  await assert.rejects(
    handleUniformCommand(commandInteraction as never, setup as never),
    /without gaps/i,
  );
});

test("requires one matching uniform type for every optional shirt", async () => {
  await assert.rejects(
    handleUniformCommand(interaction("log", {
      customer: "Customer", seqm: "SEQM", qm: "QM",
      uniform_type: "ClassA", uniform: "one", uniform2: "two",
    }, "multi-missing-type") as never, setup as never),
    /uniform type for Shirt 2/i,
  );
  await assert.rejects(
    handleUniformCommand(interaction("log", {
      customer: "Customer", seqm: "SEQM", qm: "QM",
      uniform_type: "ClassA", uniform: "one", uniform_type2: "DressBlue",
    }, "multi-orphan-type") as never, setup as never),
    /type cannot be selected without Shirt 2/i,
  );
});

test("persists selected moderated shirt indexes on a multi-shirt handoff", async () => {
  await prepareAndSubmit("log", {
    customer: "Customer", seqm: "SEQM", qm: "QM", uniform_type: "ClassA", uniform: "one", uniform2: "two", uniform_type2: "DressBlue",
  }, "multi-select");
  const before = await getUniformDelivery("multi-select");
  assert.equal(before?.publishing?.state, "awaiting-result");
  await handleUniformPublishingModerationSelect({
    customId: "uniform:publish-moderated-select:multi-select",
    guild, guildId: guild.id, user: { id: "seqm-discord" }, values: ["1"],
    message: { id: "notice-1" }, update: async () => undefined,
  } as never);
  assert.deepEqual((await getUniformDelivery("multi-select"))?.publishing?.moderatedIndices, [1]);
});

test("completes a mixed multi-shirt result with one link and deferred moderation copy", async () => {
  await prepareAndSubmit("log", {
    customer: "Customer", seqm: "SEQM", qm: "QM", uniform_type: "ClassA", uniform: "one", uniform2: "two", uniform_type2: "DressBlue",
  }, "multi-mixed");
  await handleUniformPublishingModerationSelect({
    customId: "uniform:publish-moderated-select:multi-mixed",
    guild, guildId: guild.id, user: { id: "seqm-discord" }, values: ["1"],
    message: { id: "notice-1" }, update: async () => undefined,
  } as never);
  let shownModal: unknown;
  await handleUniformPublishingButton({
    customId: "uniform:publish-success:multi-mixed",
    guild, guildId: guild.id, user: { id: "seqm-discord" }, message: { id: "notice-1" },
    showModal: async (modal: unknown) => { shownModal = modal; },
  } as never);
  assert.match(JSON.stringify(shownModal), /catalog_link_0/);
  const edits: unknown[] = [];
  await handleUniformPublishingModal({
    customId: "uniform:publish-modal:multi-mixed",
    guild, guildId: guild.id, user: { id: "seqm-discord" },
    fields: { getTextInputValue: (id: string) => id === "catalog_link_0" ? "https://www.roblox.com/catalog/9001" : "" },
    deferReply: async () => undefined,
    editReply: async (payload: unknown) => { edits.push(payload); },
  } as never);
  assert.equal(rows.get("Uniform Logs")?.length, 1);
  assert.equal(rows.get("Moderated Logs")?.length, 1);
  assert.equal((await getUniformDelivery("multi-mixed"))?.assets.length, 1);
  assert.match(JSON.stringify(sends.find((entry) => (entry as { id: string }).id === "customer-channel")), /moderated and will be sent at a later date/i);
});

test("retries four temporary HTTP 400 responses while checking a new SEQM upload", async () => {
  economyResponseStatus = 400;
  await assert.rejects(
    verifyUploadedClassicShirt(123),
    /still processing or moderating this Classic Shirt/,
  );
  assert.equal(economyRequestCount, 4);
});

function pendingModerationRecord(submissionId: string) {
  return {
    submissionId, guildId: guild.id, command: "log" as const, actorId: "submitter",
    customerId: "customer-discord", seqmId: "seqm-discord",
    destinationChannelId: "customer-channel", uploadLogChannelId: "review",
    spreadsheet: {
      spreadsheetId: "sheet", logTab: "Uniform Logs", moderatedTab: "Moderated Logs",
      logRange: "A2:E", moderatedRange: "A2:D",
    },
    rows: [["Publishing Quartermaster", "Senior Publisher", "Pending", "Customer", ""]],
    sheetState: "prepared" as const,
    assets: [{ id: 123, url: "https://www.roblox.com/catalog/123" }],
    customerName: "Customer", customerRobloxId: 4,
    publishing: {
      state: "moderation-pending" as const, stage: "seqm-review" as const,
      uniformType: "ClassA", publisherName: "Pending",
      publisherChannelId: "publisher", moderatedChannelId: "moderated",
      seqmRoleId: "20000000000000001", seqmName: "Senior Publisher",
      approvedAsset: { id: 123, url: "https://www.roblox.com/catalog/123" },
      attachment: {
        name: "uniform.png", contentType: "image/png" as const,
        size: classicShirtPng.length, url: "https://cdn.discordapp.com/uniform.png",
      },
      handoffMessageId: "review-message",
    },
    logNoticeState: "sent" as const, customerDeliveryState: "pending" as const,
    createdAt: new Date().toISOString(),
  };
}

test("startup releases a previously pending manually reviewed shirt exactly once without Roblox", async () => {
  sentMessages.add("review-message");
  await saveUniformDelivery(pendingModerationRecord("pending-completed"));
  economyResponseStatus = 400;
  thumbnailState = "Blocked";
  await recoverPendingUniformReviews(guild as never);
  await recoverPendingUniformReviews(guild as never);
  const completed = await getUniformDelivery("pending-completed");
  assert.equal(completed?.publishing?.stage, "publisher");
  assert.equal(completed?.publishing?.state, "awaiting-result");
  assert.equal(sends.filter((entry) => (entry as { id: string }).id === "publisher").length, 1);
  assert.equal(economyRequestCount, 0);
  assert.equal(rows.get("Uniform Logs"), undefined);
});

test("SEQM sends an already published shirt directly to the customer and is recorded as publisher", async () => {
  const record = pendingModerationRecord("seqm-already-published");
  record.publishing.state = "awaiting-result";
  await saveUniformDelivery(record);
  sentMessages.add("review-message");
  const edits: unknown[] = [];
  await handleUniformPublishingModal({
    customId: "uniform:publish-modal:seqm-already-published",
    guild, guildId: guild.id, user: { id: "seqm-discord" },
    fields: { getTextInputValue: () => "https://www.roblox.com/catalog/123" },
    deferReply: async () => undefined,
    editReply: async (payload: unknown) => { edits.push(payload); },
  } as never);
  assert.deepEqual(rows.get("Uniform Logs"), [[
    "Publishing Quartermaster", "Senior Publisher", "Senior Publisher",
    "Customer", "https://www.roblox.com/catalog/123",
  ]]);
  assert.equal(sends.filter((entry) => (entry as { id: string }).id === "publisher").length, 0);
  assert.equal(sends.filter((entry) => (entry as { id: string }).id === "customer-channel").length, 1);
  assert.equal((await getUniformDelivery("seqm-already-published"))?.publishing?.state, "published");
  assert.match(JSON.stringify(edits), /Already Published And Delivered/);
});

test("SEQM still forwards a manually approved shirt when Roblox cannot confirm it is published", async () => {
  const record = pendingModerationRecord("seqm-needs-publisher");
  record.publishing.state = "awaiting-result";
  await saveUniformDelivery(record);
  sentMessages.add("review-message");
  economyResponseStatus = 400;
  await handleUniformPublishingModal({
    customId: "uniform:publish-modal:seqm-needs-publisher",
    guild, guildId: guild.id, user: { id: "seqm-discord" },
    fields: { getTextInputValue: () => "https://www.roblox.com/catalog/123" },
    deferReply: async () => undefined,
    editReply: async () => undefined,
  } as never);
  const saved = await getUniformDelivery("seqm-needs-publisher");
  assert.equal(saved?.publishing?.stage, "publisher");
  assert.equal(saved?.publishing?.state, "awaiting-result");
  assert.equal(sends.filter((entry) => (entry as { id: string }).id === "publisher").length, 1);
  assert.equal(sends.filter((entry) => (entry as { id: string }).id === "customer-channel").length, 0);
  assert.equal(rows.get("Uniform Logs"), undefined);
});

test("rejects invalid Roblox group identifiers before constructing a provider URL", () => {
  assert.equal(getRobloxGroupUrl("123"), "https://www.roblox.com/communities/123");
  assert.throws(() => getRobloxGroupUrl("0"), /positive safe integer/i);
  assert.throws(() => getRobloxGroupUrl("9007199254740992"), /positive safe integer/i);
  assert.throws(() => getRobloxGroupUrl("123/../../private"), /positive safe integer/i);
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

test("holds an attachment submission until a verified Classic Shirt link completes the handoff", async () => {
  await saveGuildSetup(setup as never);
  const commandInteraction = interaction("log", {
    customer: "Customer", seqm: "SEQM", qm: "QM",
    uniform_type: "ClassA_HG", uniform: "yes",
  }, "attachment-handoff");
  await handleUniformCommand(commandInteraction as never, setup as never);
  const nonce = componentId(commandInteraction.edits[0], 0).split(":")[2]!;
  await handleUniformUserSelection({
    customId: `uniform:customer:${nonce}`, guild, guildId: guild.id,
    user: { id: "submitter" }, values: ["customer-discord"], update: async () => undefined,
  } as never);
  await handleUniformUserSelection({
    customId: `uniform:seqm:${nonce}`, guild, guildId: guild.id,
    user: { id: "submitter" }, values: ["seqm-discord"], update: async () => undefined,
  } as never);
  await handleUniformSubmitButton({
    customId: `uniform:submit:${nonce}`, guild, guildId: guild.id,
    user: { id: "submitter" }, deferUpdate: async () => undefined,
    editReply: async (payload: unknown) => { commandInteraction.edits.push(payload); },
  } as never, async () => false);

  assert.equal(rows.get("Uniform Logs"), undefined);
  assert.equal(sends.length, 1);
  const handoff = sends[0] as { id: string; payload: {
    content: string; files: unknown[]; embeds: Array<{ data: { fields: Array<{ name: string; value: string }> } }>;
  } };
  assert.equal(handoff.id, "log");
  assert.equal(handoff.payload.content, "<@&1548958021160411216>");
  assert.equal(handoff.payload.files.length, 1);
  assert.match(JSON.stringify(handoff.payload.embeds), /ClassA_HG/);
  const awaiting = await getUniformDelivery("attachment-handoff");
  assert.equal(awaiting?.publishing?.state, "awaiting-result");
  assert.equal(awaiting?.publishing?.sourceDataBase64, undefined);
  await assert.rejects(
    handleUniformRetryButton({
      customId: "uniform:retry:attachment-handoff",
      guild, guildId: guild.id, user: { id: "submitter" },
      deferUpdate: async () => undefined,
    } as never, async () => false),
    /awaiting a Roblox publishing result/i,
  );
  assert.equal(rows.get("Uniform Logs"), undefined);
  assert.equal(sends.length, 1);

  let shownModal: unknown;
  await handleUniformPublishingButton({
    customId: "uniform:publish-success:attachment-handoff",
    guild, guildId: guild.id, user: { id: "submitter" },
    message: { id: "notice-1" },
    showModal: async (modal: unknown) => { shownModal = modal; },
  } as never);
  assert.match(JSON.stringify(shownModal), /catalog_link/);

  const completionEdits: unknown[] = [];
  await handleUniformPublishingModal({
    customId: "uniform:publish-modal:attachment-handoff",
    guild, guildId: guild.id, user: { id: "submitter" },
    fields: { getTextInputValue: () => "https://www.roblox.com/catalog/9001" },
    deferReply: async () => undefined,
    editReply: async (payload: unknown) => { completionEdits.push(payload); },
  } as never);
  assert.deepEqual(rows.get("Uniform Logs"), [[
    "QM", "SEQM", "Publishing Quartermaster", "Customer", "https://www.roblox.com/catalog/9001",
  ]]);
  assert.equal(sends.length, 2);
  assert.equal((sends[1] as { id: string }).id, "customer-channel");
  const completed = await getUniformDelivery("attachment-handoff");
  assert.equal(completed?.publishing?.state, "published");
  assert.deepEqual(completed?.assets, [{ id: 9001, url: "https://www.roblox.com/catalog/9001" }]);
  assert.match(JSON.stringify(completionEdits), /Uniform Published And Delivered/);
});

test("routes a rejected attachment only to the moderated sheet and Senior Quartermaster", async () => {
  await saveGuildSetup(setup as never);
  const commandInteraction = interaction("log", {
    customer: "Customer", seqm: "SEQM", qm: "QM",
    uniform_type: "DressBlue", uniform: "yes",
  }, "attachment-moderated");
  await handleUniformCommand(commandInteraction as never, setup as never);
  const nonce = componentId(commandInteraction.edits[0], 0).split(":")[2]!;
  await handleUniformUserSelection({
    customId: `uniform:customer:${nonce}`, guild, guildId: guild.id,
    user: { id: "submitter" }, values: ["customer-discord"], update: async () => undefined,
  } as never);
  await handleUniformUserSelection({
    customId: `uniform:seqm:${nonce}`, guild, guildId: guild.id,
    user: { id: "submitter" }, values: ["seqm-discord"], update: async () => undefined,
  } as never);
  await handleUniformSubmitButton({
    customId: `uniform:submit:${nonce}`, guild, guildId: guild.id,
    user: { id: "submitter" }, deferUpdate: async () => undefined,
    editReply: async () => undefined,
  } as never, async () => false);
  const edits: unknown[] = [];
  await handleUniformPublishingButton({
    customId: "uniform:publish-moderated:attachment-moderated",
    guild, guildId: guild.id, user: { id: "submitter" },
    message: { id: "notice-1" },
    deferUpdate: async () => undefined,
    editReply: async (payload: unknown) => { edits.push(payload); },
  } as never);
  assert.equal(rows.get("Uniform Logs"), undefined);
  assert.deepEqual(rows.get("Moderated Logs"), [["QM", "Publishing Quartermaster", "Customer", ""]]);
  assert.equal(sends.length, 2);
  assert.equal((sends[1] as { id: string }).id, "moderated");
  assert.equal((sends[1] as { payload: { content: string } }).payload.content, "<@seqm-discord>");
  assert.ok(sends.every((message) => (message as { id: string }).id !== "customer-channel"));
  assert.equal((await getUniformDelivery("attachment-moderated"))?.publishing?.state, "moderated");
  assert.match(JSON.stringify(edits), /Moderation Denial Recorded/);
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
  assert.equal((await getUniformDelivery("notice-retry"))?.logNoticeState, "unresolved");
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

test("rejects invalid usernames, malformed legacy assets, and unapproved uniform types before notification", async () => {
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
      qm: "QM", seqm: "SEQM", customer: "Customer", uniform_type: "Unapproved", uniform: "yes",
    }) as never, setup as never), /approved Army, Marines, or Navy/i,
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

test("writes one /log row before one notice and routes /moderated separately", async () => {
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer",
    shirtid1: "1",
  });
  assert.equal(rows.get("Uniform Logs")?.length, 1);
  assert.equal(sends.length, 2);
  await prepareAndSubmit("moderated", {
    uploader: "Uploader", publisher: "Publisher", customer: "Customer", shirtid: "77",
  });
  assert.deepEqual(rows.get("Moderated Logs"), [["Uploader", "Publisher", "Customer", "https://www.roblox.com/catalog/77"]]);
  assert.equal((sends[2] as { id: string }).id, "moderated");
  assert.doesNotMatch(JSON.stringify(sends.slice(2)), /seqm-discord/);
});

test("uses frozen Roblox credits and the catalog link in quiet upload audits", async () => {
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer",
    shirtid1: "1",
  });
  const logAudit = (sends[0] as { id: string; payload: {
    content: string; allowedMentions: { parse: unknown[] }; embeds: Array<{ data: {
      title: string; fields: Array<{ name: string; value: string }>;
    } }>;
  } }).payload;
  assert.equal(logAudit.content, "");
  assert.deepEqual(logAudit.allowedMentions, { parse: [] });
  assert.match(logAudit.embeds[0]!.data.title, /Uniform Upload Logged$/);
  assert.doesNotMatch(logAudit.embeds[0]!.data.title, /Sold/i);
  assert.deepEqual(
    logAudit.embeds[0]!.data.fields.map((field) => field.name),
    ["Ticket Channel", "Requested by", "Senior Quartermaster", "Publisher", "Quartermaster", "Uniform Links"],
  );
  assert.equal(logAudit.embeds[0]!.data.fields[0]!.value, "ticket-uniforms");
  assert.equal(logAudit.embeds[0]!.data.fields[1]!.value, "Customer");
  assert.equal(logAudit.embeds[0]!.data.fields[2]!.value, "SEQM");
  assert.equal(logAudit.embeds[0]!.data.fields[4]!.value, "QM");
  assert.match(logAudit.embeds[0]!.data.fields[5]!.value, /Uniform 1.*catalog\/1/);
  assert.doesNotMatch(JSON.stringify(logAudit), /<@|@everyone|@here/);

  await prepareAndSubmit("moderated", {
    uploader: "Uploader", publisher: "Publisher", customer: "Customer", shirtid: "77",
  });
  const moderatedAudit = (sends[2] as { payload: { embeds: Array<{ data: { fields: Array<{ name: string; value: string }> } }> } }).payload;
  assert.deepEqual(
    moderatedAudit.embeds[0]!.data.fields.map((field) => field.name),
    ["Ticket Channel", "Requested by", "Uploaded by", "Published by", "Uniform Links"],
  );
  assert.doesNotMatch(JSON.stringify(moderatedAudit.embeds[0]!.data.fields), /Quartermaster|SEQM/);
});

test("confirms purchase once, credits frozen names, and upgrades its original audit only after Sold", async () => {
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "42",
  }, "purchase-audit");
  const record = await getUniformDelivery("purchase-audit");
  assert.equal(record?.auditMessageId, "notice-1");
  await handleUniformCustomerButton({
    customId: "uniform:purchase:purchase-audit", guild, guildId: guild.id, channelId: "customer-channel",
    message: { id: "notice-2" }, user: { id: "customer-discord" },
    deferUpdate: async () => undefined, editReply: async () => undefined, update: async () => undefined,
  } as never);
  const confirmation = (sends[2] as { payload: {
    content: string; allowedMentions: { parse: unknown[]; users: string[] }; embeds: Array<{ data: {
      title: string; description: string; fields: Array<{ name: string; value: string }>; footer?: { text: string };
    } }>;
  } }).payload;
  assert.equal(confirmation.content, "<@seqm-discord>");
  assert.deepEqual(confirmation.allowedMentions, { parse: [], users: ["seqm-discord"] });
  assert.match(confirmation.embeds[0]!.data.title, /Purchase Confirmed$/);
  assert.equal(confirmation.embeds[0]!.data.description, "Thank you for your purchase. Your ticket will be closed shortly.");
  assert.deepEqual(confirmation.embeds[0]!.data.fields, [
    { name: "Made by", value: "QM", inline: true },
    { name: "Uploaded by", value: "SEQM", inline: true },
    { name: "Published by", value: "Publisher", inline: true },
  ]);
  assert.ok(purchaseFooterLines.some((line) => confirmation.embeds[0]!.data.footer?.text === `QM ${line}`));
  assert.equal(auditMessageEdits.length, 1);
  const soldAudit = auditMessageEdits[0]!.payload as { content: string; allowedMentions: { parse: unknown[] }; embeds: Array<{ data: { title: string } }> };
  assert.equal(soldAudit.content, "");
  assert.deepEqual(soldAudit.allowedMentions, { parse: [] });
  assert.match(soldAudit.embeds[0]!.data.title, /Uniform Sold Successfully$/);
  assert.equal((await getUniformDelivery("purchase-audit"))?.action?.auditState, "sent");
});

test("keeps a purchase pending until Roblox confirms every shirt is owned", async () => {
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer",
    shirtid1: "43",
  }, "ownership-required");
  unownedAssetIds.add(43);
  const edits: unknown[] = [];
  await handleUniformCustomerButton({
    customId: "uniform:purchase:ownership-required", guild, guildId: guild.id,
    channelId: "customer-channel", message: { id: "notice-2" },
    user: { id: "customer-discord" }, deferUpdate: async () => undefined,
    editReply: async (payload: unknown) => { edits.push(payload); }, update: async () => undefined,
  } as never);
  const record = await getUniformDelivery("ownership-required");
  assert.equal(record?.terminal, undefined);
  assert.equal(record?.action, undefined);
  assert.ok((rows.get("Uniform Logs") ?? []).every((row) => !row.includes("Sold")));
  assert.match(JSON.stringify(edits[0]), /Purchase Not Verified/);
  assert.match(JSON.stringify(edits[0]), /Retry Ownership Check/);
  assert.match(JSON.stringify(edits[0]), /catalog\\?\/43|catalog\/43/);
});

test("shows private inventory status and retries transient Roblox failures three times", async () => {
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer",
    shirtid1: "42",
  }, "ownership-retry-status");
  const click = {
    customId: "uniform:purchase:ownership-retry-status", guild, guildId: guild.id,
    channelId: "customer-channel", message: { id: "notice-2" },
    user: { id: "customer-discord" }, deferUpdate: async () => undefined,
  };

  inventoryResponseStatus = 403;
  const privateEdits: unknown[] = [];
  await handleUniformCustomerButton({
    ...click, editReply: async (payload: unknown) => { privateEdits.push(payload); },
  } as never);
  assert.equal(inventoryRequestCount, 1);
  assert.match(JSON.stringify(privateEdits[0]), /Inventory Is Private/);
  assert.match(JSON.stringify(privateEdits[0]), /Retry Ownership Check/);

  inventoryRequestCount = 0;
  inventoryResponseStatus = 503;
  const unavailableEdits: unknown[] = [];
  await handleUniformCustomerButton({
    ...click, editReply: async (payload: unknown) => { unavailableEdits.push(payload); },
  } as never);
  assert.equal(inventoryRequestCount, 3);
  assert.match(JSON.stringify(unavailableEdits[0]), /Roblox Check Unavailable/);
  assert.match(JSON.stringify(unavailableEdits[0]), /three automatic attempts/);
});

test("uses only moderated uploader and publisher credits in a quiet purchase confirmation", async () => {
  await prepareAndSubmit("moderated", {
    uploader: "Uploader", publisher: "Publisher", customer: "Customer", shirtid: "42",
  }, "moderated-purchase-audit");
  await handleUniformCustomerButton({
    customId: "uniform:purchase:moderated-purchase-audit", guild, guildId: guild.id, channelId: "customer-channel",
    message: { id: "notice-2" }, user: { id: "customer-discord" },
    deferUpdate: async () => undefined, editReply: async () => undefined, update: async () => undefined,
  } as never);
  const confirmation = (sends[2] as { payload: {
    content: string; allowedMentions: { parse: unknown[] }; embeds: Array<{ data: {
      fields: Array<{ name: string; value: string }>; footer?: { text: string };
    } }>;
  } }).payload;
  assert.equal(confirmation.content, "A customer has confirmed their purchase.");
  assert.deepEqual(confirmation.allowedMentions, { parse: [] });
  assert.deepEqual(confirmation.embeds[0]!.data.fields, [
    { name: "Uploaded by", value: "Uploader", inline: true },
    { name: "Published by", value: "Publisher", inline: true },
  ]);
  assert.ok(purchaseFooterLines.some((line) => confirmation.embeds[0]!.data.footer?.text === `Publisher ${line}`));
  assert.doesNotMatch(JSON.stringify(confirmation.embeds[0]!.data.fields), /Quartermaster|SEQM/);
});

test("retries a definite purchase-audit failure without duplicating the customer thank-you or SEQM ping", async () => {
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "42",
  }, "purchase-audit-retry");
  const click = {
    customId: "uniform:purchase:purchase-audit-retry", guild, guildId: guild.id, channelId: "customer-channel",
    message: { id: "notice-2" }, user: { id: "customer-discord" },
    deferUpdate: async () => undefined, editReply: async () => undefined, update: async () => undefined,
  };
  auditEditFailure = Object.assign(new Error("Discord rejected audit edit"), { status: 400, code: 50035 });
  await assert.rejects(handleUniformCustomerButton(click as never), /purchase audit/i);
  assert.equal(sends.length, 3);
  assert.equal((await getUniformDelivery("purchase-audit-retry"))?.terminal, "purchased");
  assert.equal((await getUniformDelivery("purchase-audit-retry"))?.action?.auditState, "pending");
  auditEditFailure = undefined;
  await handleUniformCustomerButton(click as never);
  assert.equal(sends.length, 3, "the saved customer acknowledgement must not be replayed");
  assert.equal(auditMessageEdits.length, 1);
  assert.equal((await getUniformDelivery("purchase-audit-retry"))?.action?.auditState, "sent");
});

test("posts a quiet relog audit with the frozen ticket, customer, credits, and replacement link", async () => {
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "42", channel: "relog-ticket",
  }, "relog-audit");
  const edits: unknown[] = [];
  await handleUniformRelogCommand({
    guild, guildId: guild.id, user: { id: "seqm-discord" },
    options: {
      getChannel: () => ({ id: "relog-ticket", type: ChannelType.GuildText }),
      getString: () => "99",
    },
    editReply: async (payload: unknown) => { edits.push(payload); },
  } as never);
  assert.equal((await getUniformDelivery("relog-audit"))?.relog?.state, "sent");
  assert.equal((await getUniformDelivery("relog-audit"))?.relog?.auditState, "sent");
  assert.equal(sends.length, 4);
  const audit = (sends[3] as { id: string; payload: {
    content: string; allowedMentions: { parse: unknown[] }; embeds: Array<{ data: {
      title: string; fields: Array<{ name: string; value: string }>;
    } }>;
  } }).payload;
  assert.equal(audit.content, "");
  assert.deepEqual(audit.allowedMentions, { parse: [] });
  assert.match(audit.embeds[0]!.data.title, /Uniform Updated$/);
  assert.deepEqual(
    audit.embeds[0]!.data.fields.map((field) => field.name),
    ["Ticket Channel", "Requested by", "Senior Quartermaster", "Publisher", "Quartermaster", "Changed Uniform Link"],
  );
  assert.equal(audit.embeds[0]!.data.fields[0]!.value, "relog-ticket-audit");
  assert.equal(audit.embeds[0]!.data.fields[1]!.value, "Customer");
  assert.equal(audit.embeds[0]!.data.fields[5]!.value, "[Uniform 1](https://www.roblox.com/catalog/99)");
  assert.doesNotMatch(JSON.stringify(audit), /<@|@everyone|@here/);
  assert.match(JSON.stringify(edits[0]), /Uniform Link Replaced/);
});

test("keeps the original delivery intact until a replacement PNG is published", async () => {
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer",
    shirtid1: "42", channel: "relog-attachment-ticket",
  }, "relog-attachment");
  const original = await getUniformDelivery("relog-attachment");
  const edits: unknown[] = [];
  await handleUniformRelogCommand({
    guild, guildId: guild.id, user: { id: "seqm-discord" },
    options: {
      getChannel: () => ({ id: "relog-attachment-ticket", type: ChannelType.GuildText }),
      getString: () => null,
      getAttachment: () => ({
        name: "uniform.png", contentType: "image/png", size: classicShirtPng.length,
        url: "https://cdn.discordapp.com/uniform.png",
      }),
    },
    editReply: async (payload: unknown) => { edits.push(payload); },
  } as never);
  const pending = await getUniformDelivery("relog-attachment");
  assert.equal(pending?.relog, undefined);
  assert.equal(pending?.relogHandoff?.state, "awaiting-result");
  assert.equal(pending?.relogHandoff?.sourceDataBase64, undefined);
  assert.equal(pending?.rows[0]?.at(-1), "https://www.roblox.com/catalog/42");
  assert.equal(pending?.customerMessageId, original?.customerMessageId);
  assert.equal(rows.get("Uniform Logs")?.[0]?.at(-1), "https://www.roblox.com/catalog/42");
  assert.match(JSON.stringify(edits[0]), /Replacement Awaiting Roblox Upload/);

  const nonce = pending!.relogHandoff!.nonce;
  let shownModal: unknown;
  await handleUniformRelogPublishingButton({
    customId: `uniform:relog-publish-success:relog-attachment:${nonce}`,
    guild, guildId: guild.id, user: { id: "seqm-discord" },
    message: { id: "notice-3" },
    showModal: async (modal: unknown) => { shownModal = modal; },
  } as never);
  assert.match(JSON.stringify(shownModal), /catalog_link/);

  await handleUniformRelogPublishingModal({
    customId: `uniform:relog-publish-modal:relog-attachment:${nonce}`,
    guild, guildId: guild.id, user: { id: "seqm-discord" },
    fields: { getTextInputValue: () => "https://www.roblox.com/catalog/99" },
    deferReply: async () => undefined,
    editReply: async (payload: unknown) => { edits.push(payload); },
  } as never);
  const completed = await getUniformDelivery("relog-attachment");
  assert.equal(completed?.relogHandoff?.state, "published");
  assert.equal(completed?.relog?.state, "sent");
  assert.equal(completed?.rows[0]?.at(-1), "https://www.roblox.com/catalog/99");
  assert.equal(rows.get("Uniform Logs")?.[0]?.at(-1), "https://www.roblox.com/catalog/99");
  assert.notEqual(completed?.customerMessageId, original?.customerMessageId);
});

test("logs a rejected replacement without changing its successful row or customer message", async () => {
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer",
    shirtid1: "42", channel: "relog-rejected-ticket",
  }, "relog-rejected");
  const original = await getUniformDelivery("relog-rejected");
  await handleUniformRelogCommand({
    guild, guildId: guild.id, user: { id: "seqm-discord" },
    options: {
      getChannel: () => ({ id: "relog-rejected-ticket", type: ChannelType.GuildText }),
      getString: () => null,
      getAttachment: () => ({
        name: "uniform.png", contentType: "image/png", size: classicShirtPng.length,
        url: "https://cdn.discordapp.com/uniform.png",
      }),
    },
    editReply: async () => undefined,
  } as never);
  const pending = await getUniformDelivery("relog-rejected");
  const nonce = pending!.relogHandoff!.nonce;
  await handleUniformRelogPublishingButton({
    customId: `uniform:relog-publish-moderated:relog-rejected:${nonce}`,
    guild, guildId: guild.id, user: { id: "seqm-discord" },
    message: { id: "notice-3" },
    deferUpdate: async () => undefined,
    editReply: async () => undefined,
  } as never);
  const rejected = await getUniformDelivery("relog-rejected");
  assert.equal(rejected?.relogHandoff?.state, "moderated");
  assert.equal(rejected?.relog, undefined);
  assert.equal(rejected?.rows[0]?.at(-1), "https://www.roblox.com/catalog/42");
  assert.equal(rejected?.customerMessageId, original?.customerMessageId);
  assert.equal(rows.get("Uniform Logs")?.[0]?.at(-1), "https://www.roblox.com/catalog/42");
  assert.deepEqual(rows.get("Moderated Logs"), [["QM", "Senior Publisher", "Customer", ""]]);
  assert.ok(sends.every((message, index) =>
    index < 2 || (message as { id: string }).id !== "relog-rejected-ticket"));
});

test("uses deterministic Discord-safe nonces for 19- and 20-digit delivery IDs", async () => {
  rejectLongDiscordNonces = true;
  const nineteenDigits = "1234567890123456789";
  const twentyDigits = "12345678901234567890";
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "12",
  }, nineteenDigits);
  assert.equal(sends.length, 2);
  const deliveryNonces = sends.map(({ payload }) => (payload as { nonce: string }).nonce);
  assert.deepEqual(deliveryNonces, [
    uniformDiscordNonce("notice", nineteenDigits),
    uniformDiscordNonce("customer", nineteenDigits),
  ]);
  assert.ok(deliveryNonces.every((nonce) => nonce.length <= 25));
  assert.notEqual(deliveryNonces[0], deliveryNonces[1]);
  assert.equal(uniformDiscordNonce("notice", nineteenDigits), uniformDiscordNonce("notice", nineteenDigits));

  await saveUniformDelivery({
    submissionId: twentyDigits, guildId: guild.id, command: "moderated", actorId: "submitter",
    customerId: "customer-discord", seqmId: "", destinationChannelId: "customer-channel",
    uploadLogChannelId: "log", spreadsheet: setup.uniforms!.spreadsheet!, rows: [],
    sheetState: "saved", customerName: "Customer", customerRobloxId: 4,
    assets: [{ id: 98, url: "https://www.roblox.com/catalog/98" }],
    logNoticeState: "sent", customerDeliveryState: "sent", customerMessageId: "twenty-digit-message", createdAt: new Date().toISOString(),
  });
  await handleUniformCustomerButton({
    customId: `uniform:purchase:${twentyDigits}`, guild, guildId: guild.id, channelId: "customer-channel",
    message: { id: "twenty-digit-message" }, user: { id: "customer-discord" },
    deferUpdate: async () => undefined, editReply: async () => undefined,
  } as never);
  const actionNonce = ((sends[2] as { payload: { nonce: string } }).payload.nonce);
  assert.equal(actionNonce, uniformDiscordNonce("purchased", twentyDigits));
  assert.ok(actionNonce.length <= 25);
  assert.notEqual(actionNonce, uniformDiscordNonce("assistance", twentyDigits));
});

test("keeps definitive Discord 400 and 403 delivery failures pending with Retry Delivery", async () => {
  for (const status of [400, 403]) {
    const id = `${status}12345678901234567`;
    sendFailure = Object.assign(new Error("Discord rejected delivery"), { status, code: status === 400 ? 50035 : 50013 });
    const result = await prepareAndSubmit("log", {
      qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "13",
    }, id);
    const saved = await getUniformDelivery(id);
    assert.equal(saved?.sheetState, "saved");
    assert.equal(saved?.logNoticeState, "pending");
    assert.equal(saved?.customerDeliveryState, "pending");
    const reply = result.edits.at(-1) as {
      embeds: Array<{ data: { description: string; fields: Array<{ name: string; value: string; inline?: boolean }> } }>;
      components: unknown[];
    };
    assert.match(reply.embeds[0]!.data.description, new RegExp(`HTTP ${status}`));
    assert.match(reply.embeds[0]!.data.description, /Retry Delivery/);
    assert.deepEqual(reply.embeds[0]!.data.fields, [
      { name: "Submission ID", value: `\`${id}\``, inline: true },
    ]);
    assert.equal(componentId(reply, 0), `uniform:retry:${id}`);
    assert.equal(reply.components.length, 1);
    sendFailure = undefined;
  }
});

test("recreates an upload-log notice when Discord retains a nonce for a deleted message", async () => {
  const id = "deleted-upload-log-notice";
  unknownMessageNonceFailures = 1;
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "13",
  }, id);
  const saved = await getUniformDelivery(id);
  assert.equal(saved?.logNoticeState, "sent");
  assert.equal(saved?.customerDeliveryState, "sent");
  assert.equal(sends.length, 2);
  assert.equal((sends[0] as { id: string }).id, "log");
  assert.equal((sends[0] as { payload: { nonce?: string } }).payload.nonce, undefined);
  assert.equal((sends[1] as { id: string }).id, "customer-channel");
});

test("retries a saved definitive Discord failure by submission ID without rewriting Sheets rows", async () => {
  const id = "400987654321098765";
  sendFailure = Object.assign(new Error("Discord rejected delivery"), { status: 400, code: 50035 });
  await prepareAndSubmit("log", {
    qm: "QM", seqm: "SEQM", publisher: "Publisher", customer: "Customer", shirtid1: "13",
  }, id);
  const before = rows.get("Uniform Logs")?.length;
  sendFailure = undefined;
  const edits: unknown[] = [];
  await handleUniformRetryButton({
    customId: `uniform:retry:${id}`, guild, guildId: guild.id, user: { id: "submitter" },
    deferUpdate: async () => undefined, editReply: async (payload: unknown) => { edits.push(payload); },
  } as never, async () => false);
  const saved = await getUniformDelivery(id);
  assert.equal(saved?.logNoticeState, "sent");
  assert.equal(saved?.customerDeliveryState, "sent");
  assert.equal(rows.get("Uniform Logs")?.length, before);
  assert.equal(sends.length, 2);
  assert.match(JSON.stringify(edits[0]), new RegExp(`Submission ID.*${id}`));
});

test("renders an unresolved recovery with its ID and a disabled no-duplicate retry control", async () => {
  const id = "unresolved-recovery";
  await saveUniformDelivery({
    submissionId: id, guildId: guild.id, command: "log", actorId: "submitter",
    customerId: "customer-discord", seqmId: "seqm-discord", destinationChannelId: "customer-channel",
    uploadLogChannelId: "log", spreadsheet: setup.uniforms!.spreadsheet!, rows: [["unchanged"]],
    sheetState: "saved", customerName: "Customer", assets: [{ id: 15, url: "https://www.roblox.com/catalog/15" }],
    logNoticeState: "unresolved", customerDeliveryState: "pending", createdAt: new Date().toISOString(),
  });
  let thrown: unknown;
  await assert.rejects(
    handleUniformRetryButton({
      customId: `uniform:retry:${id}`, guild, guildId: guild.id, user: { id: "submitter" },
      deferUpdate: async () => undefined, editReply: async () => undefined,
    } as never, async () => false).catch((error) => {
      thrown = error;
      throw error;
    }),
    /unresolved/i,
  );
  assert.ok(thrown instanceof UniformDeliveryRecoveryError);
  const recovery = uniformDeliveryRecoveryResponse(thrown as UniformDeliveryRecoveryError) as {
    embeds: Array<{ data: { description: string; fields: Array<{ name: string; value: string }> } }>;
    components: Array<{ components: Array<{ data: { custom_id: string; disabled?: boolean } }> }>;
  };
  assert.equal(recovery.embeds[0]!.data.fields[0]!.value, `\`${id}\``);
  assert.match(recovery.embeds[0]!.data.description, /manual verification|required/i);
  assert.equal(recovery.components[0]!.components[0]!.data.custom_id, `uniform:retry:${id}`);
  assert.equal(recovery.components[0]!.components[0]!.data.disabled, true);
  assert.equal(sends.length, 0);
  assert.equal(rows.get("Uniform Logs"), undefined);
});

test("only a current Administrator can retry a recovered delivery for another submitter", async () => {
  await saveGuildSetup(setup as never);
  await saveUniformDelivery({
    submissionId: "admin-retry", guildId: guild.id, command: "log", actorId: "original-submitter",
    customerId: "customer-discord", seqmId: "seqm-discord", destinationChannelId: "customer-channel",
    uploadLogChannelId: "log", spreadsheet: setup.uniforms!.spreadsheet!, rows: [["unchanged"]],
    sheetState: "saved", customerName: "Customer", assets: [{ id: 14, url: "https://www.roblox.com/catalog/14" }],
    logNoticeState: "sent", customerDeliveryState: "pending", createdAt: new Date().toISOString(),
  });
  let unauthorizedError: unknown;
  await assert.rejects(handleUniformRetryButton({
    customId: "uniform:retry:admin-retry", guild, guildId: guild.id, user: { id: "other-submitter" },
    deferUpdate: async () => undefined, editReply: async () => undefined,
  } as never, async () => false).catch((error) => {
    unauthorizedError = error;
    throw error;
  }), /original authorized submitter or a current Administrator/i);
  assert.ok(unauthorizedError instanceof UniformDeliveryRecoveryError);
  assert.equal(
    (uniformDeliveryRecoveryResponse(unauthorizedError as UniformDeliveryRecoveryError) as { components: unknown[] }).components.length,
    0,
  );
  assert.equal(sends.length, 0);

  const administratorGuild = {
    ...guild,
    members: {
      ...guild.members,
      fetch: async (request: string | { user: string }) => {
        const id = typeof request === "string" ? request : request.user;
        return {
          ...member, id, guild: { id: guild.id },
          permissions: { has: () => id === "delivery-admin" },
        };
      },
    },
  };
  await handleUniformRetryButton({
    customId: "uniform:retry:admin-retry", guild: administratorGuild, guildId: guild.id, user: { id: "delivery-admin" },
    deferUpdate: async () => undefined, editReply: async () => undefined,
  } as never, async () => false);
  assert.equal(sends.length, 1);
  assert.equal(rows.get("Uniform Logs"), undefined, "a saved delivery retry must not write Sheets rows");
});

test("does not infer legacy recovery eligibility for a generic unresolved delivery", async () => {
  await saveUniformDelivery({
    submissionId: "9876543210987654321", guildId: guild.id, command: "log", actorId: "submitter",
    customerId: "customer-discord", seqmId: "seqm-discord", destinationChannelId: "customer-channel",
    uploadLogChannelId: "log", spreadsheet: setup.uniforms!.spreadsheet!, rows: [],
    sheetState: "saved", customerName: "Customer", assets: [{ id: 15, url: "https://www.roblox.com/catalog/15" }],
    logNoticeState: "unresolved", customerDeliveryState: "pending", createdAt: new Date().toISOString(),
  });
  await assert.rejects(
    recoverLegacyNonceRejectedDelivery(guild.id, "9876543210987654321"),
    /not eligible/i,
  );
  assert.equal((await getUniformDelivery("9876543210987654321"))?.logNoticeState, "unresolved");
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

test("legacy /log controls without original ledger rows fail before a purchase ping", async () => {
  await saveUniformDelivery({
    submissionId: "customer-purchase", guildId: guild.id, command: "log", actorId: "submitter",
    customerId: "customer-discord", seqmId: "seqm-discord", destinationChannelId: "customer-channel",
    uploadLogChannelId: "log", spreadsheet: setup.uniforms!.spreadsheet!, rows: [],
    sheetState: "saved", customerName: "Customer", customerRobloxId: 4,
    assets: [{ id: 99, url: "https://www.roblox.com/catalog/99" }],
    logNoticeState: "sent", customerDeliveryState: "sent", customerMessageId: "customer-message", createdAt: new Date().toISOString(),
  });
  resetUniformDeliveryStoreForTests();
  await assert.rejects(handleUniformCustomerButton({
    customId: "uniform:purchase:customer-purchase", guild, guildId: guild.id, channelId: "customer-channel",
    message: { id: "customer-message" }, user: { id: "other-user" },
  } as never), /Only the selected customer/i);
  const click = {
    customId: "uniform:purchase:customer-purchase", guild, guildId: guild.id, channelId: "customer-channel",
    message: { id: "customer-message" }, user: { id: "customer-discord" },
    deferUpdate: async () => undefined, editReply: async () => undefined,
    update: async () => undefined,
  };
  await assert.rejects(handleUniformCustomerButton(click as never), /Trusted original spreadsheet row metadata/i);
  assert.equal(sends.length, 0);
  assert.equal((await getUniformDelivery("customer-purchase"))?.terminal, undefined);
  assert.equal((await getUniformDelivery("customer-purchase"))?.action?.state, "unresolved");
});

test("atomically rejects an old customer message action after relog revision changes", async () => {
  await saveUniformDelivery({
    submissionId: "relog-cas", guildId: guild.id, command: "moderated", actorId: "submitter",
    customerId: "customer-discord", seqmId: "", destinationChannelId: "customer-channel",
    uploadLogChannelId: "moderated", spreadsheet: setup.uniforms!.spreadsheet!, rows: [],
    sheetState: "saved", customerName: "Customer", assets: [{ id: 101, url: "https://www.roblox.com/catalog/101" }],
    logNoticeState: "sent", customerDeliveryState: "sent", customerMessageId: "replacement-message",
    customerMessageRevision: 1,
    relog: {
      state: "sent", rowIndex: 0, newAsset: { id: 101, url: "https://www.roblox.com/catalog/101" },
      oldCustomerMessageId: "old-message", nonce: "u-relog-test", startedAt: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
  });
  await assert.rejects(
    claimUniformDeliveryAction("relog-cas", "purchased", undefined, {
      customerMessageId: "old-message", customerMessageRevision: 0,
    }),
    /no longer attached/i,
  );
  assert.equal((await getUniformDelivery("relog-cas"))?.action, undefined);
  assert.equal(sends.length, 0);
});

test("atomically allows only one concurrent customer outcome claim", async () => {
  await saveUniformDelivery({
    submissionId: "concurrent-action", guildId: guild.id, command: "log", actorId: "submitter",
    customerId: "customer-discord", seqmId: "seqm-discord", destinationChannelId: "customer-channel",
    uploadLogChannelId: "log", spreadsheet: setup.uniforms!.spreadsheet!, rows: [],
    sheetState: "saved", customerName: "Customer", customerRobloxId: 4,
    assets: [{ id: 102, url: "https://www.roblox.com/catalog/102" }],
    logNoticeState: "sent", customerDeliveryState: "sent", customerMessageId: "concurrent-message",
    createdAt: new Date().toISOString(),
  });
  const outcomes = await Promise.allSettled([
    claimUniformDeliveryAction("concurrent-action", "purchased", undefined, {
      customerMessageId: "concurrent-message", customerMessageRevision: 0,
    }),
    claimUniformDeliveryAction("concurrent-action", "purchased", undefined, {
      customerMessageId: "concurrent-message", customerMessageRevision: 0,
    }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal((await getUniformDelivery("concurrent-action"))?.action?.state, "claimed");
});

test("atomically claims each Discord delivery outbox once", async () => {
  await saveUniformDelivery({
    submissionId: "concurrent-delivery", guildId: guild.id, command: "log", actorId: "submitter",
    customerId: "customer-discord", seqmId: "seqm-discord", destinationChannelId: "customer-channel",
    uploadLogChannelId: "log", spreadsheet: setup.uniforms!.spreadsheet!, rows: [],
    sheetState: "saved", customerName: "Customer", customerRobloxId: 4,
    assets: [{ id: 103, url: "https://www.roblox.com/catalog/103" }],
    logNoticeState: "pending", customerDeliveryState: "pending", createdAt: new Date().toISOString(),
  });
  const outcomes = await Promise.allSettled([
    claimUniformDeliveryStage("concurrent-delivery", "customerDelivery"),
    claimUniformDeliveryStage("concurrent-delivery", "customerDelivery"),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal((await getUniformDelivery("concurrent-delivery"))?.customerDeliveryState, "claimed");
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
    customId: "uniform:assist-modal:customer-assist:assist-message:0", guild, guildId: guild.id, channelId: "customer-channel",
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
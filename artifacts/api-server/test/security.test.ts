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
const {
  resetGoogleSheetsProxyForTests,
  setGoogleSheetsProxyForTests,
  UNIFORM_SHEET_HEADERS,
} = await import("../src/bot/google-sheets.ts");
const { getSecurityState, mutateSecurityState } =
  await import("../src/bot/security-store.ts");
const { findActiveSnapshot, findRoleSnapshot, saveRoleSnapshot } = await import("../src/bot/role-store.ts");
const { getRegisteredCommandDefinitions, refreshBot } = await import("../src/bot/index.ts");

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
const validatedExternalUsers = new Set<string>();
const replies: string[] = [];
const auditEvents: unknown[] = [];
const trelloWrites: string[] = [];
const trelloCardCreations: string[] = [];
type SerializedModalComponent = {
  type?: number;
  custom_id?: string;
};
type SerializedModal = {
  custom_id?: string;
  components?: Array<{
    type?: number;
    components?: SerializedModalComponent[];
  }>;
};
type ShownModal = {
  userId: string;
  customId: string;
  components: Array<{
    type?: number;
    components?: SerializedModalComponent[];
  }>;
};
const shownModals: ShownModal[] = [];
let providerRequests = 0;
let roleMutationCalls = 0;
let trelloCards: Array<Record<string, unknown>> = [];
let robloxLookup = { id: 9001, name: "Builder", displayName: "Builder" };
let trelloCreateFailure = false;
let client: Client | undefined;
let componentMessageSequence = 0;
let latestComponentMessageId = "component-message-0";
const spreadsheetRows = new Map<string, unknown[][]>([
  ["Uniform Logs", [Array.from(UNIFORM_SHEET_HEADERS)]],
  ["Moderated Logs", [Array.from(UNIFORM_SHEET_HEADERS)]],
]);

function sheetTab(pathname: string): string {
  const decoded = decodeURIComponent(pathname);
  const match = /\/values\/'((?:''|[^'])+)'!/.exec(decoded);
  if (!match) throw new Error(`Unexpected Sheets range: ${decoded}`);
  return match[1]!.replaceAll("''", "'");
}

setGoogleSheetsProxyForTests(async (pathname, options) => {
  if (pathname.includes("?fields=")) {
    return new Response(JSON.stringify({
      sheets: [
        { properties: { title: "Uniform Logs", sheetId: 1 } },
        { properties: { title: "Moderated Logs", sheetId: 2 } },
      ],
    }));
  }
  const method = options?.method ?? "GET";
  if (method === "GET") {
    return new Response(JSON.stringify({ values: spreadsheetRows.get(sheetTab(pathname)) ?? [] }));
  }
  if (method === "PUT") {
    spreadsheetRows.set(sheetTab(pathname), [Array.from(UNIFORM_SHEET_HEADERS)]);
    return new Response(JSON.stringify({ updatedRows: 1 }));
  }
  if (method === "POST" && pathname.includes(":append")) {
    const body = options?.body as { values?: unknown[][] } | undefined;
    const tab = sheetTab(pathname);
    const rows = spreadsheetRows.get(tab) ?? [Array.from(UNIFORM_SHEET_HEADERS)];
    rows.push(...(body?.values ?? []));
    spreadsheetRows.set(tab, rows);
    return new Response(JSON.stringify({ updates: { updatedRows: body?.values?.length ?? 0 } }));
  }
  return new Response(JSON.stringify({}));
});

function presentationReplyText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const payload = value as {
    content?: unknown;
    embeds?: Array<{
      data?: {
        title?: string;
        description?: string;
        fields?: Array<{ name: string; value: string }>;
      };
    }>;
  };
  const parts: string[] = [];
  if (typeof payload.content === "string" && payload.content.trim()) {
    parts.push(payload.content);
  }
  for (const embed of payload.embeds ?? []) {
    const data = embed.data;
    if (!data) continue;
    if (data.title) parts.push(data.title);
    if (data.description) parts.push(data.description);
    for (const field of data.fields ?? []) {
      parts.push(`${field.name}: ${field.value}`);
    }
  }
  return parts.join("\n");
}

function recordReply(value: unknown): void {
  const text = presentationReplyText(value);
  if (text) replies.push(text);
}

function captureShownModal(userId: string, value: { toJSON: () => unknown }): void {
  const serialized = value.toJSON() as SerializedModal;
  assert.ok(serialized.custom_id, "shown modal must have a serialized custom ID");
  shownModals.push({
    userId,
    customId: serialized.custom_id,
    components: serialized.components ?? [],
  });
}

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
      remove: async () => { roleMutationCalls += 1; },
      add: async () => { roleMutationCalls += 1; },
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
  client: {
    user: { id: "security-bot" },
    users: {
      fetch: async (id: string) => {
        if (!validatedExternalUsers.has(id)) throw new Error("Discord user not found");
        return { id };
      },
    },
  },
  members: {
    me: {
      id: "security-bot",
      permissions: { has: () => true },
      roles: { highest: { position: 100 } },
    },
    fetch: async (input?: string | { user: string; force: boolean }) => {
      const id = typeof input === "string" ? input : input?.user;
      if (id) {
        if (!members.has(id)) throw new Error("Discord member not found");
        return memberFor(id);
      }
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
  let deferCalls = 0;
  const messageId = `component-message-${++componentMessageSequence}`;
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
    deferReply: async () => { deferCalls += 1; },
    editReply: async (value: unknown) => {
      latestComponentMessageId = messageId;
      localReplies.push(value);
      recordReply(value);
      return { id: messageId };
    },
    reply: async (value: unknown) => {
      localReplies.push(value);
      recordReply(value);
    },
    localReplies,
    get deferCalls() { return deferCalls; },
  };
}

function button(userId: string, customId: string, messageId = latestComponentMessageId) {
  const localReplies: unknown[] = [];
  const interaction = {
    isChatInputCommand: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    customId,
    message: { id: messageId },
    guild,
    guildId: guild.id,
    user: { id: userId },
    deferred: false,
    replied: false,
    deferUpdate: async () => { interaction.deferred = true; },
    update: async (value: unknown) => { interaction.replied = true; localReplies.push(value); },
    showModal: async (value: { toJSON: () => unknown }) => {
      captureShownModal(userId, value);
    },
    reply: async (value: unknown) => {
      interaction.replied = true;
      localReplies.push(value);
      recordReply(value);
    },
    followUp: async (value: unknown) => {
      localReplies.push(value);
      recordReply(value);
    },
    localReplies,
  };
  return interaction;
}

function select(userId: string, customId: string, values: string[], messageId = latestComponentMessageId) {
  const localReplies: unknown[] = [];
  const interaction = {
    isChatInputCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    customId,
    message: { id: messageId },
    values,
    guild,
    guildId: guild.id,
    user: { id: userId },
    deferred: false,
    replied: false,
    deferUpdate: async () => { interaction.deferred = true; },
    update: async (value: unknown) => { interaction.replied = true; localReplies.push(value); },
    editReply: async (value: unknown) => { localReplies.push(value); },
    showModal: async (value: { toJSON: () => unknown }) => {
      captureShownModal(userId, value);
    },
    reply: async (value: unknown) => {
      interaction.replied = true;
      localReplies.push(value);
      recordReply(value);
    },
    followUp: async (value: unknown) => {
      localReplies.push(value);
      recordReply(value);
    },
    localReplies,
  };
  return interaction;
}

function modal(userId: string, customId: string, values: Record<string, string>) {
  const localReplies: unknown[] = [];
  const interaction = {
    isChatInputCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    customId,
    guild,
    guildId: guild.id,
    user: { id: userId },
    deferred: false,
    replied: false,
    fields: {
      getTextInputValue: (name: string) => {
        if (!Object.prototype.hasOwnProperty.call(values, name)) {
          throw new Error(`Cannot find text input with custom ID "${name}"`);
        }
        return values[name]!;
      },
    },
    reply: async (value: unknown) => {
      interaction.replied = true;
      localReplies.push(value);
      recordReply(value);
    },
    editReply: async (value: unknown) => { localReplies.push(value); },
    localReplies,
  };
  return interaction;
}

async function settle(): Promise<void> {
  // The Discord event listener intentionally starts asynchronous command work
  // without awaiting it. Allow the mocked file-backed stores and concurrent
  // continuation handlers enough time to settle under the serial full suite.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function dispatch(interaction: ReturnType<typeof command>): Promise<void> {
  client!.emit("interactionCreate", interaction);
  await settle();
}

async function dispatchRaw(interaction: object): Promise<void> {
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
    state.maintenance = {
      active: false, reason: "", startedAt: null, startedBy: null, revision: 0,
    };
    state.destructiveActions = [];
    state.observedAdministrators = {};
  });
}

function lastConfirmationId(interaction: ReturnType<typeof command>): string {
  return confirmationIdFromReplies(interaction);
}

function confirmationIdFromReplies(interaction: { localReplies: unknown[] }): string {
  const payload = interaction.localReplies.find(
    (reply): reply is { components: Array<{ components: Array<{ data: { custom_id: string } }> }> } =>
      typeof reply === "object" && reply !== null && "components" in reply,
  );
  const id = payload?.components[0]?.components[0]?.data.custom_id;
  assert.ok(id?.startsWith("confirm:"), "command should produce a confirmation button");
  return id;
}

function lastMaintenanceConfirmationId(interaction: { localReplies: unknown[] }): string {
  const payload = interaction.localReplies.find(
    (reply): reply is { components: Array<{ components: Array<{ data: { custom_id: string } }> }> } =>
      typeof reply === "object" && reply !== null && "components" in reply,
  );
  const id = payload?.components[0]?.components[0]?.data.custom_id;
  assert.ok(id?.startsWith("maintenance-confirm:"), `maintenance should produce a confirmation button: ${JSON.stringify(interaction.localReplies)}`);
  return id;
}

function lastSettingsSelectId(interaction: { localReplies: unknown[] }): string {
  const payload = interaction.localReplies.find(
    (reply): reply is { components: Array<{ components: Array<{ data: { custom_id: string } }> }> } =>
      typeof reply === "object" && reply !== null && "components" in reply,
  );
  const id = payload?.components[0]?.components[0]?.data.custom_id;
  assert.ok(id?.startsWith("settings:select:"), "settings should render its action dropdown");
  return id;
}

type ComponentNode = {
  custom_id?: string;
  label?: string;
  options?: Array<{ value?: string; label?: string; data?: { value?: string; label?: string } }>;
  data?: {
    custom_id?: string;
    label?: string;
    options?: Array<{ value?: string; label?: string; data?: { value?: string; label?: string } }>;
  };
  components?: ComponentNode[];
};

type ComponentPayload = {
  components: ComponentNode[];
};

function latestComponentPayload(interaction: { localReplies: unknown[] }): ComponentPayload {
  const payload = [...interaction.localReplies].reverse().find(
    (reply): reply is ComponentPayload =>
      typeof reply === "object" &&
      reply !== null &&
      "components" in reply &&
      Array.isArray((reply as { components?: unknown }).components),
  );
  assert.ok(payload, "interaction should render Discord components");
  return payload;
}

function componentRows(payload: ComponentPayload): ComponentNode[] {
  return payload.components.flatMap((row) => row.components ?? []);
}

function renderedSelect(
  payload: ComponentPayload,
  expectedCustomId?: string,
): { customId: string; options: Array<{ value?: string; label?: string; data?: { value?: string; label?: string } }> } {
  const selectMenu = componentRows(payload).find((component) =>
    (component.data?.custom_id ?? component.custom_id)?.startsWith("settings:") &&
    Array.isArray(component.data?.options ?? component.options) &&
    (!expectedCustomId || (component.data?.custom_id ?? component.custom_id) === expectedCustomId),
  );
  const customId = selectMenu?.data?.custom_id ?? selectMenu?.custom_id;
  assert.ok(customId, "expected a rendered settings select menu");
  return { customId, options: selectMenu.data?.options ?? selectMenu.options ?? [] };
}

function renderedOption(
  payload: ComponentPayload,
  expectedValue: string,
): string {
  const option = renderedSelect(payload).options.find((candidate) =>
    (candidate.value ?? candidate.data?.value)?.replace(/:[a-f0-9]{32}$/, "") === expectedValue,
  );
  const value = option?.value ?? option?.data?.value;
  assert.ok(value, `expected rendered option ${expectedValue}`);
  return value;
}

function renderedButton(
  payload: ComponentPayload,
  expectedLabel: string,
  expectedPrefix?: string,
): string {
  const button = componentRows(payload).find((component) =>
    (component.data?.label ?? component.label) === expectedLabel &&
    (!expectedPrefix || (component.data?.custom_id ?? component.custom_id)?.startsWith(expectedPrefix)),
  );
  const customId = button?.data?.custom_id ?? button?.custom_id;
  assert.ok(customId, `expected rendered settings button ${expectedLabel}`);
  return customId;
}

function renderedOptions(payload: ComponentPayload): string[] {
  return renderedSelect(payload).options.map((option) =>
    (option.value ?? option.data?.value ?? "").replace(/:[a-f0-9]{32}$/, ""));
}

function modalTextInputIds(shownModal: ShownModal): string[] {
  const inputs = shownModal.components.flatMap((row) => row.components ?? []);
  assert.ok(inputs.length, "shown modal should contain text inputs");
  for (const input of inputs) {
    assert.equal(input.type, 4, "modal components must be Discord text inputs");
    assert.ok(input.custom_id, "serialized modal text input must have a custom ID");
  }
  return inputs.map((input) => input.custom_id!);
}

function modalTextInputValues(shownModal: ShownModal): string[] {
  const inputs = shownModal.components.flatMap((row) => row.components ?? []);
  return inputs.map((input) => (input as SerializedModalComponent & { value?: string }).value ?? "");
}

async function openSettings(userId: string): Promise<{
  root: ReturnType<typeof command>;
  payload: ComponentPayload;
}> {
  const root = command(userId, "settings");
  await dispatch(root);
  return { root, payload: latestComponentPayload(root) };
}

async function chooseSettingsCategory(
  userId: string,
  root: { localReplies: unknown[] },
  category: string,
): Promise<{
  interaction: ReturnType<typeof select>;
  payload: ComponentPayload;
}> {
  const rootPayload = latestComponentPayload(root);
  const rootSelect = renderedSelect(rootPayload);
  const categoryValue = renderedOption(rootPayload, `settings-category:${category}`);
  const interaction = select(userId, rootSelect.customId, [categoryValue]);
  await dispatchRaw(interaction);
  return { interaction, payload: latestComponentPayload(interaction) };
}

async function chooseSettingsAction(
  userId: string,
  category: { interaction: { localReplies: unknown[] }; payload: ComponentPayload },
  action: string,
): Promise<ReturnType<typeof select>> {
  const menu = renderedSelect(category.payload);
  const value = renderedOption(category.payload, action);
  const interaction = select(userId, menu.customId, [value]);
  await dispatchRaw(interaction);
  return interaction;
}

function assertDiscordComponentLimits(payload: ComponentPayload): void {
  assert.ok(payload.components.length <= 5, "Discord messages may contain at most five action rows");
  for (const row of payload.components) {
    assert.ok((row.components ?? []).length <= 5, "Discord action rows may contain at most five components");
    for (const component of row.components ?? []) {
      const label = component.data?.label ?? component.label;
      const customId = component.data?.custom_id ?? component.custom_id;
      if (label) assert.ok(label.length <= 80, `button label is too long: ${label}`);
      if (customId) assert.ok(customId.length <= 100, `custom ID is too long: ${customId}`);
      for (const option of component.data?.options ?? component.options ?? []) {
        const optionLabel = option.label ?? option.data?.label;
        const optionValue = option.value ?? option.data?.value;
        if (optionLabel) assert.ok(optionLabel.length <= 100, `select label is too long: ${optionLabel}`);
        if (optionValue) assert.ok(optionValue.length <= 100, `select value is too long: ${optionValue}`);
      }
    }
  }
}

async function setMaintenance(active: boolean, actor = "admin-a", reason = "maintenance test"): Promise<void> {
  const { root } = await openSettings(actor);
  const system = await chooseSettingsCategory(actor, root, "system");
  const action = active ? "settings-action:maintenance-enable" : "settings-action:maintenance-disable";
  const menu = await chooseSettingsAction(actor, system, action);
  if (active) {
    const maintenanceModal = shownModals.at(-1);
    assert.ok(maintenanceModal?.customId.startsWith("settings-modal:maintenance-enable:"));
    const pending = modal(actor, maintenanceModal!.customId, { reason });
    await dispatchRaw(pending);
    await dispatchRaw(button(actor, lastMaintenanceConfirmationId(pending)));
    return;
  }
  // Disable is intentionally confirmation-only; no extra parameter modal.
  await dispatchRaw(button(actor, lastMaintenanceConfirmationId(menu)));
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
      },
    });
    queueMicrotask(() => this.emit(Events.ClientReady, this));
    return token ?? "";
  };
(GuildManager.prototype as unknown as { fetch(id: string): Promise<typeof guild> }).fetch =
  async () => guild;
globalThis.fetch = async (input, init) => {
  providerRequests += 1;
  const url = new URL(input.toString());
  if (url.pathname === "/v1/usernames/users") {
    return new Response(JSON.stringify({
      data: [robloxLookup],
    }));
  }
  if (url.pathname === `/v1/users/${robloxLookup.id}`) {
    return new Response(JSON.stringify(robloxLookup));
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
      if (trelloCreateFailure) {
        return new Response(JSON.stringify({ error: "Trello unavailable" }), { status: 503 });
      }
      return new Response(JSON.stringify({
        id: `card-${trelloCardCreations.length}`,
        url: "https://trello.test/card",
      }));
    }
    return new Response(JSON.stringify(trelloCards));
  }
  if (url.pathname.startsWith("/1/cards/") && (init?.method ?? "GET") === "GET") {
    const cardId = url.pathname.split("/").at(-1);
    const card = trelloCards.find((candidate) => candidate.id === cardId);
    return new Response(JSON.stringify(card ?? {}), { status: card ? 200 : 404 });
  }
  if (url.pathname.startsWith("/1/cards/") && (init?.method ?? "GET") === "PUT") {
    const cardId = url.pathname.split("/").at(-1);
    const card = trelloCards.find((candidate) => candidate.id === cardId);
    if (!card) return new Response(JSON.stringify({}), { status: 404 });
    const body = init?.body as URLSearchParams;
    if (body.get("idList")) card.idList = body.get("idList");
    if (body.get("idLabels")) card.idLabels = body.get("idLabels")!.split(",");
    return new Response(JSON.stringify(card));
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
  if (url.pathname.endsWith("/cards")) {
    return new Response(JSON.stringify(trelloCards));
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

test("registers exactly six commands with the requested moderation and uniform options", () => {
  const definitions = getRegisteredCommandDefinitions();
  assert.deepEqual(definitions.map((command) => command.name), [
    "settings",
    "blacklist",
    "revoke_blacklist",
    "blacklist_lookup",
    "log",
    "moderated",
  ]);
  const blacklist = definitions.find((command) => command.name === "blacklist");
  const revoke = definitions.find((command) => command.name === "revoke_blacklist");
  const log = definitions.find((command) => command.name === "log");
  const moderated = definitions.find((command) => command.name === "moderated");
  assert.deepEqual(blacklist?.options?.map((option) => option.name), [
    "username",
    "type",
    "reason",
  ]);
  assert.deepEqual(revoke?.options?.map((option) => option.name), ["username"]);
  assert.deepEqual(log?.options?.map((option) => option.name), [
    "customer", "qm", "seqm", "publisher",
    "shirtid1", "shirtid2", "shirtid3", "shirtid4", "shirtid5",
    "shirtid6", "shirtid7", "shirtid8", "shirtid9", "shirtid10",
  ]);
  assert.deepEqual(moderated?.options?.map((option) => option.name), [
    "customer", "uploader", "publisher", "shirtid",
  ]);
});

test.after(() => {
  (Client.prototype as unknown as { login: typeof originalLogin }).login = originalLogin;
  (GuildManager.prototype as unknown as { fetch: typeof originalGuildFetch }).fetch =
    originalGuildFetch;
  globalThis.fetch = originalFetch;
  resetGoogleSheetsProxyForTests();
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
  assert.match(replies.at(-1) ?? "", /Quartermaster \| Group Blacklist Completed/);
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
  const { root } = await openSettings("setup-owner");
  const security = await chooseSettingsCategory("setup-owner", root, "security");
  const securityPage = await chooseSettingsAction("setup-owner", security, "setup:security");
  const securityPayload = latestComponentPayload(securityPage);
  const confirmationButton = renderedButton(securityPayload, "Toggle Confirmation");
  await dispatchRaw(button("setup-owner", confirmationButton));
  const saved = await (await import("../src/bot/setup-store.ts")).getGuildSetup(guild.id);
  assert.equal(saved?.security?.confirmationsRequired, false);
  assert.ok(auditEvents.length > beforeAudits, "configuration change must emit an audit event");
});

test("navigates to Uniforms uploading configuration, seals modal fields, saves, resets, and rechecks admin permission", async () => {
  await setSecurity({});
  const store = await import("../src/bot/setup-store.ts");
  const current = await store.getGuildSetup(guild.id);
  assert.ok(current);
  await saveGuildSetup({
    ...current!,
    uniforms: {
      logChannelId: "12345678901234567",
      moderatedChannelId: "12345678901234568",
      authorizedRoleIds: ["moderator-role"],
      authorizedMemberIds: ["member"],
    },
  });

  const { root } = await openSettings("setup-owner");
  const uniforms = await chooseSettingsCategory("setup-owner", root, "uniforms");
  const uniformPageInteraction = await chooseSettingsAction("setup-owner", uniforms, "setup:uniforms");
  const uniformPage = latestComponentPayload(uniformPageInteraction);
  const configure = renderedButton(uniformPage, "Uploading Configuration", "setup:");
  const modalCount = shownModals.length;
  await dispatchRaw(button("setup-owner", configure));
  const shown = shownModals.at(-1);
  assert.equal(shownModals.length, modalCount + 1);
  assert.deepEqual(modalTextInputIds(shown!), [
    "log_channel_id",
    "moderated_channel_id",
    "authorized_role_ids",
    "authorized_member_ids",
  ]);

  await dispatchRaw(modal("setup-owner", shown!.customId, {
    log_channel_id: "12345678901234567",
    moderated_channel_id: "12345678901234568",
    authorized_role_ids: "moderator-role",
    authorized_member_ids: "member",
  }));
  let saved = await store.getGuildSetup(guild.id);
  assert.equal(saved?.uniforms?.logChannelId, "12345678901234567");
  assert.deepEqual(saved?.uniforms?.authorizedMemberIds, ["member"]);

  // A modal captured while the user was an administrator cannot be used after
  // the member is demoted.
  await dispatchRaw(button("setup-owner", configure));
  const staleForDemotion = shownModals.at(-1)!;
  members.set("setup-owner", { administrator: false });
  await dispatchRaw(modal("setup-owner", staleForDemotion.customId, {
    log_channel_id: "",
    moderated_channel_id: "",
    authorized_role_ids: "",
    authorized_member_ids: "",
  }));
  saved = await store.getGuildSetup(guild.id);
  assert.equal(saved?.uniforms?.logChannelId, "12345678901234567");
  members.set("setup-owner", { administrator: true });

  await dispatchRaw(modal("setup-owner", staleForDemotion.customId, {
    log_channel_id: "",
    moderated_channel_id: "",
    authorized_role_ids: "",
  }));
  assert.match(replies.at(-1) ?? "", /Missing Uniforms configuration field.*authorized_member_ids/i);

  // Serialized modal field IDs are stable, while the modal itself remains
  // nonce-bound to this settings session.
  await dispatchRaw(modal("setup-owner", shown!.customId.replace(/[a-f0-9]{32}$/, "00000000000000000000000000000000"), {
    log_channel_id: "",
    moderated_channel_id: "",
    authorized_role_ids: "",
    authorized_member_ids: "",
  }));
  assert.match(replies.at(-1) ?? "", /expired|another administrator/i);

  const resetInteraction = button("setup-owner", renderedButton(uniformPage, "Reset Uniforms", "setup:"));
  await dispatchRaw(resetInteraction);
  saved = await store.getGuildSetup(guild.id);
  assert.equal(saved?.uniforms, undefined);
  const resetPayload = latestComponentPayload(resetInteraction);
  const backToCategory = renderedButton(resetPayload, "Back to Category", "settings:back:");
  const backInteraction = button("setup-owner", backToCategory);
  await dispatchRaw(backInteraction);
  assert.match(presentationReplyText(backInteraction.localReplies.at(-1)), /Uniforms/);
});

test("configures Spreadsheet Configuration with stable nonce-bound fields and preserves uploading access", async () => {
  await setSecurity({});
  members.set("12345678901234570", { administrator: false });
  const store = await import("../src/bot/setup-store.ts");
  const current = await store.getGuildSetup(guild.id);
  assert.ok(current);
  await saveGuildSetup({
    ...current!,
    uniforms: {
      logChannelId: "12345678901234567",
      moderatedChannelId: "12345678901234568",
      authorizedRoleIds: ["12345678901234569"],
      authorizedMemberIds: ["12345678901234570"],
    },
  });

  const { root } = await openSettings("setup-owner");
  const uniforms = await chooseSettingsCategory("setup-owner", root, "uniforms");
  const uniformPageInteraction = await chooseSettingsAction("setup-owner", uniforms, "setup:uniforms");
  let uniformPage = latestComponentPayload(uniformPageInteraction);
  const configure = renderedButton(uniformPage, "Spreadsheet Configuration", "setup:");
  assert.match(configure, /^setup:uniforms-spreadsheet-config:[a-f0-9]{32}$/);
  await dispatchRaw(button("setup-owner", configure));
  let shown = shownModals.at(-1)!;
  assert.deepEqual(modalTextInputIds(shown), [
    "spreadsheet_id",
    "log_tab",
    "moderated_tab",
    "create_missing_tabs",
  ]);
  assert.deepEqual(modalTextInputValues(shown), ["", "Uniform Logs", "Moderated Logs", "NO"]);
  assert.match(shown.customId, /^setup-modal:uniforms-spreadsheet:[a-f0-9]{32}$/);

  await dispatchRaw(modal("setup-owner", shown.customId, {
    spreadsheet_id: "https://docs.google.com/spreadsheets/d/sheet-id/edit",
    log_tab: "Uniform Logs",
    moderated_tab: "Moderated Logs",
    create_missing_tabs: "NO",
  }));
  let saved = await store.getGuildSetup(guild.id);
  assert.equal(saved?.uniforms?.spreadsheet?.spreadsheetId, "sheet-id");
  assert.equal(saved?.uniforms?.logChannelId, "12345678901234567");
  assert.deepEqual(saved?.uniforms?.authorizedRoleIds, ["12345678901234569"]);
  assert.deepEqual(saved?.uniforms?.authorizedMemberIds, ["12345678901234570"]);

  // A fresh modal still re-checks current Administrator access.
  uniformPage = latestComponentPayload(uniformPageInteraction);
  const secondConfigure = renderedButton(uniformPage, "Spreadsheet Configuration", "setup:");
  await dispatchRaw(button("setup-owner", secondConfigure));
  shown = shownModals.at(-1)!;
  members.set("setup-owner", { administrator: false });
  await dispatchRaw(modal("setup-owner", shown.customId, {
    spreadsheet_id: "sheet-id",
    log_tab: "Uniform Logs",
    moderated_tab: "Moderated Logs",
    create_missing_tabs: "NO",
  }));
  assert.match(replies.at(-1) ?? "", /Administrator|permission/i);
  saved = await store.getGuildSetup(guild.id);
  assert.equal(saved?.uniforms?.spreadsheet?.spreadsheetId, "sheet-id");
  members.set("setup-owner", { administrator: true });

  const reset = button("setup-owner", renderedButton(uniformPage, "Reset Spreadsheet", "setup:"));
  await dispatchRaw(reset);
  saved = await store.getGuildSetup(guild.id);
  assert.equal(saved?.uniforms?.spreadsheet, undefined);
  assert.equal(saved?.uniforms?.logChannelId, "12345678901234567");
  assert.deepEqual(saved?.uniforms?.authorizedRoleIds, ["12345678901234569"]);
  assert.deepEqual(saved?.uniforms?.authorizedMemberIds, ["12345678901234570"]);
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
  const { root } = await openSettings("setup-owner");
  const security = await chooseSettingsCategory("setup-owner", root, "security");
  const securityPage = await chooseSettingsAction("setup-owner", security, "setup:security");
  const lockdown = button("setup-owner", renderedButton(latestComponentPayload(securityPage), "Lockdown Settings"));
  await dispatchRaw(lockdown);
  const lockdownPayload = latestComponentPayload(lockdown);
  const unlock = button("setup-owner", renderedButton(lockdownPayload, "Unlock", "setup:"));
  await dispatchRaw(unlock);
  assert.equal(
    (await getSecurityState(guild.id)).lockdown.active,
    true,
    "opening setup unlock must not unlock the server",
  );

  const confirmationPayload = latestComponentPayload(unlock);
  const confirmation = button("setup-owner", renderedButton(confirmationPayload, "Confirm Unlock", "setup:"));
  client!.emit("interactionCreate", confirmation);
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

test("unresolved identities use private button/modal continuation and bind nonmember blacklist/revoke state", async () => {
  const previousLookup = robloxLookup;
  robloxLookup = { id: 9100, name: "UnresolvedBuilder", displayName: "UnresolvedBuilder" };
  const externalId = "12345678901234567";
  validatedExternalUsers.add(externalId);
  trelloCards = [];
  await setSecurity({ confirmationsRequired: true });
  const beforeCreates = trelloCardCreations.length;
  const beforeRoles = roleMutationCalls;
  const beforeActions = (await getSecurityState(guild.id)).destructiveActions.length;

  try {
    const pending = command("admin-a", "blacklist", {
      username: "ignored-by-provider-fixture",
      type: "permanent",
      reason: "unresolved account",
    });
    await dispatch(pending);
    assert.equal(pending.deferCalls, 1, "slash command must be acknowledged by deferReply");
    assert.equal(trelloCardCreations.length, beforeCreates, "opening identity prompt must not write Trello");
    assert.equal(roleMutationCalls, beforeRoles, "opening identity prompt must not mutate roles");
    assert.equal((await findActiveSnapshot(guild.id, 9100)), undefined);
    assert.equal(
      (await getSecurityState(guild.id)).destructiveActions.length,
      beforeActions,
      "opening identity prompt must not reserve a destructive-action rate slot",
    );
    const promptPayload = latestComponentPayload(pending);
    const promptId = componentRows(promptPayload)
      .map((component) => component.data?.custom_id ?? component.custom_id)
      .find((id): id is string => Boolean(id?.startsWith("identity-prompt:")));
    assert.ok(promptId, "unresolved identity must render a continuation button");
    assert.match(replies.at(-1) ?? "", /Discord Account Needed/i);
    assert.match(replies.at(-1) ?? "", /numeric user ID/i);

    const promptButton = button("admin-a", promptId!);
    const duplicatePromptButton = button("admin-a", promptId!);
    client!.emit("interactionCreate", promptButton);
    client!.emit("interactionCreate", duplicatePromptButton);
    await settle();
    assert.equal(shownModals.filter((modal) => modal.customId.startsWith("identity-modal:")).length, 1);
    assert.equal(promptButton.replied, false, "button must open a modal, not acknowledge with a message");
    const modalId = shownModals.at(-1)?.customId;
    assert.ok(modalId?.startsWith("identity-modal:"), "identity button must open the account modal");

    const invalid = modal("admin-a", modalId!, { discord_identity: "not-a-discord-account" });
    await dispatchRaw(invalid);
    assert.equal(invalid.replied, true, "invalid account input must receive a private modal response");
    assert.match(replies.at(-1) ?? "", /numeric Discord user ID|No unambiguous/i);
    assert.equal(trelloCardCreations.length, beforeCreates);
    assert.equal((await findActiveSnapshot(guild.id, 9100)), undefined);

    const resolved = modal("admin-a", modalId!, { discord_identity: externalId });
    await dispatchRaw(resolved);
    const confirmation = confirmationIdFromReplies(resolved);
    const confirmationText = resolved.localReplies.map(presentationReplyText).join("\n");
    assert.match(confirmationText, /UnresolvedBuilder/);
    assert.match(confirmationText, new RegExp(externalId));
    assert.match(confirmationText, /nonmember/i);
    assert.equal(trelloCardCreations.length, beforeCreates);
    assert.equal((await findActiveSnapshot(guild.id, 9100)), undefined);

    const confirmed = button("admin-a", confirmation);
    await dispatchRaw(confirmed);
    assert.equal(confirmed.deferred, true, "confirmation must use deferUpdate acknowledgement");
    const active = await findActiveSnapshot(guild.id, 9100);
    assert.equal(active?.discordUserId, externalId);
    assert.deepEqual(active?.roleIds, [], "nonmember snapshots must not invent role IDs");
    assert.equal(active?.status, "active");
    assert.equal(trelloCardCreations.length, beforeCreates + 1);
    assert.equal(roleMutationCalls, beforeRoles);
    assert.equal((await getSecurityState(guild.id)).destructiveActions.length, beforeActions + 1);

    const cardId = active?.cardId;
    assert.ok(cardId);
    trelloCards = [{
      id: cardId,
      name: "UnresolvedBuilder | 9100",
      desc: "- unresolved account",
      idList: "list-2",
      idLabels: [],
      url: "https://trello.test/nonmember",
      dateLastActivity: "2026-09-14T00:00:00.000Z",
      closed: false,
    }];
    const revoke = command("admin-a", "revoke_blacklist", { username: "ignored-by-provider-fixture" });
    await dispatch(revoke);
    const revokeConfirmation = lastConfirmationId(revoke);
    assert.equal(trelloCards[0]?.idList, "list-2", "revoke confirmation must not mutate Trello");
    const revokeButton = button("admin-a", revokeConfirmation);
    await dispatchRaw(revokeButton);
    const revocationPending = await findRoleSnapshot(guild.id, 9100);
    assert.equal(revocationPending?.discordUserId, externalId);
    assert.equal(revocationPending?.status, "revocation_pending");
    assert.equal(revocationPending?.cardId, cardId);
    assert.equal(trelloCards[0]?.idList, "list-3");
    assert.equal(roleMutationCalls, beforeRoles);
  } finally {
    robloxLookup = previousLookup;
    validatedExternalUsers.delete(externalId);
    trelloCards = [];
  }
});

test("active revocation confirmation refuses a replacement Trello card", async () => {
  const robloxId = 9400;
  const cardId = "bound-active-card";
  robloxLookup = { id: robloxId, name: "BoundBuilder", displayName: "BoundBuilder" };
  members.set("bound-member", {
    administrator: false,
    username: "BoundBuilder",
    globalName: "BoundBuilder",
    nickname: "BoundBuilder",
  });
  await setSecurity({ confirmationsRequired: true });
  await saveRoleSnapshot({
    key: `${guild.id}:${robloxId}`,
    guildId: guild.id,
    discordUserId: "bound-member",
    robloxUserId: robloxId,
    robloxUsername: "BoundBuilder",
    roleIds: [],
    cardId,
    cardUrl: "https://trello.test/bound-active-card",
    source: "command",
    status: "active",
    createdAt: new Date().toISOString(),
  });
  trelloCards = [{
    id: cardId,
    name: `BoundBuilder | ${robloxId}`,
    desc: "- original",
    idList: "list-2",
    idLabels: [],
    url: "https://trello.test/bound-active-card",
    dateLastActivity: "2026-09-14T00:00:00.000Z",
    closed: false,
  }];

  try {
    const pending = command("admin-a", "revoke_blacklist", { username: "ignored" });
    await dispatch(pending);
    const confirmation = lastConfirmationId(pending);
    trelloCards = [{
      id: "replacement-card",
      name: `BoundBuilder | ${robloxId}`,
      desc: "- replacement",
      idList: "list-2",
      idLabels: [],
      url: "https://trello.test/replacement-card",
      dateLastActivity: "2026-09-14T01:00:00.000Z",
      closed: false,
    }];
    await dispatchRaw(button("admin-a", confirmation));
    assert.equal(trelloCards[0]?.id, "replacement-card");
    assert.equal(trelloCards[0]?.idList, "list-2");
    assert.equal((await findRoleSnapshot(guild.id, robloxId))?.status, "active");
  } finally {
    trelloCards = [];
    robloxLookup = { id: 9001, name: "Builder", displayName: "Builder" };
    await setSecurity({ confirmationsRequired: false });
  }
});

test("identity-prompt revocation binds a no-snapshot card before rejecting replacement cards", async () => {
  const previousLookup = robloxLookup;
  const robloxId = 9700;
  const externalId = "12345678901234568";
  robloxLookup = { id: robloxId, name: "PromptRevokeBuilder", displayName: "PromptRevokeBuilder" };
  validatedExternalUsers.add(externalId);
  trelloCards = [{
    id: "prompt-bound-card",
    name: `PromptRevokeBuilder | ${robloxId}`,
    desc: "- existing approval",
    idList: "list-2",
    idLabels: [],
    url: "https://trello.test/prompt-bound-card",
    dateLastActivity: "2026-09-14T02:00:00.000Z",
    closed: false,
  }];
  await setSecurity({ confirmationsRequired: true });
  try {
    const pending = command("admin-a", "revoke_blacklist", { username: "ignored" });
    await dispatch(pending);
    const promptId = componentRows(latestComponentPayload(pending))
      .map((component) => component.data?.custom_id ?? component.custom_id)
      .find((id): id is string => Boolean(id?.startsWith("identity-prompt:")));
    assert.ok(promptId);
    await dispatchRaw(button("admin-a", promptId!));
    const modalId = shownModals.at(-1)?.customId;
    assert.ok(modalId?.startsWith("identity-modal:"));
    const resolved = modal("admin-a", modalId!, { discord_identity: externalId });
    await dispatchRaw(resolved);
    const confirmation = confirmationIdFromReplies(resolved);

    trelloCards = [{
      id: "prompt-replacement-card",
      name: `PromptRevokeBuilder | ${robloxId}`,
      desc: "- replacement",
      idList: "list-2",
      idLabels: [],
      url: "https://trello.test/prompt-replacement-card",
      dateLastActivity: "2026-09-14T03:00:00.000Z",
      closed: false,
    }];
    await dispatchRaw(button("admin-a", confirmation));
    assert.equal(trelloCards[0]?.id, "prompt-replacement-card");
    assert.equal(trelloCards[0]?.idList, "list-2");
    assert.equal(await findRoleSnapshot(guild.id, robloxId), undefined);
  } finally {
    trelloCards = [];
    robloxLookup = previousLookup;
    validatedExternalUsers.delete(externalId);
    await setSecurity({ confirmationsRequired: false });
  }
});

test("same Discord account restrictions retain the union of saved roles", async () => {
  const firstRoblox = 9500;
  const secondRoblox = 9501;
  members.set("multi-binding-member", {
    administrator: false,
    username: "Builder",
    globalName: "Builder",
    nickname: "Builder",
    roleIds: ["role-1", "role-2"],
  });
  await setSecurity({ confirmationsRequired: false });
  const previousLookup = robloxLookup;
  trelloCards = [];
  try {
    robloxLookup = { id: firstRoblox, name: "FirstBoundBuilder", displayName: "FirstBoundBuilder" };
    await dispatch(command(
      "admin-a",
      "blacklist",
      { username: "ignored", type: "permanent", reason: "first restriction" },
      "multi-binding-member",
    ));
    members.set("multi-binding-member", {
      administrator: false,
      username: "Builder",
      globalName: "Builder",
      nickname: "Builder",
      roleIds: [],
    });
    robloxLookup = { id: secondRoblox, name: "SecondBoundBuilder", displayName: "SecondBoundBuilder" };
    await dispatch(command(
      "admin-a",
      "blacklist",
      { username: "ignored", type: "appealable", reason: "second restriction" },
      "multi-binding-member",
    ));
    assert.deepEqual((await findRoleSnapshot(guild.id, firstRoblox))?.roleIds, ["role-1", "role-2"]);
    assert.deepEqual((await findRoleSnapshot(guild.id, secondRoblox))?.roleIds, ["role-1", "role-2"]);
  } finally {
    trelloCards = [];
    robloxLookup = previousLookup;
    await setSecurity({ confirmationsRequired: false });
  }
});

test("confirmation tokens are atomically claimed before duplicate continuations can reserve a slot", async () => {
  const previousLookup = robloxLookup;
  const robloxId = 9600;
  robloxLookup = { id: robloxId, name: "TokenBuilder", displayName: "TokenBuilder" };
  members.set("token-member", {
    administrator: false,
    username: "TokenBuilder",
    globalName: "TokenBuilder",
    nickname: "TokenBuilder",
    roleIds: [],
  });
  trelloCards = [];
  await setSecurity({ confirmationsRequired: true });
  try {
    const pending = command(
      "admin-a",
      "blacklist",
      { username: "ignored", type: "permanent", reason: "claim token" },
      "token-member",
    );
    await dispatch(pending);
    const confirmation = lastConfirmationId(pending);
    const beforeActions = (await getSecurityState(guild.id)).destructiveActions.length;
    const first = button("admin-a", confirmation);
    const duplicate = button("admin-a", confirmation);
    client!.emit("interactionCreate", first);
    client!.emit("interactionCreate", duplicate);
    await settle();
    for (let attempt = 0; attempt < 40 && !first.deferred; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(first.deferred, true);
    assert.equal(duplicate.deferred, false);
    assert.equal(
      (await getSecurityState(guild.id)).destructiveActions.length,
      beforeActions + 1,
    );
    assert.equal((await findRoleSnapshot(guild.id, robloxId))?.status, "active");
  } finally {
    trelloCards = [];
    robloxLookup = previousLookup;
    await setSecurity({ confirmationsRequired: false });
  }
});

test("identity prompt rejects foreign, expired, demoted, maintenance, and lockdown continuations", async () => {
  const previousLookup = robloxLookup;
  robloxLookup = { id: 9200, name: "ContinuationBuilder", displayName: "ContinuationBuilder" };
  await setSecurity({ confirmationsRequired: true });
  try {
    const pending = command("admin-a", "blacklist", {
      username: "ignored",
      type: "appealable",
      reason: "continuation binding",
    });
    await dispatch(pending);
    const promptId = componentRows(latestComponentPayload(pending))
      .map((component) => component.data?.custom_id ?? component.custom_id)
      .find((id): id is string => Boolean(id?.startsWith("identity-prompt:")));
    assert.ok(promptId);
    const modalCountBeforeForeign = shownModals.length;
    const foreign = button("admin-b", promptId!);
    await dispatchRaw(foreign);
    assert.equal(shownModals.length, modalCountBeforeForeign);
    assert.match(replies.at(-1) ?? "", /expired or belongs to another administrator/i);

    const originalNow = Date.now;
    Date.now = () => originalNow() + 11 * 60_000;
    try {
      await dispatchRaw(button("admin-a", promptId!));
      assert.match(replies.at(-1) ?? "", /expired/i);
    } finally {
      Date.now = originalNow;
    }

    const demotionPending = command("admin-a", "blacklist", {
      username: "ignored",
      type: "appealable",
      reason: "demotion binding",
    });
    await dispatch(demotionPending);
    const demotionPromptId = componentRows(latestComponentPayload(demotionPending))
      .map((component) => component.data?.custom_id ?? component.custom_id)
      .find((id): id is string => Boolean(id?.startsWith("identity-prompt:")));
    assert.ok(demotionPromptId);
    members.set("admin-a", { administrator: false });
    try {
      await dispatchRaw(button("admin-a", demotionPromptId!));
      assert.match(replies.at(-1) ?? "", /current Discord Administrator/i);
    } finally {
      members.set("admin-a", { administrator: true });
    }

    const maintenancePending = command("admin-a", "blacklist", {
      username: "ignored",
      type: "appealable",
      reason: "maintenance binding",
    });
    await dispatch(maintenancePending);
    const maintenancePromptId = componentRows(latestComponentPayload(maintenancePending))
      .map((component) => component.data?.custom_id ?? component.custom_id)
      .find((id): id is string => Boolean(id?.startsWith("identity-prompt:")));
    assert.ok(maintenancePromptId);
    await mutateSecurityState(guild.id, (state) => {
      state.maintenance.active = true;
      state.maintenance.reason = "identity continuation maintenance";
    });
    try {
      await dispatchRaw(button("admin-a", maintenancePromptId!));
      assert.match(replies.at(-1) ?? "", /maintenance/i);
    } finally {
      await setSecurity({ confirmationsRequired: true });
    }

    const lockdownPending = command("admin-a", "blacklist", {
      username: "ignored",
      type: "appealable",
      reason: "lockdown binding",
    });
    await dispatch(lockdownPending);
    const lockdownPromptId = componentRows(latestComponentPayload(lockdownPending))
      .map((component) => component.data?.custom_id ?? component.custom_id)
      .find((id): id is string => Boolean(id?.startsWith("identity-prompt:")));
    assert.ok(lockdownPromptId);
    await mutateSecurityState(guild.id, (state) => {
      state.lockdown.active = true;
      state.lockdown.reason = "identity continuation lockdown";
    });
    try {
      await dispatchRaw(button("admin-a", lockdownPromptId!));
      assert.match(replies.at(-1) ?? "", /lockdown/i);
    } finally {
      await setSecurity({ confirmationsRequired: true });
    }
  } finally {
    robloxLookup = previousLookup;
    await setSecurity({ confirmationsRequired: false });
  }
});

test("nonmember provider failure leaves the approved empty snapshot pending for recovery", async () => {
  const previousLookup = robloxLookup;
  robloxLookup = { id: 9300, name: "ProviderFailureBuilder", displayName: "ProviderFailureBuilder" };
  const externalId = "12345678901234568";
  validatedExternalUsers.add(externalId);
  trelloCreateFailure = true;
  const beforeRoles = roleMutationCalls;
  await setSecurity({ confirmationsRequired: false });
  try {
    const pendingCommand = command("admin-a", "blacklist", {
      username: "ignored",
      type: "permanent",
      reason: "provider failure",
    });
    await dispatch(pendingCommand);
    const promptId = componentRows(latestComponentPayload(
      pendingCommand,
    ))
      .map((component) => component.data?.custom_id ?? component.custom_id)
      .find((id): id is string => Boolean(id?.startsWith("identity-prompt:")));
    assert.ok(promptId);
    await dispatchRaw(button("admin-a", promptId!));
    const modalId = shownModals.at(-1)?.customId;
    assert.ok(modalId);
    const resolved = modal("admin-a", modalId!, { discord_identity: externalId });
    await dispatchRaw(resolved);
    const confirmation = confirmationIdFromReplies(resolved);
    await dispatchRaw(button("admin-a", confirmation));
    const pending = await findRoleSnapshot(guild.id, 9300);
    assert.equal(pending?.discordUserId, externalId);
    assert.deepEqual(pending?.roleIds, []);
    assert.equal(pending?.status, "pending");
    assert.equal(pending?.cardId, undefined);
    assert.equal(roleMutationCalls, beforeRoles, "provider failure must leave Discord roles untouched");
  } finally {
    trelloCreateFailure = false;
    robloxLookup = previousLookup;
    validatedExternalUsers.delete(externalId);
    await setSecurity({ confirmationsRequired: false });
  }
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

test("a configured protected user ID is denied before any provider mutation", async () => {
  await setSecurity({
    confirmationsRequired: false,
    protectedUserIds: ["protected-id"],
    protectedRoleIds: [],
  });
  members.set("protected-id", {
    administrator: false,
    username: "Builder",
    globalName: "Builder",
    nickname: "Builder",
  });
  const before = trelloCardCreations.length;
  await dispatch(command(
    "admin-a",
    "blacklist",
    { username: "Builder", type: "appealable", reason: "protected ID" },
    "protected-id",
  ));
  assert.equal(trelloCardCreations.length, before);
  assert.match(replies.at(-1) ?? "", /protected by server security settings/i);
});

test("rejects setup controls clicked by another administrator and expired setup controls", async () => {
  await setSecurity({});
  const { root } = await openSettings("setup-owner");
  const rootPayload = latestComponentPayload(root);
  const rootSelect = renderedSelect(rootPayload);
  const securityCategory = renderedOption(rootPayload, "settings-category:security");
  const category = select("setup-owner", rootSelect.customId, [securityCategory]);
  await dispatchRaw(category);
  const categoryPayload = latestComponentPayload(category);
  const categorySelect = renderedSelect(categoryPayload);
  const securityPage = renderedOption(categoryPayload, "setup:security");
  await dispatchRaw(select("setup-other", categorySelect.customId, [securityPage]));
  assert.match(replies.at(-1) ?? "", /setup session has expired|belongs to another administrator/i);
  await dispatchRaw(select("setup-owner", categorySelect.customId, [securityPage], "component-message-stale"));
  assert.match(replies.at(-1) ?? "", /older settings message|expired session/i);

  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60_000;
  try {
    await dispatchRaw(select("setup-owner", categorySelect.customId, [securityPage]));
    assert.match(replies.at(-1) ?? "", /settings session has expired/i);
  } finally {
    Date.now = realNow;
  }
});

test("/settings traverses categories and opens nonce-bound parameter modals", async () => {
  await setSecurity({ confirmationsRequired: true });
  shownModals.splice(0);
  const expectedCategories: Record<string, string[]> = {
    moderation: [
      "setup:blacklist", "settings-action:group", "settings-action:note",
      "settings-action:identity-lookup",
    ],
    integrations: ["setup:trello", "settings-action:sync"],
    security: [
      "setup:security", "settings-action:lockdown", "settings-action:unlock",
      "setup:identity",
    ],
    logs: ["setup:audit", "setup:discord"],
    uniforms: ["setup:uniforms"],
    system: [
      "settings-action:status", "settings-action:maintenance-enable",
      "settings-action:maintenance-disable", "setup:bot-state", "setup:view",
    ],
  };
  const rootResult = await openSettings("admin-a");
  assert.deepEqual(renderedOptions(rootResult.payload), [
    "settings-category:moderation",
    "settings-category:integrations",
    "settings-category:security",
     "settings-category:logs",
     "settings-category:uniforms",
     "settings-category:system",
  ]);
  for (const [categoryName, expectedOptions] of Object.entries(expectedCategories)) {
    const { payload } = await chooseSettingsCategory("admin-a", rootResult.root, categoryName);
    assert.deepEqual(
      renderedOptions(payload),
      expectedOptions,
      `${categoryName} should expose only its related settings`,
    );
  }

  for (const [categoryName, action, expectedModal] of [
    ["moderation", "settings-action:group", "settings-modal:group:"],
    ["moderation", "settings-action:note", "settings-modal:note:"],
    ["moderation", "settings-action:identity-lookup", "settings-modal:identity-lookup:"],
    ["system", "settings-action:maintenance-enable", "settings-modal:maintenance-enable:"],
    ["security", "settings-action:lockdown", "settings-modal:lockdown:"],
    ["security", "settings-action:unlock", "settings-modal:unlock:"],
  ] as const) {
    const { root } = await openSettings("admin-a");
    const category = await chooseSettingsCategory("admin-a", root, categoryName);
    await chooseSettingsAction("admin-a", category, action);
    assert.ok(shownModals.at(-1)?.customId.startsWith(expectedModal), `${action} should open its modal`);
  }
});

test("sealed settings modals keep field IDs stable while binding modal sessions", async () => {
  await setSecurity({
    confirmationsRequired: false,
    perAdminLimit: 20,
    globalLimit: 20,
    windowMinutes: 5,
    automaticLockdownThreshold: 20,
  });
  shownModals.splice(0);

  const ratesRoot = await openSettings("admin-a");
  const ratesCategory = await chooseSettingsCategory("admin-a", ratesRoot.root, "security");
  const ratesPage = await chooseSettingsAction("admin-a", ratesCategory, "setup:security");
  await dispatchRaw(button(
    "admin-a",
    renderedButton(latestComponentPayload(ratesPage), "Edit Rate Limits"),
  ));
  const ratesModal = shownModals.at(-1);
  assert.ok(ratesModal);
  assert.equal(ratesModal.userId, "admin-a");
  assert.match(ratesModal.customId, /^setup-modal:rates:[a-f0-9]{32}$/);
  const rateInputIds = modalTextInputIds(ratesModal);
  assert.deepEqual(rateInputIds, ["per_admin", "global", "window"]);
  assert.ok(
    rateInputIds.every((id) => !/:([a-f0-9]{32})$/.test(id)),
    "text input IDs must remain stable field keys, not session controls",
  );

  const rateValues: Record<string, string> = Object.fromEntries(rateInputIds.map((id) => [
    id,
    ({ per_admin: "7", global: "19", window: "23" } as Record<string, string>)[id]!,
  ]));
  await dispatchRaw(modal("admin-a", ratesModal.customId, rateValues));
  const savedRates = await (await import("../src/bot/setup-store.ts")).getGuildSetup(guild.id);
  assert.deepEqual(
    {
      perAdminLimit: savedRates?.security?.perAdminLimit,
      globalLimit: savedRates?.security?.globalLimit,
      windowMinutes: savedRates?.security?.windowMinutes,
    },
    { perAdminLimit: 7, globalLimit: 19, windowMinutes: 23 },
  );

  // The emitted modal ID is user/session bound as well. A different
  // administrator and an expired owner may not submit it, even with the
  // exact field IDs Discord emitted.
  const foreignBefore = savedRates?.security;
  await dispatchRaw(modal("admin-b", ratesModal.customId, rateValues));
  assert.match(replies.at(-1) ?? "", /settings session has expired|another administrator/i);
  const afterForeign = await (await import("../src/bot/setup-store.ts")).getGuildSetup(guild.id);
  assert.deepEqual(afterForeign?.security, foreignBefore);

  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60_000;
  try {
    await dispatchRaw(modal("admin-a", ratesModal.customId, rateValues));
    assert.match(replies.at(-1) ?? "", /settings session has expired/i);
  } finally {
    Date.now = realNow;
  }
  const afterExpired = await (await import("../src/bot/setup-store.ts")).getGuildSetup(guild.id);
  assert.deepEqual(afterExpired?.security, foreignBefore);

  // Threshold uses the same legacy setup-component renderer and therefore
  // exercises the generic sealing path with a second parameter modal.
  shownModals.splice(0);
  const thresholdRoot = await openSettings("admin-a");
  const thresholdCategory = await chooseSettingsCategory("admin-a", thresholdRoot.root, "security");
  const securityPage = await chooseSettingsAction("admin-a", thresholdCategory, "setup:security");
  const lockdown = button(
    "admin-a",
    renderedButton(latestComponentPayload(securityPage), "Lockdown Settings"),
  );
  await dispatchRaw(lockdown);
  const thresholdButton = renderedButton(latestComponentPayload(lockdown), "Change Threshold");
  await dispatchRaw(button("admin-a", thresholdButton));
  const thresholdModal = shownModals.at(-1);
  assert.ok(thresholdModal);
  assert.match(thresholdModal.customId, /^setup-modal:threshold:[a-f0-9]{32}$/);
  const thresholdInputIds = modalTextInputIds(thresholdModal);
  assert.deepEqual(thresholdInputIds, ["threshold"]);
  await dispatchRaw(modal("admin-a", thresholdModal.customId, {
    [thresholdInputIds[0]!]: "37",
  }));
  const savedThreshold = await (await import("../src/bot/setup-store.ts")).getGuildSetup(guild.id);
  assert.equal(savedThreshold?.security?.automaticLockdownThreshold, 37);
});

test("settings navigation returns through categories, nested pages, and saved results", async () => {
  await setSecurity({ confirmationsRequired: false });

  const first = await openSettings("admin-a");
  assertDiscordComponentLimits(first.payload);
  const moderation = await chooseSettingsCategory("admin-a", first.root, "moderation");
  assert.equal(moderation.interaction.replied, true, "category selection must acknowledge with update");
  assertDiscordComponentLimits(moderation.payload);
  const categoryBack = renderedButton(moderation.payload, "Back to Categories", "settings:");
  await dispatchRaw(button("admin-a", categoryBack));
  const rootAfterCategoryBack = latestComponentPayload(first.root);
  assert.ok(renderedSelect(rootAfterCategoryBack).customId.startsWith("settings:select:"));

  const security = await chooseSettingsCategory("admin-a", first.root, "security");
  const securityPage = await chooseSettingsAction("admin-a", security, "setup:security");
  assert.equal(securityPage.replied, true, "deeper settings page must acknowledge with update");
  const securityPayload = latestComponentPayload(securityPage);
  assertDiscordComponentLimits(securityPayload);
  const lockdownButton = renderedButton(securityPayload, "Lockdown Settings");
  const lockdown = button("admin-a", lockdownButton);
  await dispatchRaw(lockdown);
  assert.equal(lockdown.replied, true, "nested settings page must acknowledge with update");
  const lockdownPayload = latestComponentPayload(lockdown);
  assertDiscordComponentLimits(lockdownPayload);
  const lockdownBack = renderedButton(lockdownPayload, "Back", "settings:");
  const lockdownBackInteraction = button("admin-a", lockdownBack);
  await dispatchRaw(lockdownBackInteraction);
  const securityAgain = latestComponentPayload(lockdownBackInteraction);
  assert.ok(renderedButton(securityAgain, "Back to Category", "settings:"));
  const securityBack = renderedButton(securityAgain, "Back to Category", "settings:");
  const securityBackInteraction = button("admin-a", securityBack);
  await dispatchRaw(securityBackInteraction);
  const securityCategoryAgain = latestComponentPayload(securityBackInteraction);
  assert.ok(renderedSelect(securityCategoryAgain).customId.startsWith("settings:option:security:"));
  const rootBack = renderedButton(securityCategoryAgain, "Back to Categories", "settings:");
  const rootBackInteraction = button("admin-a", rootBack);
  await dispatchRaw(rootBackInteraction);
  assert.ok(renderedSelect(latestComponentPayload(rootBackInteraction)).customId.startsWith("settings:select:"));

  const integrationRoot = await openSettings("admin-a");
  const integrations = await chooseSettingsCategory("admin-a", integrationRoot.root, "integrations");
  const sync = await chooseSettingsAction("admin-a", integrations, "settings-action:sync");
  assert.equal(sync.deferred, true, "report-only sync must acknowledge with deferUpdate");

  const saveRoot = await openSettings("admin-a");
  const saveIntegrations = await chooseSettingsCategory("admin-a", saveRoot.root, "integrations");
  const trelloPage = await chooseSettingsAction("admin-a", saveIntegrations, "setup:trello");
  const trelloPayload = latestComponentPayload(trelloPage);
  const toggle = renderedButton(trelloPayload, "Toggle manual alerts");
  const saved = button("admin-a", toggle);
  await dispatchRaw(saved);
  assert.equal(saved.replied, true, "save action must acknowledge with update");
  const savedPayload = latestComponentPayload(saved);
  assertDiscordComponentLimits(savedPayload);
  assert.ok(renderedButton(savedPayload, "Back to Category", "settings:"));
});

test("a /settings group-blacklist modal preserves confirmation binding and executes real moderation", async () => {
  await setSecurity({ confirmationsRequired: true, perAdminLimit: 20, globalLimit: 20 });
  const before = trelloCardCreations.length;
  const { root } = await openSettings("admin-a");
  const category = await chooseSettingsCategory("admin-a", root, "moderation");
  await chooseSettingsAction("admin-a", category, "settings-action:group");
  const groupModal = shownModals.at(-1);
  assert.ok(groupModal?.customId.startsWith("settings-modal:group:"));
  const submitted = modal("admin-a", groupModal!.customId, { id: "777001", reason: "settings modal regression" });
  await dispatchRaw(submitted);
  const confirmation = lastConfirmationId(submitted);
  await dispatchRaw(button("setup-other", confirmation));
  assert.equal(trelloCardCreations.length, before, "a foreign administrator cannot use the modal confirmation");
  await dispatchRaw(button("admin-a", confirmation));
  assert.equal(trelloCardCreations.length, before + 1);
});

test("/settings restricts the maintenance menu while allowing emergency status", async () => {
  await setSecurity({});
  const preMaintenance = await openSettings("admin-a");
  const moderation = await chooseSettingsCategory("admin-a", preMaintenance.root, "moderation");
  const staleNormalControl = {
    customId: renderedSelect(moderation.payload).customId,
    value: renderedOption(moderation.payload, "settings-action:group"),
    messageId: latestComponentMessageId,
  };
  await setMaintenance(true, "admin-a", "settings emergency restriction");
  const { root } = await openSettings("admin-a");
  assert.deepEqual(renderedOptions(latestComponentPayload(root)).sort(), [
    "settings-category:security", "settings-category:system",
  ]);
  const system = await chooseSettingsCategory("admin-a", root, "system");
  assert.deepEqual(renderedOptions(system.payload), [
    "settings-action:status", "settings-action:maintenance-disable",
  ]);
  const status = await chooseSettingsAction("admin-a", system, "settings-action:status");
  assert.ok(status.replied, "status selection must acknowledge with update");
  await dispatchRaw(select(
    "admin-a",
    staleNormalControl.customId,
    [staleNormalControl.value],
    staleNormalControl.messageId,
  ));
  const beforeRequests = providerRequests;
  assert.equal(providerRequests, beforeRequests, "maintenance must block forged normal actions before providers");
  assert.match(
    replies.at(-1) ?? "",
    /BOT UNDER MAINTENANCE|expired session/i,
    "maintenance must block stale normal navigation without invoking a provider",
  );
  await setMaintenance(false, "admin-a", "restriction test complete");
});

test("/settings performs first-time audit-channel setup through its modal", async () => {
  await writeFile(config.setupFile, JSON.stringify({ guilds: [] }), "utf8");
  await mutateSecurityState(guild.id, (state) => {
    state.maintenance = {
      active: false, reason: "", startedAt: null, startedBy: null,
      revision: state.maintenance.revision + 1,
    };
  });
  const { root } = await openSettings("admin-a");
  const system = await chooseSettingsCategory("admin-a", root, "system");
  await chooseSettingsAction("admin-a", system, "settings-action:initial-audit");
  const initial = shownModals.at(-1);
  assert.ok(initial?.customId.startsWith("settings-modal:initial-audit:"));
  await dispatchRaw(modal("admin-a", initial!.customId, { audit_channel_id: "12345678901234567" }));
  const persisted = await (await import("../src/bot/setup-store.ts")).getGuildSetup(guild.id);
  assert.equal(persisted?.auditChannelId, "12345678901234567");
  assert.equal("presence" in (persisted ?? {}), false);
});

test("settings and the Discord client constructor have no custom presence controls", async () => {
  await setSecurity({});
  const settings = command("admin-a", "settings");
  await dispatch(settings);
  lastSettingsSelectId(settings);
  const menu = settings.localReplies.find(
    (reply): reply is { components: Array<{ components: Array<{ data: { options: Array<{ value: string }> } }> }> } =>
      typeof reply === "object" && reply !== null && "components" in reply,
  );
  const selectData = menu?.components[0]?.components[0] as unknown as {
    data?: { options?: Array<{ value: string }> };
    options?: Array<{ value: string }>;
  } | undefined;
  const choices = (selectData?.data?.options ?? selectData?.options ?? [])
    .map((choice) => (choice.value ?? (choice as unknown as { data?: { value?: string } }).data?.value ?? "")
      .replace(/:[a-f0-9]{32}$/, ""));
  assert.ok(!choices.some((choice) => /presence|activity/i.test(choice)));
  const constructorPresence = (client as unknown as {
    options?: { presence?: { status?: string; activities?: unknown } };
  } | undefined)?.options?.presence;
  // discord.js supplies its own neutral online default. The bot must not
  // provide an activity or override that default in the Client constructor.
  assert.equal(constructorPresence?.status, "online");
  assert.equal(constructorPresence?.activities, undefined);
});

test("setup migration removes only obsolete presence fields", async () => {
  await writeFile(config.setupFile, JSON.stringify({
    guilds: [{
      guildId: "legacy-presence-guild",
      moderatorRoleId: "role",
      auditChannelId: "12345678901234567",
      presence: {
        enabled: true,
        activities: ["Customers"],
        rotationEnabled: false,
        minIntervalMinutes: 5,
        maxIntervalMinutes: 20,
      },
      security: { marker: "preserve" },
      updatedBy: "admin-a",
      updatedAt: new Date().toISOString(),
    }],
  }), "utf8");
  const store = await import("../src/bot/setup-store.ts");
  const migrated = await store.getGuildSetup("legacy-presence-guild");
  assert.equal("presence" in (migrated ?? {}), false);
  assert.deepEqual((migrated as unknown as { security: { marker: string } }).security, { marker: "preserve" });
  const persisted = JSON.parse(await readFile(config.setupFile, "utf8")) as { guilds: Array<Record<string, unknown>> };
  assert.equal("presence" in persisted.guilds[0]!, false);
  assert.deepEqual(persisted.guilds[0]?.security, { marker: "preserve" });
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

test("maintenance enable is confirmed, persisted, and audited", async () => {
  await setSecurity({ confirmationsRequired: false });
  const pending = command("admin-a", "maintenance", {
    mode: "enable", reason: "Updating Trello integration",
  });
  await dispatch(pending);
  const confirmation = lastMaintenanceConfirmationId(pending);
  await dispatchRaw(button("admin-a", confirmation));

  const state = await getSecurityState(guild.id);
  assert.equal(state.maintenance.active, true);
  assert.equal(state.maintenance.reason, "Updating Trello integration");
  assert.equal(state.maintenance.startedBy, "admin-a");
  assert.equal(state.maintenanceAudit.at(-1)?.active, true);
  assert.equal(state.maintenanceAudit.at(-1)?.reason, "Updating Trello integration");
  const restarted = await import(`../src/bot/security-store.ts?maintenance=${Date.now()}`);
  assert.equal((await restarted.getSecurityState(guild.id)).maintenance.active, true);
});

test("maintenance confirmations reject foreign, expired, demoted, and stale actions", async () => {
  await setSecurity({});
  const unauthorized = command("member", "maintenance", { mode: "enable", reason: "unauthorized" });
  await dispatch(unauthorized);
  assert.equal((await getSecurityState(guild.id)).maintenance.active, false);
  assert.match(replies.at(-1) ?? "", /Only a current Discord Administrator/i);

  const foreign = command("admin-a", "maintenance", { mode: "enable", reason: "foreign" });
  await dispatch(foreign);
  await dispatchRaw(button("admin-b", lastMaintenanceConfirmationId(foreign)));
  assert.equal((await getSecurityState(guild.id)).maintenance.active, false);
  assert.match(replies.at(-1) ?? "", /belongs to another administrator/i);

  const expired = command("admin-a", "maintenance", { mode: "enable", reason: "expired" });
  await dispatch(expired);
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60_000;
  try {
    await dispatchRaw(button("admin-a", lastMaintenanceConfirmationId(expired)));
  } finally {
    Date.now = realNow;
  }
  assert.equal((await getSecurityState(guild.id)).maintenance.active, false);

  const demoted = command("admin-a", "maintenance", { mode: "enable", reason: "demoted" });
  await dispatch(demoted);
  members.set("admin-a", { administrator: false });
  try {
    await dispatchRaw(button("admin-a", lastMaintenanceConfirmationId(demoted)));
    assert.equal((await getSecurityState(guild.id)).maintenance.active, false);
    assert.match(replies.at(-1) ?? "", /Only a current Discord Administrator/i);
  } finally {
    members.set("admin-a", { administrator: true });
  }

  const stale = command("admin-a", "maintenance", { mode: "enable", reason: "stale" });
  await dispatch(stale);
  await mutateSecurityState(guild.id, (state) => {
    state.maintenance.revision += 1;
  });
  await dispatchRaw(button("admin-a", lastMaintenanceConfirmationId(stale)));
  assert.equal((await getSecurityState(guild.id)).maintenance.active, false);
  assert.match(replies.at(-1) ?? "", /stale/i);
});

test("maintenance blocks every normal command and old interactive work before providers or limits", async () => {
  await setSecurity({ confirmationsRequired: true });
  const oldBlacklist = command("admin-a", "group_blacklist", { id: "888", reason: "old confirmation" });
  await dispatch(oldBlacklist);
  const oldBlacklistConfirmation = lastConfirmationId(oldBlacklist);

  const setupStart = command("admin-a", "setup");
  await dispatch(setupStart);
  await dispatchRaw(button("admin-a", "setup:bot-state"));
  await dispatchRaw(button("admin-a", "setup:enable-maintenance"));
  const oldModal = shownModals.at(-1);
  assert.ok(oldModal?.customId.startsWith("setup-modal:maintenance-reason:"));

  await setMaintenance(true, "admin-b", "command freeze");
  const beforeRequests = providerRequests;
  const beforeCards = trelloCardCreations.length;
  const beforeActions = (await getSecurityState(guild.id)).destructiveActions.length;
  for (const name of [
    "blacklist", "group_blacklist", "revoke_blacklist", "blacklist_note",
    "blacklist_sync", "identity_lookup", "blacklist_lookup", "setup",
  ]) {
    await dispatch(command("admin-a", name));
  }
  await dispatchRaw(button("admin-a", oldBlacklistConfirmation));
  await dispatchRaw(modal("admin-a", oldModal!.customId, { reason: "must not execute" }));

  assert.equal(providerRequests, beforeRequests);
  assert.equal(trelloCardCreations.length, beforeCards);
  assert.equal((await getSecurityState(guild.id)).destructiveActions.length, beforeActions);
  assert.match(replies.at(-1) ?? "", /BOT UNDER MAINTENANCE/i);
});

test("maintenance allows status and emergency lockdown/unlock, then confirmed disable restores normal operation", async () => {
  if (!(await getSecurityState(guild.id)).maintenance.active) {
    await setSecurity({});
    await setMaintenance(true, "admin-a", "emergency command test");
  }
  await dispatch(command("admin-a", "security_status"));
  assert.match(replies.at(-1) ?? "", /Maintenance: ENABLED/);
  assert.match(replies.at(-1) ?? "", /Blacklist Commands: DISABLED — MAINTENANCE/);

  await dispatch(command("admin-a", "security_lockdown", { reason: "incident during maintenance" }));
  assert.equal((await getSecurityState(guild.id)).lockdown.active, true);
  await dispatch(command("admin-a", "security_status"));
  assert.match(replies.at(-1) ?? "", /Operational State: Maintenance: ENABLED/, "maintenance takes precedence over lockdown in status");
  const unlock = command("admin-a", "security_unlock", { reason: "resolved" });
  await dispatch(unlock);
  await dispatchRaw(button("admin-a", lastConfirmationId(unlock)));
  assert.equal((await getSecurityState(guild.id)).lockdown.active, false);

  await setMaintenance(false, "admin-a", "maintenance completed");
  const state = await getSecurityState(guild.id);
  assert.equal(state.maintenance.active, false);
  assert.equal(state.maintenanceAudit.at(-1)?.active, false);
  assert.equal(state.maintenanceAudit.at(-1)?.durationSeconds !== null, true);
  await dispatch(command("admin-a", "security_lockdown", { reason: "post-maintenance incident" }));
  await dispatch(command("admin-a", "security_status"));
  assert.match(replies.at(-1) ?? "", /Operational State: Security lockdown: LOCKED/);
  assert.match(replies.at(-1) ?? "", /Maintenance: Disabled/);
  const finalUnlock = command("admin-a", "security_unlock", { reason: "resolved" });
  await dispatch(finalUnlock);
  await dispatchRaw(button("admin-a", lastConfirmationId(finalUnlock)));
});

test("security status reports setup-required before setup and persisted maintenance renders before delayed registration", async () => {
  await writeFile(config.setupFile, JSON.stringify({ guilds: [] }), "utf8");
  await mutateSecurityState(guild.id, (state) => {
    state.maintenance = {
      active: false, reason: "", startedAt: null, startedBy: null, revision: state.maintenance.revision + 1,
    };
  });
  await dispatch(command("admin-a", "security_status"));
  assert.match(replies.at(-1) ?? "", /Operational State: Bot state: SETUP REQUIRED OR COMMANDS UNREGISTERED/);

  await setSecurity({});
  await mutateSecurityState(guild.id, (state) => {
    state.maintenance = {
      active: true, reason: "reconnect order", startedAt: new Date().toISOString(), startedBy: "admin-a",
      revision: state.maintenance.revision + 1,
    };
  });
  const originalSet = guild.commands.set;
  let releaseRegistration!: () => void;
  const registrationGate = new Promise<void>((resolve) => { releaseRegistration = resolve; });
  guild.commands.set = async () => {
    await registrationGate;
  };
  try {
    const reconnect = refreshBot("manual");
    await settle();
    releaseRegistration();
    await reconnect;
  } finally {
    guild.commands.set = originalSet;
  }
  await setMaintenance(false, "admin-a", "reconnect test complete");
});

test("setup BOT STATE opens a reason modal and background join/recovery work continues in maintenance", async () => {
  await setSecurity({});
  const setupStart = command("admin-a", "setup");
  await dispatch(setupStart);
  await dispatchRaw(button("admin-a", "setup:bot-state"));
  await dispatchRaw(button("admin-a", "setup:enable-maintenance"));
  const setupModal = shownModals.at(-1);
  assert.ok(setupModal?.customId.startsWith("setup-modal:maintenance-reason:"));
  const submitted = modal("admin-a", setupModal!.customId, { reason: "setup initiated" });
  await dispatchRaw(submitted);
  const setupConfirmation = lastMaintenanceConfirmationId(submitted);
  await dispatchRaw(button("admin-a", setupConfirmation));
  assert.equal((await getSecurityState(guild.id)).maintenance.active, true);

  trelloCards = [{
    id: "maintenance-active-card",
    name: "Builder | 9001",
    desc: "- active during maintenance",
    idList: "list-0",
    idLabels: ["label-blacklisted", "label-appealable"],
    url: "https://trello.test/maintenance-active-card",
    dateLastActivity: new Date().toISOString(),
    closed: false,
  }];
  members.set("joined-during-maintenance", {
    administrator: false, username: "Builder", globalName: "Builder", nickname: "Builder",
    roleIds: ["ordinary-role"],
  });
  await saveRoleSnapshot({
    key: `${guild.id}:9001`,
    guildId: guild.id,
    discordUserId: "joined-during-maintenance",
    robloxUserId: 9001,
    robloxUsername: "Builder",
    roleIds: ["ordinary-role"],
    cardId: "approved-maintenance-card",
    cardUrl: "https://trello.test/approved-maintenance-card",
    blacklistType: "appealable",
    blacklistReason: "approved before maintenance",
    source: "command",
    status: "active",
    createdAt: new Date().toISOString(),
  });
  // A recovery scan primes the same cached index that the join listener uses.
  // It is intentionally executed while maintenance is active.
  await refreshBot("manual");
  const beforeRoleMutation = roleMutationCalls;
  client!.emit(Events.GuildMemberAdd, memberFor("joined-during-maintenance"));
  await settle();
  await settle();
  assert.ok(roleMutationCalls > beforeRoleMutation, "join enforcement must keep applying blacklist restrictions");

  const beforeRecoveryPoll = providerRequests;
  await refreshBot("manual");
  assert.ok(providerRequests > beforeRecoveryPoll, "background recovery/synchronization remains active");
  trelloCards = [];
  await setMaintenance(false, "admin-a", "background test complete");
});
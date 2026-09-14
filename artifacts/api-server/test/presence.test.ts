import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityType } from "discord.js";
import {
  applyPresenceSettings,
  DEFAULT_PRESENCE_SETTINGS,
  stopPresenceRotation,
  validatePresenceSettings,
  setPresencePriority,
  getEffectivePresence,
  getPresenceActivityPreview,
  setPresenceStatsProvider,
} from "../src/bot/presence.ts";

const flushRotation = () => new Promise<void>((resolve) => setImmediate(resolve));
test("presence starts watching Customers and disabling clears activities", () => {
  const calls: unknown[] = [];
  const client = { user: { setPresence: (value: unknown) => calls.push(value) } };
  try {
    applyPresenceSettings(client as never, DEFAULT_PRESENCE_SETTINGS);
    assert.deepEqual(calls[0], { status: "online", activities: [{ name: "Customers", type: ActivityType.Watching }] });
    applyPresenceSettings(client as never, { ...DEFAULT_PRESENCE_SETTINGS, enabled: false });
    assert.deepEqual(calls[1], { status: "online", activities: [] });
  } finally {
    stopPresenceRotation();
  }
});

test("presence validates bounded intervals and activity content", () => {
  for (const changes of [
    { minIntervalMinutes: 0 },
    { minIntervalMinutes: 1 },
    { maxIntervalMinutes: 1441 },
    { minIntervalMinutes: 21, maxIntervalMinutes: 20 },
    { activities: [] },
    { activities: [" "] },
    { activities: ["bad\nactivity"] },
    { activities: ["@everyone"] },
    { activities: ["<@1234567890>"] },
    { activities: ["{UNKNOWN}"] },
    { activities: ["x".repeat(129)] },
    { activities: ["Customers"], disabledActivities: ["Customers"] },
  ]) {
    assert.throws(() => validatePresenceSettings({ ...DEFAULT_PRESENCE_SETTINGS, ...changes }));
  }
  const result = validatePresenceSettings({ ...DEFAULT_PRESENCE_SETTINGS, activities: [" Supply Operations "] });
  assert.deepEqual(result.activities, ["Supply Operations"]);
});

test("presence rotates and stopping cancels the next update", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0);
  const calls: unknown[] = [];
  const client = { user: { setPresence: (value: unknown) => calls.push(value) } };
  try {
    applyPresenceSettings(client as never, {
      ...DEFAULT_PRESENCE_SETTINGS,
      minIntervalMinutes: 2,
      maxIntervalMinutes: 2,
    });
    t.mock.timers.tick(120_000);
    await flushRotation();
    assert.deepEqual(calls[1], {
      status: "online",
      activities: [{ name: "Blacklist Records", type: ActivityType.Watching }],
    });
    stopPresenceRotation();
    t.mock.timers.tick(120_000);
    await flushRotation();
    assert.equal(calls.length, 2);
  } finally {
    stopPresenceRotation();
  }
});

test("maintenance pauses rotation, survives settings updates, and yields only to lockdown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0);
  const calls: unknown[] = [];
  const client = { user: { setPresence: (value: unknown) => calls.push(value) } } as never;
  const settings = { ...DEFAULT_PRESENCE_SETTINGS, minIntervalMinutes: 2, maxIntervalMinutes: 2 };
  try {
    applyPresenceSettings(client, settings);
    setPresencePriority(client, { maintenance: true });
    assert.deepEqual(calls.at(-1), { status: "idle", activities: [{ name: "Maintenance", type: ActivityType.Watching }] });
    const count = calls.length;
    t.mock.timers.tick(1_200_000);
    assert.equal(calls.length, count, "normal timer is cancelled throughout maintenance");
    applyPresenceSettings(client, settings);
    assert.equal(getEffectivePresence().activity, "Maintenance");
    setPresencePriority(client, { serviceFailure: true, startup: true });
    assert.equal(getEffectivePresence().mode, "maintenance");
    setPresencePriority(client, { lockdown: true });
    assert.deepEqual(calls.at(-1), { status: "dnd", activities: [{ name: "Security Lockdown", type: ActivityType.Watching }] });
    setPresencePriority(client, { lockdown: false });
    assert.equal(getEffectivePresence().activity, "Maintenance");
    setPresencePriority(client, { serviceFailure: false, startup: false, maintenance: false });
    assert.deepEqual(calls.at(-1), { status: "online", activities: [{ name: "Customers", type: ActivityType.Watching }] });
    t.mock.timers.tick(120_000);
    await flushRotation();
    assert.equal(getEffectivePresence().activity, "Blacklist Records");
  } finally {
    setPresencePriority(client, { lockdown: false, maintenance: false, serviceFailure: false, startup: false });
    stopPresenceRotation();
  }
});

test("unchanged priority refreshes do not postpone rotation, and lower priorities restore correctly", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0);
  const client = { user: { setPresence: () => undefined } } as never;
  try {
    applyPresenceSettings(client, { ...DEFAULT_PRESENCE_SETTINGS, minIntervalMinutes: 2, maxIntervalMinutes: 2 });
    t.mock.timers.tick(60_000);
    setPresencePriority(client, { serviceFailure: false, maintenance: false });
    t.mock.timers.tick(60_000);
    await flushRotation();
    assert.equal(getEffectivePresence().activity, "Blacklist Records");
    setPresencePriority(client, { startup: true, serviceFailure: true });
    assert.equal(getEffectivePresence().mode, "serviceFailure");
    setPresencePriority(client, { serviceFailure: false });
    assert.equal(getEffectivePresence().mode, "startup");
    setPresencePriority(client, { startup: false });
    assert.equal(getEffectivePresence().activity, "Customers");
  } finally {
    setPresencePriority(client, { lockdown: false, maintenance: false, serviceFailure: false, startup: false });
    stopPresenceRotation();
  }
});

test("preview resolves only supported, available live counts and exposes configured weights", () => {
  const preview = getPresenceActivityPreview(DEFAULT_PRESENCE_SETTINGS, { activeBlacklists: 17, serverMembers: 1284 });
  assert.equal(preview.find((item) => item.template === "Customers")?.weight, 30);
  assert.equal(preview.at(-2)?.activity, "17 Active Blacklists");
  assert.equal(preview.at(-1)?.activity, "1,284 Personnel");
  assert.equal(getPresenceActivityPreview(DEFAULT_PRESENCE_SETTINGS).at(-1)?.activity, null);
  assert.equal(getPresenceActivityPreview({ ...DEFAULT_PRESENCE_SETTINGS, dynamicActivitiesEnabled: false }, { serverMembers: 1284 }).at(-1)?.enabled, false);
});

test("weighted choices avoid repeats and select a new bounded delay each time", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const random = [0, 0, 0.5, 0, 0.99];
  t.mock.method(Math, "random", () => random.shift() ?? 0);
  const calls: unknown[] = [];
  const client = { user: { setPresence: (value: unknown) => calls.push(value) } } as never;
  setPresenceStatsProvider(async () => ({}));
  try {
    applyPresenceSettings(client, { ...DEFAULT_PRESENCE_SETTINGS, minIntervalMinutes: 2, maxIntervalMinutes: 4 });
    t.mock.timers.tick(119_999);
    await flushRotation();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(1);
    await flushRotation();
    assert.equal(getEffectivePresence().activity, "Blacklist Records");
    t.mock.timers.tick(179_999);
    await flushRotation();
    assert.equal(calls.length, 2);
    t.mock.timers.tick(1);
    await flushRotation();
    assert.equal(getEffectivePresence().activity, "Customers", "Customers has the first weighted range on the next draw");
  } finally { stopPresenceRotation(); }
});

test("dynamic retrieval failure skips dynamic entries and late statistics cannot overwrite maintenance", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.999);
  const client = { user: { setPresence: () => undefined } } as never;
  const settings = { ...DEFAULT_PRESENCE_SETTINGS, minIntervalMinutes: 2, maxIntervalMinutes: 2 };
  try {
    setPresenceStatsProvider(async () => ({ activeBlacklists: 17, serverMembers: 1284 }));
    applyPresenceSettings(client, settings);
    t.mock.timers.tick(120_000);
    await flushRotation();
    assert.equal(getEffectivePresence().activity, "1,284 Personnel");
    setPresenceStatsProvider(async () => { throw new Error("Store unavailable"); });
    t.mock.timers.tick(120_000);
    await flushRotation();
    assert.equal(getEffectivePresence().activity, "Personnel Records");
    let resolveStats!: (value: { activeBlacklists: number }) => void;
    setPresenceStatsProvider(() => new Promise((resolve) => { resolveStats = resolve; }));
    t.mock.timers.tick(120_000);
    await flushRotation();
    setPresencePriority(client, { maintenance: true });
    resolveStats({ activeBlacklists: 900 });
    await flushRotation();
    assert.equal(getEffectivePresence().activity, "Maintenance");
  } finally {
    setPresenceStatsProvider(async () => ({}));
    setPresencePriority(client, { maintenance: false });
    stopPresenceRotation();
  }
});

test("reinitialization replaces timers and suppresses redundant unchanged updates", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0);
  const calls: unknown[] = [];
  const client = { user: { setPresence: (value: unknown) => calls.push(value) } } as never;
  const settings = { ...DEFAULT_PRESENCE_SETTINGS, minIntervalMinutes: 2, maxIntervalMinutes: 2 };
  try {
    applyPresenceSettings(client, settings);
    applyPresenceSettings(client, settings);
    assert.equal(calls.length, 1);
    t.mock.timers.tick(120_000);
    await flushRotation();
    assert.equal(calls.length, 2, "exactly one rotation loop survives reinitialization");
    stopPresenceRotation();
    t.mock.timers.tick(1_200_000);
    await flushRotation();
    assert.equal(calls.length, 2);
  } finally { stopPresenceRotation(); }
});
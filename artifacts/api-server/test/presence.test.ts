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
} from "../src/bot/presence.ts";

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
    { maxIntervalMinutes: 1441 },
    { minIntervalMinutes: 21, maxIntervalMinutes: 20 },
    { activities: [] },
    { activities: [" "] },
    { activities: ["bad\nactivity"] },
  ]) {
    assert.throws(() => validatePresenceSettings({ ...DEFAULT_PRESENCE_SETTINGS, ...changes }));
  }
  const result = validatePresenceSettings({ ...DEFAULT_PRESENCE_SETTINGS, activities: [" Supply Operations "] });
  assert.deepEqual(result.activities, ["Supply Operations"]);
});

test("presence rotates and stopping cancels the next update", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: unknown[] = [];
  const client = { user: { setPresence: (value: unknown) => calls.push(value) } };
  try {
    applyPresenceSettings(client as never, {
      ...DEFAULT_PRESENCE_SETTINGS,
      minIntervalMinutes: 1,
      maxIntervalMinutes: 1,
    });
    t.mock.timers.tick(60_000);
    assert.deepEqual(calls[1], {
      status: "online",
      activities: [{ name: "Quartermaster Corps", type: ActivityType.Watching }],
    });
    stopPresenceRotation();
    t.mock.timers.tick(60_000);
    assert.equal(calls.length, 2);
  } finally {
    stopPresenceRotation();
  }
});

test("maintenance pauses rotation, survives settings updates, and yields only to lockdown", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: unknown[] = [];
  const client = { user: { setPresence: (value: unknown) => calls.push(value) } } as never;
  const settings = { ...DEFAULT_PRESENCE_SETTINGS, minIntervalMinutes: 1, maxIntervalMinutes: 1 };
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
    t.mock.timers.tick(60_000);
    assert.equal(getEffectivePresence().activity, "Quartermaster Corps");
  } finally {
    setPresencePriority(client, { lockdown: false, maintenance: false, serviceFailure: false, startup: false });
    stopPresenceRotation();
  }
});

test("unchanged priority refreshes do not postpone rotation, and lower priorities restore correctly", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = { user: { setPresence: () => undefined } } as never;
  try {
    applyPresenceSettings(client, { ...DEFAULT_PRESENCE_SETTINGS, minIntervalMinutes: 1, maxIntervalMinutes: 1 });
    t.mock.timers.tick(30_000);
    setPresencePriority(client, { serviceFailure: false, maintenance: false });
    t.mock.timers.tick(30_000);
    assert.equal(getEffectivePresence().activity, "Quartermaster Corps");
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
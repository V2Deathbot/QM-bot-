import assert from "node:assert/strict";
import { test } from "node:test";
import { ActivityType } from "discord.js";
import {
  applyPresenceSettings,
  DEFAULT_PRESENCE_SETTINGS,
  stopPresenceRotation,
  validatePresenceSettings,
} from "../src/bot/presence.ts";

test("presence starts watching Customers and disabling clears activities", () => {
  const calls: unknown[] = [];
  const client = { user: { setPresence: (value: unknown) => calls.push(value) } };
  try {
    applyPresenceSettings(client as never, DEFAULT_PRESENCE_SETTINGS);
    assert.deepEqual(calls[0], { activities: [{ name: "Customers", type: ActivityType.Watching }] });
    applyPresenceSettings(client as never, { ...DEFAULT_PRESENCE_SETTINGS, enabled: false });
    assert.deepEqual(calls[1], { activities: [] });
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
      activities: [{ name: "Quartermaster Corps", type: ActivityType.Watching }],
    });
    stopPresenceRotation();
    t.mock.timers.tick(60_000);
    assert.equal(calls.length, 2);
  } finally {
    stopPresenceRotation();
  }
});
import assert from "node:assert/strict";
import test from "node:test";
import { mapDiscordPresenceToPublicStatus } from "../src/bot/public-status";

test("maps Discord presence to the public three-state status", () => {
  assert.equal(mapDiscordPresenceToPublicStatus("online", false, true), "online");
  assert.equal(mapDiscordPresenceToPublicStatus("idle", false, true), "maintenance");
  assert.equal(mapDiscordPresenceToPublicStatus("online", true, true), "maintenance");
  assert.equal(mapDiscordPresenceToPublicStatus("invisible", false, true), "offline");
  assert.equal(mapDiscordPresenceToPublicStatus("offline", false, true), "offline");
  assert.equal(mapDiscordPresenceToPublicStatus("online", false, false), "offline");
});
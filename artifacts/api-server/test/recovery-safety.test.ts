import assert from "node:assert/strict";
import { mkdtemp, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Collection } from "discord.js";

const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "recovery-safety-"));
process.env.ROLE_SNAPSHOT_FILE = path.join(dataDirectory, "snapshots.json");
process.env.TRELLO_API_KEY = "recovery-key";
process.env.TRELLO_TOKEN = "recovery-token";
process.env.TRELLO_BOARD_ID = "recovery-board";
process.env.TRELLO_LIST_APPEALABLE = "Appealable Blacklist";
process.env.TRELLO_LIST_CONDITIONAL = "Conditional Blacklist";
process.env.TRELLO_LIST_PERMANENT = "Permanent Blacklist";
process.env.TRELLO_LIST_REVOKED = "Revoked Blacklist";
process.env.TRELLO_LIST_GROUP = "Group Blacklist";

const {
  enforceBlacklistForJoinedMember,
  processApprovedRevocation,
} = await import("../src/bot/blacklist-sync.ts");
const {
  findRoleSnapshot,
  saveRoleSnapshot,
} = await import("../src/bot/role-store.ts");

const setup = {
  guildId: "recovery-guild",
  moderatorRoleId: "moderator",
  auditChannelId: "12345678901234567",
  updatedBy: "admin",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function snapshot(robloxUserId: number, discordUserId: string, status: "pending" | "revocation_pending") {
  return {
    key: `recovery-guild:${robloxUserId}`,
    guildId: "recovery-guild",
    discordUserId,
    robloxUserId,
    robloxUsername: `Builder${robloxUserId}`,
    roleIds: ["role-1"],
    cardId: `card-${robloxUserId}`,
    cardUrl: `https://trello.test/card-${robloxUserId}`,
    source: "command" as const,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function fixture(memberId: string) {
  const roles = new Collection([
    ["role-1", { id: "role-1", name: "Verified", managed: false, position: 1 }],
  ]);
  const memberRoles = new Collection<string, {
    id: string; name: string; managed: boolean; position: number;
  }>();
  const restored: string[][] = [];
  const removed: string[][] = [];
  const directMessages: string[] = [];
  const guild = {
    id: "recovery-guild",
    client: { user: { id: "bot" } },
    roles: { cache: roles },
    members: { me: { id: "bot", roles: { highest: { position: 10 } } } },
  };
  const member = {
    id: memberId,
    guild,
    user: { username: "Builder", globalName: null },
    nickname: null,
    roles: {
      cache: memberRoles,
      remove: async (ids: string[]) => {
        removed.push([...ids]);
        ids.forEach((id) => memberRoles.delete(id));
      },
      add: async (ids: string[]) => {
        restored.push([...ids]);
        ids.forEach((id) => {
          const role = roles.get(id);
          if (role) memberRoles.set(id, role);
        });
      },
    },
    send: async ({ content }: { content: string }) => {
      directMessages.push(content);
    },
  };
  return { guild, member, restored, removed, directMessages };
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}

test("recovery keeps restrictions through Trello failures, retries the exact card, and completes absent-member revocations once", async () => {
  const originalFetch = globalThis.fetch;
  let outage = false;
  let cardRequests = 0;
  let interruptMarkerWrite = false;
  const interruptedDirectory = `${dataDirectory}-during-marker-write`;
  globalThis.fetch = async (input) => {
    const pathname = new URL(input.toString()).pathname;
    if (outage) throw new Error("temporary Trello outage");
    if (pathname.startsWith("/1/cards/card-")) {
      cardRequests += 1;
      if (interruptMarkerWrite && pathname === "/1/cards/card-4") {
        interruptMarkerWrite = false;
        await rename(dataDirectory, interruptedDirectory);
        await writeFile(dataDirectory, "not a directory");
      }
      const id = pathname.split("/").at(-1)!;
      return json({
        id,
        name: "Builder | 1",
        desc: "- policy",
        idList: "active-list",
        idLabels: ["type-label"],
        url: `https://trello.test/${id}`,
        dateLastActivity: "2026-01-02T00:00:00.000Z",
        closed: false,
      });
    }
    if (pathname.endsWith("/lists")) {
      return json([{ id: "revoked-list", name: "Revoked Blacklist" }]);
    }
    if (pathname.endsWith("/labels")) {
      return json([
        { id: "type-label", name: "Permanent", color: "red" },
        { id: "revoked-label", name: "Revoked", color: "green" },
      ]);
    }
    return json({});
  };

  try {
    const absent = fixture("departed");
    const pending = { ...snapshot(1, "departed", "revocation_pending") };
    await saveRoleSnapshot(pending);
    absent.member.roles.cache.set("role-1", absent.guild.roles.cache.get("role-1")!);

    outage = true;
    await assert.rejects(() =>
      processApprovedRevocation(absent.guild as never, setup, pending),
    );
    assert.equal((await findRoleSnapshot("recovery-guild", 1))?.revocationCardMovedAt, undefined);
    await assert.rejects(() =>
      enforceBlacklistForJoinedMember(absent.member as never, setup),
    );
    assert.deepEqual(absent.removed, [["role-1"]], "a failed move keeps prior restrictions enforced");

    outage = false;
    const moved = await processApprovedRevocation(absent.guild as never, setup, pending);
    assert.equal(moved.moved, true);
    assert.equal(moved.completed, false);
    const persisted = await findRoleSnapshot("recovery-guild", 1);
    assert.ok(persisted?.revocationCardMovedAt);
    const requestsAfterMove = cardRequests;
    await processApprovedRevocation(absent.guild as never, setup, persisted!);
    assert.equal(cardRequests, requestsAfterMove, "a persisted marker does not repeat Trello work");

    await enforceBlacklistForJoinedMember(absent.member as never, setup);
    await enforceBlacklistForJoinedMember(absent.member as never, setup);
    assert.deepEqual(absent.restored, [["role-1"]]);
    assert.equal(absent.directMessages.length, 1);
    assert.equal((await findRoleSnapshot("recovery-guild", 1))?.status, "revoked");

    const active = fixture("active-member");
    active.member.roles.cache.set("role-1", active.guild.roles.cache.get("role-1")!);
    await saveRoleSnapshot(snapshot(2, "active-member", "pending"));
    outage = true;
    await enforceBlacklistForJoinedMember(active.member as never, setup);
    assert.deepEqual(active.removed, [["role-1"]], "approved pending enforcement is store-backed");
    assert.equal((await findRoleSnapshot("recovery-guild", 2))?.status, "active");

    // Simulate a process/disk failure after Trello accepted the move but
    // before its durable marker can be saved. Retrying the exact card is safe
    // and does not produce a member notification while they are absent.
    const markerRetry = snapshot(4, "departed-again", "revocation_pending");
    await saveRoleSnapshot(markerRetry);
    outage = false;
    interruptMarkerWrite = true;
    await assert.rejects(() =>
      processApprovedRevocation(absent.guild as never, setup, markerRetry),
    );
    await unlink(dataDirectory);
    await rename(interruptedDirectory, dataDirectory);
    assert.equal((await findRoleSnapshot("recovery-guild", 4))?.revocationCardMovedAt, undefined);
    const markerRecovery = await processApprovedRevocation(
      absent.guild as never,
      setup,
      markerRetry,
    );
    assert.equal(markerRecovery.moved, true);
    assert.equal(absent.directMessages.length, 1);

    // A non-atomic in-memory update would expose this snapshot despite the
    // filesystem failure. The store instead retains its last committed view.
    const displacedDirectory = `${dataDirectory}-displaced`;
    await rename(dataDirectory, displacedDirectory);
    await writeFile(dataDirectory, "not a directory");
    await assert.rejects(() => saveRoleSnapshot(snapshot(3, "never-saved", "pending")));
    assert.equal(await findRoleSnapshot("recovery-guild", 3), undefined);
    await unlink(dataDirectory);
    await rename(displacedDirectory, dataDirectory);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
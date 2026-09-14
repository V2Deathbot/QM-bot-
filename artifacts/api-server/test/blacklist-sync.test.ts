import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ChannelType, Collection } from "discord.js";

const dataDirectory = await mkdtemp(
  path.join(os.tmpdir(), "blacklist-sync-tests-"),
);
process.env.ROLE_SNAPSHOT_FILE = path.join(
  dataDirectory,
  "role-snapshots.json",
);
process.env.TRELLO_API_KEY = "sync-test-key";
process.env.TRELLO_TOKEN = "sync-test-token";
process.env.TRELLO_BOARD_ID = "sync-test-board";
process.env.TRELLO_LIST_APPEALABLE = "Appealable Blacklist";
process.env.TRELLO_LIST_CONDITIONAL = "Conditional Blacklist";
process.env.TRELLO_LIST_PERMANENT = "Permanent Blacklist";
process.env.TRELLO_LIST_REVOKED = "Revoked Blacklist";
process.env.TRELLO_LIST_GROUP = "Group Blacklist";

const {
  enforceBlacklistForJoinedMember,
  getBlacklistSyncStatus,
  synchronizeBlacklists,
} = await import("../src/bot/blacklist-sync.ts");
const { findActiveSnapshot } = await import("../src/bot/role-store.ts");

const listIds = {
  appealable: "list-appealable",
  conditional: "list-conditional",
  permanent: "list-permanent",
  revoked: "list-revoked",
  group: "list-group",
} as const;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestPath(input: RequestInfo | URL): string {
  return new URL(input.toString()).pathname;
}

function configuredLists() {
  return [
    { id: listIds.appealable, name: "Appealable Blacklist" },
    { id: listIds.conditional, name: "Conditional Blacklist" },
    { id: listIds.permanent, name: "Permanent Blacklist" },
    { id: listIds.revoked, name: "Revoked Blacklist" },
    { id: listIds.group, name: "Group Blacklist" },
  ];
}

function trelloCard(input: {
  id: string;
  userId: number;
  username: string;
  listId: string;
  updatedAt: string;
}) {
  return {
    id: input.id,
    name: `${input.username} | ${input.userId}`,
    desc: "- policy",
    idList: input.listId,
    idLabels: [],
    url: `https://trello.test/${input.id}`,
    dateLastActivity: input.updatedAt,
    closed: false,
  };
}

function createDiscordFixture(guildId: string, initialMembers: boolean) {
  const auditMessages: unknown[] = [];
  const removed: string[][] = [];
  const restored: string[][] = [];
  const directMessages: string[] = [];
  const guildRoles = new Collection([
    [
      "role-1",
      { id: "role-1", name: "Verified", managed: false, position: 1 },
    ],
    [
      "role-2",
      { id: "role-2", name: "Member", managed: false, position: 2 },
    ],
  ]);
  const memberRoles = new Collection(guildRoles);
  const members = new Collection<string, unknown>();
  const guild = {
    id: guildId,
    client: { user: { id: "sync-bot" } },
    roles: { cache: guildRoles },
    channels: {
      fetch: async () => ({
        type: ChannelType.GuildText,
        permissionsFor: () => ({ has: () => true }),
        send: async (payload: unknown) => {
          auditMessages.push(payload);
        },
      }),
    },
    members: {
      me: {
        id: "sync-bot",
        roles: { highest: { position: 10 } },
      },
      fetch: async () => members,
    },
  };
  const member = {
    id: `${guildId}-member`,
    guild,
    user: { username: "Builder", globalName: null },
    nickname: null,
    roles: {
      cache: memberRoles,
      remove: async (roleIds: string[]) => {
        removed.push([...roleIds]);
        for (const roleId of roleIds) memberRoles.delete(roleId);
      },
      add: async (roleIds: string[]) => {
        restored.push([...roleIds]);
        for (const roleId of roleIds) {
          const role = guildRoles.get(roleId);
          if (role) memberRoles.set(roleId, role);
        }
      },
    },
    send: async ({ content }: { content: string }) => {
      directMessages.push(content);
    },
  };
  if (initialMembers) members.set(member.id, member);

  return {
    guild,
    member,
    members,
    auditMessages,
    removed,
    restored,
    directMessages,
  };
}

function setupFor(guildId: string) {
  return {
    guildId,
    moderatorRoleId: "moderator-role",
    auditChannelId: "12345678901234567",
    updatedBy: "owner",
    updatedAt: new Date().toISOString(),
  };
}

test("enforces manual cards, restores manual revocations, and remains idempotent", async () => {
  const fixture = createDiscordFixture("sync-guild", true);
  let cards = [
    trelloCard({
      id: "active-card",
      userId: 42,
      username: "Builder",
      listId: listIds.permanent,
      updatedAt: "2026-09-14T01:00:00.000Z",
    }),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const pathname = requestPath(input);
    if (pathname.endsWith("/lists")) return jsonResponse(configuredLists());
    if (pathname.endsWith("/cards")) return jsonResponse(cards);
    if (pathname === "/v1/users/42") {
      return jsonResponse({ id: 42, name: "Builder", displayName: "Builder" });
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };

  try {
    await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "startup",
    );
    const activeSnapshot = await findActiveSnapshot(fixture.guild.id, 42);
    assert.deepEqual(activeSnapshot?.roleIds, ["role-1", "role-2"]);
    assert.equal(activeSnapshot?.cardId, "active-card");
    assert.equal(activeSnapshot?.source, "sync");
    assert.deepEqual(fixture.removed, [["role-1", "role-2"]]);
    assert.equal(fixture.directMessages.length, 1);
    const auditCountAfterFirstScan = fixture.auditMessages.length;

    await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "manual",
    );
    assert.deepEqual(fixture.removed, [["role-1", "role-2"]]);
    assert.equal(fixture.directMessages.length, 1);
    assert.equal(fixture.auditMessages.length, auditCountAfterFirstScan);

    cards = [
      trelloCard({
        id: "revoked-card",
        userId: 42,
        username: "Builder",
        listId: listIds.revoked,
        updatedAt: "2026-09-14T02:00:00.000Z",
      }),
    ];
    await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "manual",
    );
    assert.deepEqual(fixture.restored, [["role-1", "role-2"]]);
    assert.equal(fixture.directMessages.length, 2);
    assert.equal(await findActiveSnapshot(fixture.guild.id, 42), undefined);
    const persisted = JSON.parse(
      await readFile(process.env.ROLE_SNAPSHOT_FILE!, "utf8"),
    ) as {
      snapshots: Array<{ status: string; cardId?: string }>;
    };
    assert.equal(persisted.snapshots[0]?.status, "revoked");
    assert.equal(persisted.snapshots[0]?.cardId, "revoked-card");
    const auditCountAfterRevoke = fixture.auditMessages.length;

    await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "manual",
    );
    assert.deepEqual(fixture.restored, [["role-1", "role-2"]]);
    assert.equal(fixture.directMessages.length, 2);
    assert.equal(fixture.auditMessages.length, auditCountAfterRevoke);
    assert.equal(getBlacklistSyncStatus().state, "successful");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("enforces the cached Trello index when a matching member joins", async () => {
  const fixture = createDiscordFixture("join-guild", false);
  const cards = [
    trelloCard({
      id: "join-card",
      userId: 77,
      username: "Builder",
      listId: listIds.appealable,
      updatedAt: "2026-09-14T03:00:00.000Z",
    }),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const pathname = requestPath(input);
    if (pathname.endsWith("/lists")) return jsonResponse(configuredLists());
    if (pathname.endsWith("/cards")) return jsonResponse(cards);
    if (pathname === "/v1/users/77") {
      return jsonResponse({ id: 77, name: "Builder", displayName: "Builder" });
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };

  try {
    await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "startup",
    );
    assert.equal(fixture.removed.length, 0);

    fixture.members.set(fixture.member.id, fixture.member);
    await enforceBlacklistForJoinedMember(
      fixture.member as never,
      setupFor(fixture.guild.id),
    );
    await enforceBlacklistForJoinedMember(
      fixture.member as never,
      setupFor(fixture.guild.id),
    );

    assert.deepEqual(fixture.removed, [["role-1", "role-2"]]);
    assert.equal(fixture.directMessages.length, 1);
    assert.deepEqual(
      (await findActiveSnapshot(fixture.guild.id, 77))?.roleIds,
      ["role-1", "role-2"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports unavailable Roblox cards and Trello scans without leaking credentials", async () => {
  const fixture = createDiscordFixture("provider-failure-guild", false);
  let trelloUnavailable = false;
  const cards = [
    trelloCard({
      id: "unknown-user-card",
      userId: 999,
      username: "Unknown",
      listId: listIds.conditional,
      updatedAt: "2026-09-14T04:00:00.000Z",
    }),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const pathname = requestPath(input);
    if (pathname.endsWith("/lists")) {
      return trelloUnavailable
        ? jsonResponse(
            { error: `key=${process.env.TRELLO_API_KEY}` },
            503,
          )
        : jsonResponse(configuredLists());
    }
    if (pathname.endsWith("/cards")) return jsonResponse(cards);
    if (pathname === "/v1/users/999") {
      return jsonResponse({ error: "unknown Roblox user" }, 404);
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };

  try {
    const unknownUserResult = await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "startup",
    );
    assert.equal(unknownUserResult.state, "successful");
    assert.equal(unknownUserResult.counts.issues, 1);
    assert.equal(unknownUserResult.counts.indexed, 0);

    trelloUnavailable = true;
    const failedResult = await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "manual",
    );
    assert.equal(failedResult.state, "failed");
    assert.match(failedResult.error ?? "", /next scheduled scan/i);
    const serialized = JSON.stringify({
      status: failedResult,
      audits: fixture.auditMessages,
    });
    assert.doesNotMatch(
      serialized,
      /sync-test-key|sync-test-token|unknown Roblox user/,
    );

    const auditCount = fixture.auditMessages.length;
    await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "manual",
    );
    assert.equal(fixture.auditMessages.length, auditCount);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("persists a pending revocation while the member is absent and restores on rejoin", async () => {
  const fixture = createDiscordFixture("absent-revoke-guild", true);
  let cards = [
    trelloCard({
      id: "absent-active",
      userId: 88,
      username: "Builder",
      listId: listIds.permanent,
      updatedAt: "2026-09-14T05:00:00.000Z",
    }),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const pathname = requestPath(input);
    if (pathname.endsWith("/lists")) return jsonResponse(configuredLists());
    if (pathname.endsWith("/cards")) return jsonResponse(cards);
    if (pathname === "/v1/users/88") {
      return jsonResponse({ id: 88, name: "Builder", displayName: "Builder" });
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };

  try {
    await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "startup",
    );
    fixture.members.clear();
    cards = [
      trelloCard({
        id: "absent-revoked",
        userId: 88,
        username: "Builder",
        listId: listIds.revoked,
        updatedAt: "2026-09-14T06:00:00.000Z",
      }),
    ];
    await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "manual",
    );

    const pendingFile = JSON.parse(
      await readFile(process.env.ROLE_SNAPSHOT_FILE!, "utf8"),
    ) as {
      snapshots: Array<{
        guildId: string;
        robloxUserId: number;
        status: string;
      }>;
    };
    assert.equal(
      pendingFile.snapshots.find(
        (snapshot) =>
          snapshot.guildId === fixture.guild.id &&
          snapshot.robloxUserId === 88,
      )?.status,
      "revocation_pending",
    );
    assert.equal(fixture.restored.length, 0);

    fixture.members.set(fixture.member.id, fixture.member);
    await enforceBlacklistForJoinedMember(
      fixture.member as never,
      setupFor(fixture.guild.id),
    );
    assert.deepEqual(fixture.restored, [["role-1", "role-2"]]);
    assert.equal(await findActiveSnapshot(fixture.guild.id, 88), undefined);
    assert.equal(fixture.directMessages.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("skips one Discord member matching multiple active Roblox identities", async () => {
  const fixture = createDiscordFixture("identity-conflict-guild", true);
  fixture.member.nickname = "OtherBuilder";
  const cards = [
    trelloCard({
      id: "identity-one",
      userId: 91,
      username: "Builder",
      listId: listIds.appealable,
      updatedAt: "2026-09-14T07:00:00.000Z",
    }),
    trelloCard({
      id: "identity-two",
      userId: 92,
      username: "OtherBuilder",
      listId: listIds.conditional,
      updatedAt: "2026-09-14T07:00:00.000Z",
    }),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const pathname = requestPath(input);
    if (pathname.endsWith("/lists")) return jsonResponse(configuredLists());
    if (pathname.endsWith("/cards")) return jsonResponse(cards);
    if (pathname === "/v1/users/91") {
      return jsonResponse({ id: 91, name: "Builder", displayName: "Builder" });
    }
    if (pathname === "/v1/users/92") {
      return jsonResponse({
        id: 92,
        name: "OtherBuilder",
        displayName: "OtherBuilder",
      });
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };

  try {
    const result = await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "startup",
    );
    assert.equal(result.counts.skipped, 2);
    assert.equal(result.counts.enforced, 0);
    assert.equal(fixture.removed.length, 0);
    assert.equal(await findActiveSnapshot(fixture.guild.id, 91), undefined);
    assert.equal(await findActiveSnapshot(fixture.guild.id, 92), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not regress a completed join restoration to pending during a concurrent scan", async () => {
  const fixture = createDiscordFixture("revoke-race-guild", true);
  let cards = [
    trelloCard({
      id: "race-active",
      userId: 94,
      username: "Builder",
      listId: listIds.permanent,
      updatedAt: "2026-09-14T08:00:00.000Z",
    }),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const pathname = requestPath(input);
    if (pathname.endsWith("/lists")) return jsonResponse(configuredLists());
    if (pathname.endsWith("/cards")) return jsonResponse(cards);
    if (pathname === "/v1/users/94") {
      return jsonResponse({ id: 94, name: "Builder", displayName: "Builder" });
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };

  try {
    await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "startup",
    );
    cards = [
      trelloCard({
        id: "race-revoked",
        userId: 94,
        username: "Builder",
        listId: listIds.revoked,
        updatedAt: "2026-09-14T09:00:00.000Z",
      }),
    ];
    fixture.members.clear();

    let signalMemberFetch!: () => void;
    const memberFetchStarted = new Promise<void>((resolve) => {
      signalMemberFetch = resolve;
    });
    let releaseMemberFetch!: () => void;
    const memberFetchGate = new Promise<void>((resolve) => {
      releaseMemberFetch = resolve;
    });
    fixture.guild.members.fetch = async () => {
      signalMemberFetch();
      await memberFetchGate;
      return fixture.members;
    };

    const originalAdd = fixture.member.roles.add;
    let signalRestore!: () => void;
    const restoreStarted = new Promise<void>((resolve) => {
      signalRestore = resolve;
    });
    let releaseRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    fixture.member.roles.add = async (roleIds: string[]) => {
      signalRestore();
      await restoreGate;
      await originalAdd(roleIds);
    };

    const scan = synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "manual",
    );
    await memberFetchStarted;
    const join = enforceBlacklistForJoinedMember(
      fixture.member as never,
      setupFor(fixture.guild.id),
    );
    await restoreStarted;
    releaseMemberFetch();
    releaseRestore();
    await Promise.all([scan, join]);

    assert.equal(await findActiveSnapshot(fixture.guild.id, 94), undefined);
    const persisted = JSON.parse(
      await readFile(process.env.ROLE_SNAPSHOT_FILE!, "utf8"),
    ) as {
      snapshots: Array<{
        guildId: string;
        robloxUserId: number;
        status: string;
      }>;
    };
    assert.equal(
      persisted.snapshots.find(
        (snapshot) =>
          snapshot.guildId === fixture.guild.id &&
          snapshot.robloxUserId === 94,
      )?.status,
      "revoked",
    );
    assert.equal(fixture.restored.length, 1);
    assert.equal(fixture.directMessages.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports action failures as a partial scan and failed completion audit", async () => {
  const fixture = createDiscordFixture("partial-sync-guild", true);
  fixture.member.roles.remove = async () => {
    throw new Error("Discord role update rejected");
  };
  const cards = [
    trelloCard({
      id: "partial-active",
      userId: 95,
      username: "Builder",
      listId: listIds.appealable,
      updatedAt: "2026-09-14T10:00:00.000Z",
    }),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const pathname = requestPath(input);
    if (pathname.endsWith("/lists")) return jsonResponse(configuredLists());
    if (pathname.endsWith("/cards")) return jsonResponse(cards);
    if (pathname === "/v1/users/95") {
      return jsonResponse({ id: 95, name: "Builder", displayName: "Builder" });
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };

  try {
    const result = await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "startup",
    );
    assert.equal(result.state, "partial");
    assert.equal(result.counts.failures, 1);
    assert.match(result.error ?? "", /will be retried/i);
    assert.match(
      JSON.stringify(fixture.auditMessages),
      /synchronization completed with failures/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps revocation pending until temporarily unmanageable roles can be restored", async () => {
  const fixture = createDiscordFixture("restore-retry-guild", true);
  let cards = [
    trelloCard({
      id: "restore-active",
      userId: 96,
      username: "Builder",
      listId: listIds.permanent,
      updatedAt: "2026-09-14T11:00:00.000Z",
    }),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const pathname = requestPath(input);
    if (pathname.endsWith("/lists")) return jsonResponse(configuredLists());
    if (pathname.endsWith("/cards")) return jsonResponse(cards);
    if (pathname === "/v1/users/96") {
      return jsonResponse({ id: 96, name: "Builder", displayName: "Builder" });
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };

  try {
    await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "startup",
    );
    cards = [
      trelloCard({
        id: "restore-revoked",
        userId: 96,
        username: "Builder",
        listId: listIds.revoked,
        updatedAt: "2026-09-14T12:00:00.000Z",
      }),
    ];
    fixture.guild.members.me.roles.highest.position = 1;
    const pending = await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "manual",
    );
    assert.equal(pending.state, "partial");
    assert.equal(pending.counts.failures, 1);
    assert.equal(fixture.restored.length, 0);
    assert.equal(fixture.directMessages.length, 1);

    fixture.guild.members.me.roles.highest.position = 10;
    const recovered = await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "poll",
    );
    assert.equal(recovered.state, "successful");
    assert.deepEqual(fixture.restored, [["role-1", "role-2"]]);
    assert.equal(fixture.directMessages.length, 2);
    assert.equal(await findActiveSnapshot(fixture.guild.id, 96), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retains last-known join enforcement during a transient Roblox outage", async () => {
  const fixture = createDiscordFixture("roblox-outage-guild", false);
  let robloxUnavailable = false;
  const cards = [
    trelloCard({
      id: "outage-active",
      userId: 97,
      username: "Builder",
      listId: listIds.conditional,
      updatedAt: "2026-09-14T13:00:00.000Z",
    }),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const pathname = requestPath(input);
    if (pathname.endsWith("/lists")) return jsonResponse(configuredLists());
    if (pathname.endsWith("/cards")) return jsonResponse(cards);
    if (pathname === "/v1/users/97") {
      return robloxUnavailable
        ? jsonResponse({ error: "temporary provider failure" }, 503)
        : jsonResponse({ id: 97, name: "Builder", displayName: "Builder" });
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };

  try {
    await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "startup",
    );
    robloxUnavailable = true;
    const outage = await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "poll",
    );
    assert.equal(outage.state, "partial");
    assert.equal(outage.counts.providerFailures, 1);
    assert.equal(outage.counts.indexed, 1);

    await enforceBlacklistForJoinedMember(
      fixture.member as never,
      setupFor(fixture.guild.id),
    );
    assert.deepEqual(fixture.removed, [["role-1", "role-2"]]);
    assert.equal(fixture.directMessages.length, 1);

    robloxUnavailable = false;
    const recovered = await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "poll",
    );
    assert.equal(recovered.state, "successful");
    assert.equal(recovered.counts.providerFailures, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("never reassigns an absent account's role snapshot to a username match", async () => {
  const fixture = createDiscordFixture("snapshot-owner-guild", true);
  let cards = [
    trelloCard({
      id: "owner-active",
      userId: 98,
      username: "Builder",
      listId: listIds.permanent,
      updatedAt: "2026-09-14T14:00:00.000Z",
    }),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const pathname = requestPath(input);
    if (pathname.endsWith("/lists")) return jsonResponse(configuredLists());
    if (pathname.endsWith("/cards")) return jsonResponse(cards);
    if (pathname === "/v1/users/98") {
      return jsonResponse({ id: 98, name: "Builder", displayName: "Builder" });
    }
    throw new Error(`Unexpected request: ${pathname}`);
  };

  try {
    await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "startup",
    );
    const replacementRemoved: string[][] = [];
    const replacementRestored: string[][] = [];
    const replacementRoleCache = new Collection(fixture.guild.roles.cache);
    const replacement = {
      id: "different-discord-account",
      guild: fixture.guild,
      user: { username: "Builder", globalName: null },
      nickname: null,
      roles: {
        cache: replacementRoleCache,
        remove: async (roleIds: string[]) => {
          replacementRemoved.push([...roleIds]);
        },
        add: async (roleIds: string[]) => {
          replacementRestored.push([...roleIds]);
        },
      },
      send: async () => undefined,
    };
    fixture.members.clear();
    fixture.members.set(replacement.id, replacement);

    const activeResult = await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "poll",
    );
    assert.equal(activeResult.counts.skipped, 1);
    assert.deepEqual(replacementRemoved, []);

    cards = [
      trelloCard({
        id: "owner-revoked",
        userId: 98,
        username: "Builder",
        listId: listIds.revoked,
        updatedAt: "2026-09-14T15:00:00.000Z",
      }),
    ];
    await synchronizeBlacklists(
      fixture.guild as never,
      setupFor(fixture.guild.id),
      "poll",
    );
    assert.deepEqual(replacementRestored, []);

    const persisted = JSON.parse(
      await readFile(process.env.ROLE_SNAPSHOT_FILE!, "utf8"),
    ) as {
      snapshots: Array<{
        guildId: string;
        robloxUserId: number;
        discordUserId: string;
        status: string;
      }>;
    };
    const snapshot = persisted.snapshots.find(
      (candidate) =>
        candidate.guildId === fixture.guild.id &&
        candidate.robloxUserId === 98,
    );
    assert.equal(snapshot?.discordUserId, fixture.member.id);
    assert.equal(snapshot?.status, "revocation_pending");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
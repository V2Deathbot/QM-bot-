import type { Guild, GuildMember } from "discord.js";
import { logger } from "../lib/logger";
import {
  fetchBlacklistIndex,
  type BlacklistIndex,
  type BlacklistIssue,
  type IndexedBlacklistCard,
} from "./blacklist-index";
import { sendAuditEvent } from "./audit";
import {
  findActiveSnapshot,
  findRoleSnapshot,
  listRestorableSnapshots,
  saveRoleSnapshot,
  type RoleSnapshot,
} from "./role-store";
import {
  describeRoles,
  getRemovableRoleIds,
  removeAssignableRoles,
  restoreAssignableRoles,
} from "./role-actions";
import type { GuildSetup } from "./setup-store";

export type BlacklistSyncTrigger = "startup" | "manual" | "poll" | "setup";
export type BlacklistSyncState =
  | "idle"
  | "running"
  | "successful"
  | "partial"
  | "failed";

export interface BlacklistSyncCounts {
  indexed: number;
  enforced: number;
  restored: number;
  skipped: number;
  issues: number;
  failures: number;
  providerFailures: number;
}

export interface BlacklistSyncStatus {
  state: BlacklistSyncState;
  trigger: BlacklistSyncTrigger | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  nextSyncAt: string | null;
  error: string | null;
  counts: BlacklistSyncCounts;
  recentIssues: Array<{
    code: string;
    cardId: string;
    message: string;
  }>;
}

interface ReconcileCounts {
  enforced: number;
  restored: number;
  skipped: number;
  failures: number;
}

const emptyCounts = (): BlacklistSyncCounts => ({
  indexed: 0,
  enforced: 0,
  restored: 0,
  skipped: 0,
  issues: 0,
  failures: 0,
  providerFailures: 0,
});

const status: BlacklistSyncStatus = {
  state: "idle",
  trigger: null,
  lastStartedAt: null,
  lastCompletedAt: null,
  nextSyncAt: null,
  error: null,
  counts: emptyCounts(),
  recentIssues: [],
};

let cachedIndex: BlacklistIndex = {
  active: [],
  revoked: [],
  issues: [],
  providerFailures: [],
};
let syncAttempt: Promise<BlacklistSyncStatus> | null = null;
const memberLocks = new Map<string, Promise<void>>();
let reportedIssueKeys = new Set<string>();
let reportedRuntimeIssueKeys = new Set<string>();
let currentRuntimeIssueKeys: Set<string> | null = null;
let syncFailureReported = false;

function systemActorId(guild: Guild, setup: GuildSetup): string {
  return guild.client.user?.id ?? guild.members.me?.id ?? setup.updatedBy;
}

async function audit(
  guild: Guild,
  setup: GuildSetup,
  action: string,
  fields: Array<{ name: string; value: string }> = [],
  failed = false,
  target?: string,
): Promise<void> {
  try {
    await sendAuditEvent(guild, setup, {
      action,
      status: failed ? "failed" : "success",
      actorId: systemActorId(guild, setup),
      target,
      fields,
    });
  } catch {
    logger.warn(
      { guildId: guild.id, action },
      "Could not send blacklist synchronization audit",
    );
  }
}

async function auditRuntimeIssueOnce(
  key: string,
  guild: Guild,
  setup: GuildSetup,
  action: string,
  fields: Array<{ name: string; value: string }>,
  target?: string,
): Promise<void> {
  currentRuntimeIssueKeys?.add(key);
  if (reportedRuntimeIssueKeys.has(key)) return;
  if (!currentRuntimeIssueKeys) reportedRuntimeIssueKeys.add(key);
  await audit(guild, setup, action, fields, true, target);
}

function issueKey(issue: BlacklistIssue): string {
  return `${issue.cardId}:${issue.code}:${issue.robloxId ?? ""}`;
}

function memberNames(member: GuildMember): Set<string> {
  return new Set(
    [member.user.username, member.user.globalName, member.nickname]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.trim().toLowerCase()),
  );
}

function lockMember<T>(
  guildId: string,
  discordUserId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${guildId}:${discordUserId}`;
  const previous = memberLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  memberLocks.set(key, settled);
  void settled.finally(() => {
    if (memberLocks.get(key) === settled) memberLocks.delete(key);
  });
  return current;
}

async function notifyMember(
  member: GuildMember,
  content: string,
): Promise<void> {
  try {
    await member.send({ content, embeds: [] });
  } catch {
    // Closed DMs must not stop role enforcement or trigger repeated attempts.
  }
}

async function enforceActiveCard(
  guild: Guild,
  member: GuildMember,
  setup: GuildSetup,
  entry: IndexedBlacklistCard,
): Promise<ReconcileCounts> {
  return lockMember(guild.id, member.id, async () => {
    const previous = await findRoleSnapshot(guild.id, entry.robloxId);
    const existing =
      previous &&
      ["pending", "active", "revocation_pending"].includes(previous.status)
        ? previous
        : undefined;
    const removable = getRemovableRoleIds(member);
    const now = new Date().toISOString();
    let snapshot: RoleSnapshot =
      existing ??
      {
        key: `${guild.id}:${entry.robloxId}`,
        guildId: guild.id,
        discordUserId: member.id,
        robloxUserId: entry.robloxId,
        robloxUsername: entry.username,
        roleIds: [...removable.changed],
        cardId: entry.card.id,
        cardUrl: entry.card.url,
        cardUpdatedAt: entry.card.dateLastActivity,
        source: "sync",
        status: "pending",
        createdAt: now,
      };
    const cardChanged =
      snapshot.cardId !== entry.card.id ||
      snapshot.cardUpdatedAt !== entry.card.dateLastActivity ||
      snapshot.robloxUsername !== entry.username ||
      snapshot.discordUserId !== member.id;

    if (!existing || cardChanged || snapshot.status !== "active") {
      snapshot = {
        ...snapshot,
        discordUserId: member.id,
        robloxUsername: entry.username,
        cardId: entry.card.id,
        cardUrl: entry.card.url,
        cardUpdatedAt: entry.card.dateLastActivity,
      };
      await saveRoleSnapshot(snapshot);
    }

    const removed = await removeAssignableRoles(
      member,
      "Synchronized Roblox blacklist",
    );
    const firstEnforcement = !existing;
    const wasPending = snapshot.status === "pending";
    const shouldNotify =
      (snapshot.source === "sync" || wasPending) &&
      !snapshot.blacklistNotificationAttemptedAt;
    snapshot = {
      ...snapshot,
      status: "active",
      ...(shouldNotify
        ? { blacklistNotificationAttemptedAt: new Date().toISOString() }
        : {}),
    };
    await saveRoleSnapshot(snapshot);
    if (shouldNotify) {
      await notifyMember(
        member,
        `You have been blacklisted from this server. Trello record: ${entry.card.url}`,
      );
    }

    if (
      firstEnforcement ||
      cardChanged ||
      removed.changed.length > 0
    ) {
      await audit(
        guild,
        setup,
        "Synchronized blacklist enforced",
        [
          {
            name: "Roblox user",
            value: `${entry.username} | ${entry.robloxId}`,
          },
          {
            name: "Roles removed",
            value: describeRoles(member, removed.changed),
          },
          {
            name: "Roles skipped",
            value: describeRoles(member, removed.skipped),
          },
          {
            name: "Trello card",
            value: `${entry.card.id}\n${entry.card.url}`,
          },
        ],
        false,
        `<@${member.id}> (${member.id})`,
      );
    }

    return {
      enforced:
        firstEnforcement || cardChanged || removed.changed.length > 0 ? 1 : 0,
      restored: 0,
      skipped: removed.skipped.length > 0 ? 1 : 0,
      failures: 0,
    };
  });
}

async function restoreRevokedCard(
  guild: Guild,
  member: GuildMember,
  setup: GuildSetup,
  entry: IndexedBlacklistCard,
): Promise<ReconcileCounts> {
  return lockMember(guild.id, member.id, async () => {
    const current = await findRoleSnapshot(guild.id, entry.robloxId);
    if (
      !current ||
      !["pending", "active", "revocation_pending"].includes(current.status)
    ) {
      return { enforced: 0, restored: 0, skipped: 0, failures: 0 };
    }

    const restored = await restoreAssignableRoles(
      member,
      current.roleIds,
      "Synchronized Roblox blacklist revoked",
    );
    if (restored.skipped.length > 0) {
      await saveRoleSnapshot({
        ...current,
        robloxUsername: entry.username,
        cardId: entry.card.id,
        cardUrl: entry.card.url,
        cardUpdatedAt: entry.card.dateLastActivity,
        status: "revocation_pending",
      });
      await auditRuntimeIssueOnce(
        `restoration-skipped:${guild.id}:${entry.robloxId}:${restored.skipped.join(",")}`,
        guild,
        setup,
        "Synchronized blacklist restoration pending",
        [
          {
            name: "Roblox user",
            value: `${entry.username} | ${entry.robloxId}`,
          },
          {
            name: "Roles restored",
            value: describeRoles(member, restored.changed),
          },
          {
            name: "Roles still pending",
            value: describeRoles(member, restored.skipped),
          },
          {
            name: "Result",
            value:
              "The next scheduled scan will retry roles that are currently unavailable or above the bot.",
          },
        ],
        `<@${member.id}> (${member.id})`,
      );
      return {
        enforced: 0,
        restored: 0,
        skipped: 1,
        failures: 1,
      };
    }
    const revokedSnapshot: RoleSnapshot = {
      ...current,
      robloxUsername: entry.username,
      cardId: entry.card.id,
      cardUrl: entry.card.url,
      cardUpdatedAt: entry.card.dateLastActivity,
      status: "revoked",
      revokedAt: new Date().toISOString(),
      revocationNotificationAttemptedAt: new Date().toISOString(),
    };
    await saveRoleSnapshot(revokedSnapshot);
    await notifyMember(
      member,
      `Your blacklist has been revoked. Trello record: ${entry.card.url}`,
    );
    await audit(
      guild,
      setup,
      "Synchronized blacklist revocation applied",
      [
        {
          name: "Roblox user",
          value: `${entry.username} | ${entry.robloxId}`,
        },
        {
          name: "Roles restored",
          value: describeRoles(member, restored.changed),
        },
        {
          name: "Roles skipped",
          value: describeRoles(member, restored.skipped),
        },
        {
          name: "Trello card",
          value: `${entry.card.id}\n${entry.card.url}`,
        },
      ],
      false,
      `<@${member.id}> (${member.id})`,
    );

    return {
      enforced: 0,
      restored: 1,
      skipped: restored.skipped.length > 0 ? 1 : 0,
      failures: 0,
    };
  });
}

async function markRevocationPending(
  guild: Guild,
  snapshot: RoleSnapshot,
  entry: IndexedBlacklistCard,
): Promise<boolean> {
  return lockMember(guild.id, snapshot.discordUserId, async () => {
    const current = await findRoleSnapshot(guild.id, entry.robloxId);
    if (
      !current ||
      !["pending", "active", "revocation_pending"].includes(current.status)
    ) {
      return false;
    }
    if (
      current.status === "revocation_pending" &&
      current.cardId === entry.card.id &&
      current.cardUpdatedAt === entry.card.dateLastActivity
    ) {
      return false;
    }
    await saveRoleSnapshot({
      ...current,
      robloxUsername: entry.username,
      cardId: entry.card.id,
      cardUrl: entry.card.url,
      cardUpdatedAt: entry.card.dateLastActivity,
      status: "revocation_pending",
    });
    return true;
  });
}

async function findMemberForActiveCard(
  guild: Guild,
  entry: IndexedBlacklistCard,
  members: GuildMember[],
): Promise<
  {
    member?: GuildMember;
    ambiguousMembers: GuildMember[];
    snapshotOwnerId?: string;
  }
> {
  const existing = await findRoleSnapshot(guild.id, entry.robloxId);
  if (
    existing &&
    ["pending", "active", "revocation_pending"].includes(existing.status)
  ) {
    const recorded = members.find(
      (member) => member.id === existing.discordUserId,
    );
    if (recorded) return { member: recorded, ambiguousMembers: [] };
    return {
      ambiguousMembers: [],
      snapshotOwnerId: existing.discordUserId,
    };
  }

  const username = entry.username.trim().toLowerCase();
  const matches = members.filter((member) => memberNames(member).has(username));
  if (matches.length === 1) {
    return { member: matches[0]!, ambiguousMembers: [] };
  }
  return { ambiguousMembers: matches.length > 1 ? matches : [] };
}

async function reconcileIndex(
  guild: Guild,
  setup: GuildSetup,
  index: BlacklistIndex,
): Promise<ReconcileCounts> {
  const fetchedMembers = await guild.members.fetch();
  const members = [...fetchedMembers.values()];
  const totals: ReconcileCounts = {
    enforced: 0,
    restored: 0,
    skipped: 0,
    failures: 0,
  };

  const assignments: Array<{
    entry: IndexedBlacklistCard;
    member: GuildMember;
  }> = [];
  const protectedActiveMemberIds = new Set<string>();
  for (const entry of index.active) {
    const match = await findMemberForActiveCard(guild, entry, members);
    if (!match.member) {
      if (match.snapshotOwnerId) {
        totals.skipped += 1;
        await auditRuntimeIssueOnce(
          `snapshot-owner-absent:${guild.id}:${entry.robloxId}:${match.snapshotOwnerId}`,
          guild,
          setup,
          "Synchronized blacklist identity reassignment skipped",
          [
            {
              name: "Reason",
              value:
                "The saved Discord account is absent. The snapshot will not be reassigned by username to another account.",
            },
            {
              name: "Roblox user",
              value: `${entry.username} | ${entry.robloxId}`,
            },
            {
              name: "Saved Discord account",
              value: match.snapshotOwnerId,
            },
          ],
        );
      } else if (match.ambiguousMembers.length > 0) {
        for (const member of match.ambiguousMembers) {
          protectedActiveMemberIds.add(member.id);
        }
        totals.skipped += 1;
        await auditRuntimeIssueOnce(
          `ambiguous:${guild.id}:${entry.robloxId}:${entry.card.id}`,
          guild,
          setup,
          "Synchronized blacklist skipped",
          [
            {
              name: "Reason",
              value: "More than one Discord member matches the Roblox username.",
            },
            {
              name: "Roblox user",
              value: `${entry.username} | ${entry.robloxId}`,
            },
            { name: "Trello card", value: entry.card.id },
          ],
        );
      }
      continue;
    }
    assignments.push({ entry, member: match.member });
  }

  const assignmentsByMember = new Map<
    string,
    Array<{ entry: IndexedBlacklistCard; member: GuildMember }>
  >();
  for (const assignment of assignments) {
    const current = assignmentsByMember.get(assignment.member.id) ?? [];
    current.push(assignment);
    assignmentsByMember.set(assignment.member.id, current);
  }
  const activeMemberIds = new Set(assignmentsByMember.keys());
  for (const memberId of protectedActiveMemberIds) {
    activeMemberIds.add(memberId);
  }

  for (const [memberId, memberAssignments] of assignmentsByMember) {
    if (memberAssignments.length > 1) {
      totals.skipped += memberAssignments.length;
      await auditRuntimeIssueOnce(
        `many-identities:${guild.id}:${memberId}`,
        guild,
        setup,
        "Synchronized blacklist skipped",
        [
          {
            name: "Reason",
            value:
              "One Discord member matched more than one active Roblox blacklist identity.",
          },
          {
            name: "Roblox users",
            value: memberAssignments
              .map(
                ({ entry }) => `${entry.username} | ${entry.robloxId}`,
              )
              .join(", "),
          },
        ],
        `<@${memberId}> (${memberId})`,
      );
      continue;
    }

    const { entry, member } = memberAssignments[0]!;
    try {
      const result = await enforceActiveCard(guild, member, setup, entry);
      totals.enforced += result.enforced;
      totals.skipped += result.skipped;
      totals.failures += result.failures;
    } catch {
      totals.skipped += 1;
      totals.failures += 1;
      await auditRuntimeIssueOnce(
        `enforcement:${guild.id}:${entry.robloxId}:${entry.card.id}`,
        guild,
        setup,
        "Synchronized blacklist enforcement failed",
        [
          {
            name: "Roblox user",
            value: `${entry.username} | ${entry.robloxId}`,
          },
          { name: "Trello card", value: entry.card.id },
        ],
        `<@${member.id}> (${member.id})`,
      );
    }
  }

  const revokedById = new Map(
    index.revoked.map((entry) => [entry.robloxId, entry]),
  );
  for (const snapshot of await listRestorableSnapshots(guild.id)) {
    const entry = revokedById.get(snapshot.robloxUserId);
    if (!entry) continue;
    if (activeMemberIds.has(snapshot.discordUserId)) {
      totals.skipped += 1;
      await auditRuntimeIssueOnce(
        `restore-active-conflict:${guild.id}:${snapshot.discordUserId}:${entry.robloxId}`,
        guild,
        setup,
        "Synchronized blacklist restoration skipped",
        [
          {
            name: "Reason",
            value:
              "The Discord member still matches another active blacklist identity.",
          },
          {
            name: "Revoked Roblox user",
            value: `${entry.username} | ${entry.robloxId}`,
          },
        ],
        `<@${snapshot.discordUserId}> (${snapshot.discordUserId})`,
      );
      continue;
    }
    const member = members.find(
      (candidate) => candidate.id === snapshot.discordUserId,
    );
    if (!member) {
      if (await markRevocationPending(guild, snapshot, entry)) {
        await audit(
          guild,
          setup,
          "Synchronized blacklist revocation pending",
          [
            {
              name: "Reason",
              value:
                "The recorded Discord member is not currently in the server. Roles will be restored if they return.",
            },
            {
              name: "Roblox user",
              value: `${entry.username} | ${entry.robloxId}`,
            },
          ],
          false,
          `<@${snapshot.discordUserId}> (${snapshot.discordUserId})`,
        );
      }
      continue;
    }

    try {
      const result = await restoreRevokedCard(guild, member, setup, entry);
      totals.restored += result.restored;
      totals.skipped += result.skipped;
      totals.failures += result.failures;
    } catch {
      totals.skipped += 1;
      totals.failures += 1;
      await auditRuntimeIssueOnce(
        `restoration:${guild.id}:${entry.robloxId}:${entry.card.id}`,
        guild,
        setup,
        "Synchronized blacklist restoration failed",
        [
          {
            name: "Roblox user",
            value: `${entry.username} | ${entry.robloxId}`,
          },
          { name: "Trello card", value: entry.card.id },
        ],
        `<@${member.id}> (${member.id})`,
      );
    }
  }

  return totals;
}

async function reportIndexIssues(
  guild: Guild,
  setup: GuildSetup,
  issues: BlacklistIssue[],
): Promise<number> {
  const nextKeys = new Set(issues.map(issueKey));
  let reported = 0;
  for (const issue of issues.slice(0, 10)) {
    const key = issueKey(issue);
    if (reportedIssueKeys.has(key)) continue;
    reported += 1;
    await audit(
      guild,
      setup,
      "Trello blacklist card skipped",
      [
        { name: "Reason", value: issue.message },
        { name: "Card", value: `${issue.cardName} (${issue.cardId})` },
      ],
      issue.code !== "renamed_username",
    );
  }
  reportedIssueKeys = nextKeys;
  return reported;
}

export function setNextBlacklistSyncAt(value: string | null): void {
  status.nextSyncAt = value;
}

export function getBlacklistSyncStatus(): BlacklistSyncStatus {
  return {
    ...status,
    counts: { ...status.counts },
    recentIssues: status.recentIssues.map((issue) => ({ ...issue })),
  };
}

export async function reportBlacklistSyncUnavailable(
  guild: Guild,
  setup: GuildSetup,
  trigger: BlacklistSyncTrigger,
): Promise<void> {
  const now = new Date().toISOString();
  status.state = "failed";
  status.trigger = trigger;
  status.lastStartedAt = now;
  status.lastCompletedAt = now;
  status.error =
    "Blacklist synchronization is waiting for Trello readiness. The next scheduled scan will retry.";
  status.counts = emptyCounts();
  status.recentIssues = [];
  if (!syncFailureReported) {
    syncFailureReported = true;
    await audit(
      guild,
      setup,
      "Trello blacklist synchronization unavailable",
      [
        {
          name: "Result",
          value:
            "Trello readiness could not be verified. No blacklist state was changed.",
        },
      ],
      true,
    );
  }
}

export async function synchronizeBlacklists(
  guild: Guild,
  setup: GuildSetup,
  trigger: BlacklistSyncTrigger,
): Promise<BlacklistSyncStatus> {
  if (syncAttempt) return syncAttempt;

  syncAttempt = (async () => {
    status.state = "running";
    status.trigger = trigger;
    status.lastStartedAt = new Date().toISOString();
    status.error = null;
    status.counts = emptyCounts();
    status.recentIssues = [];

    try {
      const fallbackUsersById = new Map(
        [...cachedIndex.active, ...cachedIndex.revoked].map((entry) => [
          entry.robloxId,
          {
            id: entry.robloxId,
            name: entry.username,
            displayName: entry.username,
          },
        ]),
      );
      const index = await fetchBlacklistIndex({ fallbackUsersById });
      cachedIndex = index;
      currentRuntimeIssueKeys = new Set<string>();
      const reconciled = await reconcileIndex(guild, setup, index);
      reportedRuntimeIssueKeys = currentRuntimeIssueKeys;
      currentRuntimeIssueKeys = null;
      const newlyReportedIssues = await reportIndexIssues(
        guild,
        setup,
        index.issues,
      );
      const totalFailures =
        reconciled.failures + index.providerFailures.length;
      status.state = totalFailures > 0 ? "partial" : "successful";
      syncFailureReported = false;
      status.lastCompletedAt = new Date().toISOString();
      status.error =
        totalFailures > 0
          ? `${totalFailures} blacklist action or provider lookup(s) failed and will be retried by the next scheduled scan.`
          : null;
      status.counts = {
        indexed: index.active.length + index.revoked.length,
        enforced: reconciled.enforced,
        restored: reconciled.restored,
        skipped: reconciled.skipped,
        issues: index.issues.length,
        failures: reconciled.failures,
        providerFailures: index.providerFailures.length,
      };
      status.recentIssues = index.issues.slice(0, 10).map((issue) => ({
        code: issue.code,
        cardId: issue.cardId,
        message: issue.message,
      }));

      if (
        trigger === "startup" ||
        trigger === "setup" ||
        reconciled.enforced > 0 ||
        reconciled.restored > 0 ||
        reconciled.failures > 0 ||
        index.providerFailures.length > 0 ||
        newlyReportedIssues > 0
      ) {
        await audit(
          guild,
          setup,
          totalFailures > 0
            ? "Trello blacklist synchronization completed with failures"
            : "Trello blacklist synchronization completed",
          [
            { name: "Indexed", value: String(status.counts.indexed) },
            { name: "Enforced", value: String(status.counts.enforced) },
            { name: "Restored", value: String(status.counts.restored) },
            { name: "Skipped", value: String(status.counts.skipped) },
            { name: "Card issues", value: String(status.counts.issues) },
            { name: "Action failures", value: String(status.counts.failures) },
            {
              name: "Provider lookup failures",
              value: String(status.counts.providerFailures),
            },
          ],
          totalFailures > 0,
        );
      }
      return getBlacklistSyncStatus();
    } catch {
      currentRuntimeIssueKeys = null;
      status.state = "failed";
      status.lastCompletedAt = new Date().toISOString();
      status.error =
        "Blacklist synchronization failed. Check Trello, Roblox, Discord permissions, and the bot logs; the next scheduled scan will retry.";
      if (!syncFailureReported) {
        syncFailureReported = true;
        await audit(
          guild,
          setup,
          "Trello blacklist synchronization failed",
          [
            {
              name: "Result",
              value:
                "No complete synchronization result was produced. The next scheduled scan will retry.",
            },
          ],
          true,
        );
      }
      return getBlacklistSyncStatus();
    }
  })();

  try {
    return await syncAttempt;
  } finally {
    syncAttempt = null;
  }
}

export async function enforceBlacklistForJoinedMember(
  member: GuildMember,
  setup: GuildSetup,
): Promise<void> {
  const matched = new Map<number, IndexedBlacklistCard>();
  const names = memberNames(member);
  for (const entry of cachedIndex.active) {
    const snapshot = await findRoleSnapshot(member.guild.id, entry.robloxId);
    if (
      (snapshot &&
        ["pending", "active", "revocation_pending"].includes(snapshot.status) &&
        snapshot.discordUserId === member.id) ||
      names.has(entry.username.trim().toLowerCase())
    ) {
      matched.set(entry.robloxId, entry);
    }
  }

  if (matched.size > 1) {
      await auditRuntimeIssueOnce(
        `join-ambiguous:${member.guild.id}:${member.id}`,
        member.guild,
        setup,
        "Joined member blacklist check skipped",
        [
          {
            name: "Reason",
            value: "The member matched more than one synchronized Roblox identity.",
          },
        ],
        `<@${member.id}> (${member.id})`,
      );
    return;
  }

  if (matched.size === 1) {
    await enforceActiveCard(
      member.guild,
      member,
      setup,
      [...matched.values()][0]!,
    );
    return;
  }

  const pendingRevocations: Array<{
    entry: IndexedBlacklistCard;
    snapshot: RoleSnapshot;
  }> = [];
  for (const entry of cachedIndex.revoked) {
    const snapshot = await findRoleSnapshot(member.guild.id, entry.robloxId);
    if (
      snapshot &&
      ["pending", "active", "revocation_pending"].includes(snapshot.status) &&
      snapshot.discordUserId === member.id
    ) {
      pendingRevocations.push({ entry, snapshot });
    }
  }
  if (pendingRevocations.length === 1) {
    await restoreRevokedCard(
      member.guild,
      member,
      setup,
      pendingRevocations[0]!.entry,
    );
  }
}
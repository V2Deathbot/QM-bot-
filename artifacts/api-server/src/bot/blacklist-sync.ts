import type { Collection, Guild, GuildMember } from "discord.js";
import { fetchGuildMembers, GuildMemberListError } from "./guild-members";
import { logger } from "../lib/logger";
import {
  fetchBlacklistIndex,
  type BlacklistIndex,
  type BlacklistIssue,
  type IndexedBlacklistCard,
} from "./blacklist-index";
import { sendAuditEvent } from "./audit";
import {
  findRoleSnapshot,
  listApprovedSnapshotsForMember,
  listActiveSnapshots,
  listRestorableSnapshots,
  listSnapshotsForMember,
  saveRoleSnapshot,
  withGuildBlacklistLifecycleLock,
  withMemberRoleLock,
  type RoleSnapshot,
} from "./role-store";
import {
  describeRoles,
  getRemovableRoleIds,
  removeAssignableRoles,
  restoreAssignableRoles,
} from "./role-actions";
import { trelloMappingsFor, type GuildSetup } from "./setup-store";
import {
  createBlacklistCard,
  findBlacklistCardsByRobloxId,
  reactivateBlacklistCardById,
  revokeBlacklistCardById,
} from "./trello";
import {
  noMentions,
  presentationEmbed,
  safePresentationText,
} from "./presentation";

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

async function savedRoleIdsForMember(
  guildId: string,
  discordUserId: string,
): Promise<string[]> {
  const snapshots = await listSnapshotsForMember(guildId, discordUserId);
  return [...new Set(
    snapshots
      .filter((snapshot) => ["pending", "active", "revocation_pending"].includes(snapshot.status))
      .flatMap((snapshot) => snapshot.roleIds),
  )];
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

async function notifyMember(
  member: GuildMember,
  content: string,
): Promise<void> {
  try {
    const revoked = /revoked/i.test(content);
    await member.send({
      content: "",
      embeds: [presentationEmbed(
        revoked ? "Blacklist Revoked" : "Blacklist Notice",
        safePresentationText(content, 4_096),
        revoked ? "success" : "warning",
        typeof member.guild.client?.user?.displayAvatarURL === "function"
          ? member.guild.client.user.displayAvatarURL()
          : undefined,
      )],
      allowedMentions: noMentions,
    });
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
  return withMemberRoleLock(guild.id, member.id, async () => {
    const previous = await findRoleSnapshot(guild.id, entry.robloxId);
    const existing =
      previous &&
      ["pending", "active", "revocation_pending"].includes(previous.status)
        ? previous
        : undefined;
    // Trello is observed for desync/manual-edit alerts, but only a persistent
    // bot-approved command snapshot is allowed to change Discord state.
    if (!existing || existing.source !== "command") {
      if (setup.monitoring?.manualChangeDetection !== false) await auditRuntimeIssueOnce(
        `manual-trello:${guild.id}:${entry.robloxId}:${entry.card.id}`,
        guild, setup, "Manual Trello blacklist change detected",
        [
          { name: "Roblox user", value: `${entry.username} | ${entry.robloxId}` },
          { name: "Result", value: "Monitoring-only: no Discord roles were changed because this record was not bot-approved." },
          { name: "Trello card", value: `${entry.card.id}\n${entry.card.url}` },
        ],
      );
      return { enforced: 0, restored: 0, skipped: 1, failures: 0 };
    }
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
        source: "command",
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
    if (setup.blacklistRoleId) {
      const blacklistRole = await guild.roles.fetch(setup.blacklistRoleId);
      const botMember = guild.members.me;
      if (blacklistRole && !blacklistRole.managed && botMember && blacklistRole.position < botMember.roles.highest.position && !member.roles.cache.has(blacklistRole.id)) {
        await member.roles.add(blacklistRole, "Synchronized approved Roblox blacklist");
      }
    }
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

/** Enforce only command-approved records; Trello availability is irrelevant. */
async function enforceApprovedSnapshot(
  guild: Guild,
  member: GuildMember,
  setup: GuildSetup,
  snapshot: RoleSnapshot,
  options: { recoverCard?: boolean } = {},
): Promise<ReconcileCounts> {
  if (snapshot.discordUserId !== member.id || snapshot.source !== "command") {
    return { enforced: 0, restored: 0, skipped: 1, failures: 0 };
  }
  return withMemberRoleLock(guild.id, member.id, async () => {
    let current = await findRoleSnapshot(guild.id, snapshot.robloxUserId);
    if (
      !current ||
      current.discordUserId !== member.id ||
      !["pending", "active", "revocation_pending"].includes(current.status)
    ) {
      return { enforced: 0, restored: 0, skipped: 1, failures: 0 };
    }
    let recoveryFailure = false;
    if (options.recoverCard !== false && current.status === "pending" && !current.cardId) {
      try {
        const card = await recoverPendingSnapshotCard(current, setup);
        current = {
          ...current,
          cardId: card.id,
          cardUrl: card.url,
          cardUpdatedAt: card.dateLastActivity,
        };
        await saveRoleSnapshot(current);
      } catch {
        // Provider failure or an ambiguous exact-ID match must never unwind an
        // already approved restriction. Keep pending and retry recovery later.
        recoveryFailure = true;
      }
    }
    const removed = await removeAssignableRoles(member, "Approved Roblox blacklist");
    if (setup.blacklistRoleId && !member.roles.cache.has(setup.blacklistRoleId)) {
      const role = await guild.roles.fetch(setup.blacklistRoleId);
      const bot = guild.members.me;
      if (!role || role.managed || !bot || role.position >= bot.roles.highest.position) {
        return { enforced: 0, restored: 0, skipped: 1, failures: 1 };
      }
      await member.roles.add(role, "Approved Roblox blacklist");
    }
    // A revocation_pending snapshot remains pending while its exact Trello
    // move is retried; never accidentally promote it back to active.
    if (current.status === "pending" && current.cardId) {
      await saveRoleSnapshot({ ...current, status: "active" });
    }
    return {
      enforced: removed.changed.length ? 1 : 0,
      restored: 0,
      skipped: removed.skipped.length ? 1 : 0,
      failures: recoveryFailure ? 1 : 0,
    };
  });
}

/**
 * Reconcile a cardless command-approved snapshot exactly once per attempt.
 * Every candidate is keyed by the numeric Roblox identity; multiple open
 * records are ambiguous and must remain pending rather than being attached
 * to an arbitrary card. A successful create/reuse is persisted by the caller
 * before the pending snapshot can become active.
 */
async function recoverPendingSnapshotCard(
  snapshot: RoleSnapshot,
  setup: GuildSetup,
): Promise<Awaited<ReturnType<typeof createBlacklistCard>>> {
  const mappings = trelloMappingsFor(setup);
  const candidates = await findBlacklistCardsByRobloxId(snapshot.robloxUserId, mappings);
  if (candidates.length > 1) {
    throw new Error(
      `Multiple Trello cards match approved Roblox account ${snapshot.robloxUserId}; recovery is ambiguous.`,
    );
  }
  const candidate = candidates[0];
  if (candidate) {
    if (candidate.listType === "revoked") {
      return reactivateBlacklistCardById(candidate.id, {
        robloxId: snapshot.robloxUserId,
        robloxUsername: snapshot.robloxUsername,
        type: snapshot.blacklistType as Parameters<typeof reactivateBlacklistCardById>[1]["type"],
        reason: snapshot.blacklistReason ?? "Approved blacklist recovery",
        mappings,
      });
    }
    return candidate;
  }
  if (
    snapshot.blacklistType !== "permanent" &&
    snapshot.blacklistType !== "appealable" &&
    snapshot.blacklistType !== "conditional"
  ) {
    throw new Error("Approved blacklist snapshot has no recoverable blacklist type.");
  }
  return createBlacklistCard({
    name: `${snapshot.robloxUsername} | ${snapshot.robloxUserId}`,
    type: snapshot.blacklistType,
    reason: snapshot.blacklistReason ?? "Approved blacklist recovery",
    mappings,
  });
}

async function restoreRevokedCard(
  guild: Guild,
  member: GuildMember,
  setup: GuildSetup,
  entry: IndexedBlacklistCard,
): Promise<ReconcileCounts> {
  return withMemberRoleLock(guild.id, member.id, async () => {
    const current = await findRoleSnapshot(guild.id, entry.robloxId);
    if (
      !current ||
      !["pending", "active", "revocation_pending"].includes(current.status) ||
      current.source !== "command"
    ) {
      return { enforced: 0, restored: 0, skipped: 0, failures: 0 };
    }
    const otherRestrictions = (await listApprovedSnapshotsForMember(
      guild.id,
      current.discordUserId,
    )).filter((candidate) => candidate.key !== current.key);
    if (otherRestrictions.length > 0) {
      // This card is revoked, but another approved restriction still owns the
      // account's restrictive role sink. Leave both roles and the sink role
      // untouched until the last restriction is revoked.
      return { enforced: 0, restored: 0, skipped: 1, failures: 0 };
    }

    const restored = await restoreAssignableRoles(
      member,
      await savedRoleIdsForMember(guild.id, current.discordUserId),
      "Synchronized Roblox blacklist revoked",
    );
    if (setup.blacklistRoleId && member.roles.cache.has(setup.blacklistRoleId)) {
      await member.roles.remove(setup.blacklistRoleId, "Synchronized approved Roblox blacklist revoked");
    }
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

/** Complete an already-approved revocation. This never consults Trello. */
export async function finishApprovedRevocation(
  guild: Guild,
  member: GuildMember,
  setup: GuildSetup,
  snapshot: RoleSnapshot,
): Promise<{ completed: boolean; restored: string[]; skipped: string[] }> {
  if (
    snapshot.source !== "command" ||
    snapshot.status !== "revocation_pending" ||
    !snapshot.revocationCardMovedAt ||
    snapshot.discordUserId !== member.id
  ) {
    return { completed: false, restored: [], skipped: [] };
  }
  return withMemberRoleLock(guild.id, member.id, async () => {
    const current = await findRoleSnapshot(guild.id, snapshot.robloxUserId);
    if (!current || current.discordUserId !== member.id || current.status !== "revocation_pending" || !current.revocationCardMovedAt) {
      return { completed: false, restored: [], skipped: [] };
    }
    const otherRestrictions = (await listApprovedSnapshotsForMember(
      guild.id,
      current.discordUserId,
    )).filter((candidate) => candidate.key !== current.key);
    if (otherRestrictions.length > 0) {
      await saveRoleSnapshot({
        ...current,
        status: "revoked",
        revokedAt: new Date().toISOString(),
      });
      return { completed: true, restored: [], skipped: [] };
    }
    const restored = await restoreAssignableRoles(
      member,
      await savedRoleIdsForMember(guild.id, current.discordUserId),
      "Approved Roblox blacklist revoked",
    );
    const blacklistRoleId = setup.blacklistRoleId;
    let blacklistRemoved = !blacklistRoleId || !member.roles.cache.has(blacklistRoleId);
    if (!blacklistRemoved) {
      try {
        await member.roles.remove(blacklistRoleId!, "Approved Roblox blacklist revoked");
        blacklistRemoved = true;
      } catch {
        blacklistRemoved = false;
      }
    }
    if (restored.skipped.length || !blacklistRemoved) {
      return { completed: false, restored: restored.changed, skipped: [
        ...restored.skipped,
        ...(!blacklistRemoved ? [blacklistRoleId!] : []),
      ] };
    }
    const completedSnapshot: RoleSnapshot = {
      ...current,
      status: "revoked",
      revokedAt: new Date().toISOString(),
      // Mark before the best-effort DM so retrying Discord role work never
      // produces duplicate member notifications.
      revocationNotificationAttemptedAt:
        current.revocationNotificationAttemptedAt ?? new Date().toISOString(),
    };
    await saveRoleSnapshot(completedSnapshot);
    if (!current.revocationNotificationAttemptedAt) {
      await notifyMember(
        member,
        `Your blacklist has been revoked. Trello record: ${current.cardUrl ?? "the approved Trello record"}`,
      );
    }
    return { completed: true, restored: restored.changed, skipped: [] };
  });
}

/**
 * Recover an approved revocation from its durable exact-card snapshot.
 * Discord restoration is deliberately impossible until the Trello movement
 * and labels have completed and the movement marker has been persisted.
 */
export async function processApprovedRevocation(
  guild: Guild,
  setup: GuildSetup,
  snapshot: RoleSnapshot,
  member?: GuildMember,
): Promise<{ moved: boolean; completed: boolean; restored: string[]; skipped: string[] }> {
  if (
    snapshot.source !== "command" ||
    snapshot.status !== "revocation_pending" ||
    !snapshot.cardId
  ) {
    return { moved: false, completed: false, restored: [], skipped: [] };
  }
  let current = await findRoleSnapshot(guild.id, snapshot.robloxUserId);
  if (
    !current ||
    current.source !== "command" ||
    current.status !== "revocation_pending" ||
    current.cardId !== snapshot.cardId
  ) {
    return { moved: false, completed: false, restored: [], skipped: [] };
  }
  if (!current.revocationCardMovedAt) {
    const revokedCard = await revokeBlacklistCardById(
      current.cardId,
      trelloMappingsFor(setup),
    );
    current = {
      ...current,
      cardId: revokedCard.id,
      cardUrl: revokedCard.url,
      cardUpdatedAt: revokedCard.dateLastActivity,
      revocationCardMovedAt: new Date().toISOString(),
    };
    // If this persistence fails, the next retry repeats the idempotent exact
    // card operation and never restores Discord roles in the meantime.
    await saveRoleSnapshot(current);
  }
  const otherRestrictions = (await listApprovedSnapshotsForMember(
    guild.id,
    current.discordUserId,
  )).filter((candidate) => candidate.key !== current.key);
  if (otherRestrictions.length > 0) {
    await saveRoleSnapshot({
      ...current,
      status: "revoked",
      revokedAt: new Date().toISOString(),
    });
    return { moved: true, completed: true, restored: [], skipped: [] };
  }
  if (!member || member.id !== current.discordUserId) {
    return { moved: true, completed: false, restored: [], skipped: [] };
  }
  const finished = await finishApprovedRevocation(guild, member, setup, current);
  return { moved: true, ...finished };
}

async function markRevocationPending(
  guild: Guild,
  snapshot: RoleSnapshot,
  entry: IndexedBlacklistCard,
): Promise<boolean> {
  return withMemberRoleLock(guild.id, snapshot.discordUserId, async () => {
    const current = await findRoleSnapshot(guild.id, entry.robloxId);
    if (
      !current ||
      !["pending", "active", "revocation_pending"].includes(current.status) ||
      current.source !== "command"
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
  fetchedMembers: Collection<string, GuildMember>,
): Promise<ReconcileCounts> {
  const members = [...fetchedMembers.values()];
  const totals: ReconcileCounts = {
    enforced: 0,
    restored: 0,
    skipped: 0,
    failures: 0,
  };
  // Command-approved snapshots are excluded from card matching below: their
  // durable enforcement is performed before every scan, even if Trello fails.
  const approvedByRobloxId = new Set<number>();
  for (const snapshot of await listActiveSnapshots(guild.id)) {
    if (snapshot.source !== "command" || snapshot.status === "revocation_pending") continue;
    approvedByRobloxId.add(snapshot.robloxUserId);
  }

  const assignments: Array<{
    entry: IndexedBlacklistCard;
    member: GuildMember;
  }> = [];
  for (const entry of index.active) {
    if (approvedByRobloxId.has(entry.robloxId)) continue;
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
    // A Trello move is not proof that an administrator approved a Discord
    // restoration. /revoke_blacklist performs approved restoration itself;
    // polling only records this desynchronization for administrator review.
    totals.skipped += 1;
    if (
      setup.monitoring?.manualChangeDetection !== false &&
      setup.monitoring?.desyncDetection !== false
    ) await auditRuntimeIssueOnce(
      `manual-trello-revocation:${guild.id}:${snapshot.robloxUserId}:${entry.card.id}`,
      guild,
      setup,
      "Manual Trello blacklist revocation detected",
      [
        { name: "Roblox user", value: `${entry.username} | ${entry.robloxId}` },
        { name: "Result", value: "Monitoring-only: Discord roles were not restored. Use /revoke_blacklist to approve restoration." },
        { name: "Trello card", value: `${entry.card.id}\n${entry.card.url}` },
      ],
      `<@${snapshot.discordUserId}> (${snapshot.discordUserId})`,
    );
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

async function synchronizeBlacklistsUnlocked(
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

    let stage = "Discord member list";
    try {
      const members = await fetchGuildMembers(guild);
      stage = "approved-record recovery";
      const approved = await enforceApprovedSnapshots(guild, setup, members);
      stage = "Trello index";
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
      const index = await fetchBlacklistIndex({
        fallbackUsersById,
        mappings: trelloMappingsFor(setup),
      });
      cachedIndex = index;
      currentRuntimeIssueKeys = new Set<string>();
      stage = "Discord reconciliation";
      const reconciled = await reconcileIndex(guild, setup, index, members);
      reconciled.enforced += approved.enforced;
      reconciled.skipped += approved.skipped;
      reconciled.failures += approved.failures;
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
    } catch (error) {
      const failure = error as {
        name?: unknown;
        code?: unknown;
        stack?: unknown;
        status?: unknown;
        method?: unknown;
        path?: unknown;
        message?: unknown;
      };
      const memberListFailure = error instanceof GuildMemberListError;
      logger.error({
        stage,
        errorType: typeof failure?.name === "string" ? failure.name : "Unknown",
        code: typeof failure?.code === "number" ? failure.code : undefined,
        discordStatus: memberListFailure ? failure.status : undefined,
        discordMethod: memberListFailure ? failure.method : undefined,
        discordPath: memberListFailure ? failure.path : undefined,
        frames: typeof failure?.stack === "string"
          ? failure.stack.split("\n").filter((line) => /^\s+at .*\/src\/bot\//.test(line)).slice(0, 4)
          : [],
      }, "Blacklist synchronization step failed");
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
              value: memberListFailure && typeof failure.message === "string"
                ? failure.message
                : "No complete synchronization result was produced. The next scheduled scan will retry.",
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

export function synchronizeBlacklists(
  guild: Guild,
  setup: GuildSetup,
  trigger: BlacklistSyncTrigger,
): Promise<BlacklistSyncStatus> {
  return withGuildBlacklistLifecycleLock(guild.id, () =>
    synchronizeBlacklistsUnlocked(guild, setup, trigger),
  );
}

async function enforceApprovedSnapshots(
  guild: Guild,
  setup: GuildSetup,
  members: Collection<string, GuildMember>,
): Promise<ReconcileCounts> {
  const totals: ReconcileCounts = { enforced: 0, restored: 0, skipped: 0, failures: 0 };
  for (const snapshot of await listRestorableSnapshots(guild.id)) {
    if (snapshot.source !== "command") continue;
    const member = members.get(snapshot.discordUserId);
    let approved = snapshot;
    let cardRecoveryAttempted = false;
    if (snapshot.status === "pending" && !snapshot.cardId) {
      cardRecoveryAttempted = true;
      try {
        const card = await recoverPendingSnapshotCard(snapshot, setup);
        approved = {
          ...snapshot,
          cardId: card.id,
          cardUrl: card.url,
          cardUpdatedAt: card.dateLastActivity,
          status: "active",
        };
        await saveRoleSnapshot(approved);
      } catch {
        // A nonmember remains durably approved and will be retried on the
        // next scheduled scan. A member is still enforced below, but no
        // member-role path may issue a second provider recovery attempt.
        totals.failures += 1;
      }
    }
    if (snapshot.status === "revocation_pending") {
      try {
        // Until Trello completion is durably marked, this is still an active
        // restriction and must be reapplied if roles were added meanwhile.
        if (!snapshot.revocationCardMovedAt && member) {
          const enforced = await enforceApprovedSnapshot(guild, member, setup, snapshot);
          totals.enforced += enforced.enforced;
          totals.skipped += enforced.skipped;
          totals.failures += enforced.failures;
        }
        const result = await processApprovedRevocation(guild, setup, snapshot, member);
        totals.restored += result.completed ? 1 : 0;
        totals.skipped += result.completed ? 0 : 1;
        totals.failures += result.completed || result.moved ? 0 : 1;
      } catch {
        // A failed exact-card move leaves the restrictive snapshot intact.
        totals.skipped += 1;
        totals.failures += 1;
      }
      continue;
    }
    if (!member) {
      if (approved === snapshot) totals.skipped += 1;
      continue;
    }
    const result = await enforceApprovedSnapshot(
      guild,
      member,
      setup,
      approved,
      { recoverCard: !cardRecoveryAttempted },
    );
    totals.enforced += result.enforced;
    totals.skipped += result.skipped;
    totals.failures += result.failures;
  }
  return totals;
}

export async function enforceBlacklistForJoinedMember(
  member: GuildMember,
  setup: GuildSetup,
): Promise<void> {
  return withGuildBlacklistLifecycleLock(member.guild.id, async () => {
  const matched = new Map<number, IndexedBlacklistCard>();
  const approved = await listApprovedSnapshotsForMember(member.guild.id, member.id);
  if (approved.length) {
    for (const snapshot of approved) {
      if (snapshot.status === "revocation_pending") {
        if (!snapshot.revocationCardMovedAt) {
          await enforceApprovedSnapshot(member.guild, member, setup, snapshot);
        }
        await processApprovedRevocation(member.guild, setup, snapshot, member);
      } else {
        await enforceApprovedSnapshot(member.guild, member, setup, snapshot);
      }
    }
    return;
  }
  const names = memberNames(member);
  for (const entry of cachedIndex.active) {
    const snapshot = await findRoleSnapshot(member.guild.id, entry.robloxId);
    // Existing snapshots are immutable account bindings. A username match is
    // never allowed to move their role sink to a joining account.
    if (snapshot) {
      if (snapshot.discordUserId === member.id) matched.set(entry.robloxId, entry);
    } else if (names.has(entry.username.trim().toLowerCase())) {
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
    if (
      setup.monitoring?.manualChangeDetection !== false &&
      setup.monitoring?.desyncDetection !== false
    ) await auditRuntimeIssueOnce(
      `manual-trello-revocation:${member.guild.id}:${pendingRevocations[0]!.entry.robloxId}:${pendingRevocations[0]!.entry.card.id}`,
      member.guild,
      setup,
      "Manual Trello blacklist revocation detected",
      [{ name: "Result", value: "Monitoring-only: Discord roles were not restored. Use /revoke_blacklist to approve restoration." }],
      `<@${member.id}> (${member.id})`,
    );
  }
  });
}
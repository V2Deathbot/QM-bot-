import {
  fetchBlacklistCards,
  type TrelloBlacklistCard,
  type TrelloBlacklistListType,
  type TrelloCard,
} from "./trello";
import {
  findRobloxUserById,
  RobloxUserNotFoundError,
  type RobloxUser,
} from "./roblox";

export type BlacklistClassification = "active" | "revoked";
export type BlacklistIssueCode =
  | "malformed_title"
  | "invalid_roblox_id"
  | "unknown_roblox_id"
  | "roblox_unavailable"
  | "renamed_username";

export interface ParsedBlacklistTitle {
  username: string;
  robloxId: number;
}

export interface BlacklistIssue {
  code: BlacklistIssueCode;
  cardId: string;
  cardName: string;
  robloxId?: number;
  message: string;
}

export interface IndexedBlacklistCard {
  card: TrelloBlacklistCard;
  robloxId: number;
  /** The current Roblox username, not necessarily the title's username. */
  username: string;
  titleUsername: string;
  listType: TrelloBlacklistListType;
  classification: BlacklistClassification;
}

export interface BlacklistIndex {
  active: IndexedBlacklistCard[];
  revoked: IndexedBlacklistCard[];
  issues: BlacklistIssue[];
  providerFailures: number[];
}

export type RobloxIdLookup = (id: number) => Promise<RobloxUser>;

export interface BlacklistIndexCard extends TrelloCard {
  /**
   * Cards returned by fetchBlacklistCards always have this property.  It is
   * optional here so indexing remains convenient with fixtures and callers
   * that provide their own list-to-type mapping.
   */
  listType?: TrelloBlacklistListType;
}

export interface BuildBlacklistIndexOptions {
  lookupById?: RobloxIdLookup;
  listTypeById?: ReadonlyMap<string, TrelloBlacklistListType>;
  fallbackUsersById?: ReadonlyMap<number, RobloxUser>;
}

export type BuildBlacklistIndexArgument =
  | BuildBlacklistIndexOptions
  | RobloxIdLookup;

function issue(
  card: BlacklistIndexCard,
  code: BlacklistIssueCode,
  message: string,
  robloxId?: number,
): BlacklistIssue {
  return {
    code,
    cardId: card.id,
    cardName: card.name,
    ...(robloxId === undefined ? {} : { robloxId }),
    message,
  };
}

/**
 * Parse the only card title format understood by the index.  Deliberately
 * keep the parser independent of Roblox so malformed cards can be reported
 * without making a network request.
 */
export function parseBlacklistTitle(
  title: string,
):
  | { ok: true; value: ParsedBlacklistTitle }
  | {
      ok: false;
      code: "malformed_title" | "invalid_roblox_id";
      message: string;
    } {
  const pieces = title.split("|");
  if (pieces.length !== 2) {
    return {
      ok: false,
      code: "malformed_title",
      message: "Blacklist card title must be in Username | RobloxUserId form.",
    };
  }

  const username = pieces[0]!.trim();
  const rawId = pieces[1]!.trim();
  if (!username || !rawId) {
    return {
      ok: false,
      code: "malformed_title",
      message: "Blacklist card title must include a username and Roblox user id.",
    };
  }

  if (!/^\d+$/.test(rawId)) {
    return {
      ok: false,
      code: "invalid_roblox_id",
      message: "The Roblox user id must be a positive safe integer.",
    };
  }

  const robloxId = Number(rawId);
  if (!Number.isSafeInteger(robloxId) || robloxId <= 0) {
    return {
      ok: false,
      code: "invalid_roblox_id",
      message: "The Roblox user id must be a positive safe integer.",
    };
  }

  return { ok: true, value: { username, robloxId } };
}

export const parseBlacklistCardTitle = parseBlacklistTitle;

function classificationFor(
  listType: TrelloBlacklistListType | undefined,
): BlacklistClassification | undefined {
  if (listType === "revoked") return "revoked";
  if (
    listType === "appealable" ||
    listType === "conditional" ||
    listType === "permanent"
  ) {
    return "active";
  }
  return undefined;
}

function activityTimestamp(card: TrelloCard): number {
  const timestamp = Date.parse(card.dateLastActivity);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function compareCards(
  left: IndexedBlacklistCard,
  right: IndexedBlacklistCard,
): number {
  const activityDifference =
    activityTimestamp(left.card) - activityTimestamp(right.card);
  if (activityDifference !== 0) return activityDifference;

  if (left.classification !== right.classification) {
    return left.classification === "revoked" ? 1 : -1;
  }

  // Do not depend on provider order when cards have identical timestamps.
  return left.card.id < right.card.id
    ? 1
    : left.card.id > right.card.id
      ? -1
      : 0;
}

function sortIssues(left: BlacklistIssue, right: BlacklistIssue): number {
  if (left.cardId !== right.cardId) {
    return left.cardId < right.cardId ? -1 : 1;
  }
  if (left.code !== right.code) return left.code < right.code ? -1 : 1;
  return left.message < right.message ? -1 : left.message > right.message ? 1 : 0;
}

/**
 * Build an index from a Trello snapshot.  All Roblox lookups are injected,
 * making this function deterministic and straightforward to test.  A failed
 * lookup only affects cards for that id; all other cards remain enforceable.
 */
export async function buildBlacklistIndex(
  cards: readonly BlacklistIndexCard[],
  optionsOrLookup: BuildBlacklistIndexArgument = {},
): Promise<BlacklistIndex> {
  const options: BuildBlacklistIndexOptions =
    typeof optionsOrLookup === "function"
      ? { lookupById: optionsOrLookup }
      : optionsOrLookup;
  const lookupById = options.lookupById ?? findRobloxUserById;
  const prepared: Array<{
    card: BlacklistIndexCard;
    parsed: ParsedBlacklistTitle;
    classification: BlacklistClassification;
  }> = [];
  const issues: BlacklistIssue[] = [];

  for (const card of cards) {
    if (card.closed) continue;
    const classification = classificationFor(
      card.listType ??
        (options.listTypeById ? options.listTypeById.get(card.idList) : undefined),
    );
    // Provider reads already exclude unrelated lists.  This also makes the
    // pure builder safe when handed a mixed board snapshot.
    if (!classification) continue;

    const parsed = parseBlacklistTitle(card.name);
    if (!parsed.ok) {
      issues.push(issue(card, parsed.code, parsed.message));
      continue;
    }
    prepared.push({ card, parsed: parsed.value, classification });
  }

  const ids = [...new Set(prepared.map(({ parsed }) => parsed.robloxId))].sort(
    (left, right) => left - right,
  );
  const users = new Map<number, RobloxUser>();
  const unknownIds = new Set<number>();
  const providerFailures = new Set<number>();
  for (const id of ids) {
    try {
      const user = await lookupById(id);
      if (
        !user ||
        user.id !== id ||
        !Number.isSafeInteger(user.id) ||
        user.id <= 0 ||
        typeof user.name !== "string" ||
        !user.name.trim()
      ) {
        unknownIds.add(id);
      } else {
        users.set(id, user);
      }
    } catch (error) {
      // Never surface provider errors, response bodies, or request details.
      if (error instanceof RobloxUserNotFoundError) {
        unknownIds.add(id);
      } else {
        providerFailures.add(id);
        const fallback = options.fallbackUsersById?.get(id);
        if (fallback) users.set(id, fallback);
      }
    }
  }

  const candidates = new Map<number, IndexedBlacklistCard>();
  for (const { card, parsed, classification } of prepared) {
    if (unknownIds.has(parsed.robloxId)) {
      issues.push(
        issue(
          card,
          "unknown_roblox_id",
          "The Roblox user id could not be resolved.",
          parsed.robloxId,
        ),
      );
      continue;
    }
    if (providerFailures.has(parsed.robloxId)) {
      issues.push(
        issue(
          card,
          "roblox_unavailable",
          options.fallbackUsersById?.has(parsed.robloxId)
            ? "Roblox lookup was unavailable; the last known username was retained."
            : "Roblox lookup was unavailable; this card will be retried.",
          parsed.robloxId,
        ),
      );
      if (!users.has(parsed.robloxId)) continue;
    }

    const user = users.get(parsed.robloxId)!;
    if (parsed.username !== user.name) {
      issues.push(
        issue(
          card,
          "renamed_username",
          "The card username differs from the current Roblox username.",
          parsed.robloxId,
        ),
      );
    }

    const candidate: IndexedBlacklistCard = {
      card: card as TrelloBlacklistCard,
      robloxId: parsed.robloxId,
      username: user.name,
      titleUsername: parsed.username,
      listType:
        card.listType ??
        (options.listTypeById?.get(card.idList) as TrelloBlacklistListType),
      classification,
    };
    const current = candidates.get(parsed.robloxId);
    if (!current || compareCards(current, candidate) < 0) {
      candidates.set(parsed.robloxId, candidate);
    }
  }

  const active: IndexedBlacklistCard[] = [];
  const revoked: IndexedBlacklistCard[] = [];
  for (const candidate of candidates.values()) {
    (candidate.classification === "revoked" ? revoked : active).push(candidate);
  }
  const stableOrder = (left: IndexedBlacklistCard, right: IndexedBlacklistCard) =>
    left.robloxId - right.robloxId ||
    (left.card.id < right.card.id ? -1 : left.card.id > right.card.id ? 1 : 0);
  active.sort(stableOrder);
  revoked.sort(stableOrder);
  issues.sort(sortIssues);

  return {
    active,
    revoked,
    issues,
    providerFailures: [...providerFailures].sort((left, right) => left - right),
  };
}

export const indexBlacklistCards = buildBlacklistIndex;

/** Fetch the configured Trello lists and then construct their Roblox index. */
export async function fetchBlacklistIndex(
  options: Omit<BuildBlacklistIndexOptions, "listTypeById"> = {},
): Promise<BlacklistIndex> {
  return buildBlacklistIndex(await fetchBlacklistCards(), options);
}

export const getBlacklistIndex = fetchBlacklistIndex;

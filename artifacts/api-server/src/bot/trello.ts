import { config, type BlacklistType } from "./config";
import {
  defaultTrelloMappings,
  type TrelloMappings,
} from "./setup-store";

export interface TrelloList {
  id: string;
  name: string;
}

export type TrelloReadinessStatus =
  | "unknown"
  | "ready"
  | "not_configured"
  | "missing_lists"
  | "unavailable";

export interface TrelloReadiness {
  ready: boolean;
  status: TrelloReadinessStatus;
  checkedAt: string | null;
  missingLists: string[];
  error: string | null;
}

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  idLabels: string[];
  url: string;
  dateLastActivity: string;
  closed: boolean;
}

export type TrelloBlacklistListType = BlacklistType | "revoked";

export interface TrelloBlacklistCard extends TrelloCard {
  listType: TrelloBlacklistListType;
}

interface TrelloLabel {
  id: string;
  name: string;
  color: string | null;
}

const BASE_URL = "https://api.trello.com/1";

let readiness: TrelloReadiness = {
  ready: false,
  status: "unknown",
  checkedAt: null,
  missingLists: [],
  error: null,
};

function requireTrelloConfig(): {
  key: string;
  token: string;
  boardId: string;
} {
  const key = config.trelloApiKey;
  const token = config.trelloToken;
  const boardId = config.trelloBoardId;

  if (!key || !token || !boardId) {
    throw new Error(
      "Trello is not configured. Add TRELLO_API_KEY, TRELLO_TOKEN, and TRELLO_BOARD_ID.",
    );
  }

  return { key, token, boardId };
}

async function request<T>(
  pathname: string,
  init: RequestInit = {},
): Promise<T> {
  const { key, token } = requireTrelloConfig();
  const url = new URL(`${BASE_URL}${pathname}`);
  url.searchParams.set("key", key);
  url.searchParams.set("token", token);

  const response = await fetch(url, init);
  const text = await response.text();
  let payload: unknown = text;

  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    // Keep the text response for a useful error below.
  }

  if (!response.ok) {
    throw new Error(`Trello request failed (${response.status}).`);
  }

  return payload as T;
}

function body(params: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  };
}

async function getOpenLists(): Promise<TrelloList[]> {
  const { boardId } = requireTrelloConfig();
  return request<TrelloList[]>(
    `/boards/${encodeURIComponent(boardId)}/lists?filter=open`,
  );
}

/**
 * Read the user blacklist cards in one snapshot.  The list lookup is kept
 * separate from the card request so a group list can never accidentally be
 * treated as a user blacklist list.
 */
export async function fetchBlacklistCards(
  mappings: TrelloMappings = defaultTrelloMappings(),
): Promise<TrelloBlacklistCard[]> {
  const lists = await getOpenLists();
  const listTypes: Array<[TrelloBlacklistListType, string]> = [
    ["appealable", mappings.lists.appealable],
    ["conditional", mappings.lists.conditional],
    ["permanent", mappings.lists.permanent],
    ["revoked", mappings.lists.revoked],
  ];
  const listTypeById = new Map<string, TrelloBlacklistListType>();
  for (const [type, name] of listTypes) {
    const list = lists.find(
      (candidate) =>
        candidate.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    if (list) listTypeById.set(list.id, type);
  }

  const { boardId } = requireTrelloConfig();
  const cards = await request<TrelloCard[]>(
    `/boards/${encodeURIComponent(boardId)}/cards?filter=all&fields=id,name,desc,idList,idLabels,url,dateLastActivity,closed`,
  );

  return cards
    .filter((card) => !card.closed && listTypeById.has(card.idList))
    .map((card) => ({
      ...card,
      idLabels: [...card.idLabels],
      listType: listTypeById.get(card.idList)!,
    }));
}

// This name is useful to callers that use "get" for provider reads.
export const getBlacklistCards = fetchBlacklistCards;

function configuredListNames(mappings: TrelloMappings): string[] {
  return [...new Set(Object.values(mappings.lists))];
}

function updateReadiness(
  result: Omit<TrelloReadiness, "checkedAt">,
): TrelloReadiness {
  readiness = {
    ...result,
    checkedAt: new Date().toISOString(),
  };
  return getTrelloReadiness();
}

export function getTrelloReadiness(): TrelloReadiness {
  return {
    ...readiness,
    missingLists: [...readiness.missingLists],
  };
}

export async function checkTrelloReadiness(
  mappings: TrelloMappings = defaultTrelloMappings(),
): Promise<TrelloReadiness> {
  try {
    requireTrelloConfig();
  } catch {
    return updateReadiness({
      ready: false,
      status: "not_configured",
      missingLists: [],
      error:
        "Trello is not configured. Add TRELLO_API_KEY, TRELLO_TOKEN, and TRELLO_BOARD_ID.",
    });
  }

  try {
    const lists = await getOpenLists();
    const normalizedListNames = new Set(
      lists.map((list) => list.name.trim().toLowerCase()),
    );
    const missingLists = configuredListNames(mappings).filter(
      (listName) => !normalizedListNames.has(listName.trim().toLowerCase()),
    );

    if (missingLists.length > 0) {
      return updateReadiness({
        ready: false,
        status: "missing_lists",
        missingLists,
        error: `Missing Trello list(s) on the configured board: ${missingLists.join(", ")}. Create or rename them, then refresh the bot.`,
      });
    }

    return updateReadiness({
      ready: true,
      status: "ready",
      missingLists: [],
      error: null,
    });
  } catch {
    return updateReadiness({
      ready: false,
      status: "unavailable",
      missingLists: [],
      error:
        "Trello readiness could not be verified. Check the configured board and Trello access, then refresh the bot.",
    });
  }
}

export async function requireTrelloReadiness(
  mappings: TrelloMappings = defaultTrelloMappings(),
): Promise<void> {
  const currentOrChecked = await checkTrelloReadiness(mappings);

  if (!currentOrChecked.ready) {
    throw new Error(
      currentOrChecked.error ??
        "Trello is not ready. Check GET /api/bot/status for setup details.",
    );
  }
}

export async function findList(listName: string): Promise<TrelloList> {
  const lists = await getOpenLists();
  const list = lists.find(
    (candidate) => candidate.name.trim().toLowerCase() === listName.trim().toLowerCase(),
  );

  if (!list) {
    throw new Error(
      `Trello list "${listName}" was not found on the configured board.`,
    );
  }

  return list;
}

function assertMappings(mappings: TrelloMappings): void {
  const values = [...Object.values(mappings.lists), ...Object.values(mappings.labels)];
  if (values.some((value) => !value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new Error("Trello list and label mappings must contain 1–100 printable characters.");
  }
  const normalizedLists = Object.values(mappings.lists).map((value) => value.trim().toLowerCase());
  if (new Set(normalizedLists).size !== normalizedLists.length) {
    throw new Error("Each Trello blacklist list must map to a distinct board list.");
  }
  const normalizedLabels = Object.values(mappings.labels).map((value) => value.trim().toLowerCase());
  if (new Set(normalizedLabels).size !== normalizedLabels.length) {
    throw new Error("Each Trello blacklist label must map to a distinct board label.");
  }
}

async function getLabels(): Promise<TrelloLabel[]> {
  const { boardId } = requireTrelloConfig();
  return request<TrelloLabel[]>(
    `/boards/${encodeURIComponent(boardId)}/labels?limit=100`,
  );
}

async function ensureLabel(
  name: string,
  color: string,
): Promise<TrelloLabel> {
  const existing = (await getLabels()).find(
    (label) => label.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (existing) return existing;

  const { boardId } = requireTrelloConfig();
  return request<TrelloLabel>(
    "/labels",
    body({ idBoard: boardId, name, color }),
  );
}

/** Validate every saved list and label mapping against the configured board. */
export async function validateTrelloMappings(
  mappings: TrelloMappings,
): Promise<void> {
  assertMappings(mappings);
  const [lists, labels] = await Promise.all([getOpenLists(), getLabels()]);
  const boardLists = new Set(lists.map((list) => list.name.trim().toLowerCase()));
  const boardLabels = new Set(labels.map((label) => label.name.trim().toLowerCase()));
  const missingLists = Object.values(mappings.lists).filter(
    (name) => !boardLists.has(name.trim().toLowerCase()),
  );
  const missingLabels = Object.values(mappings.labels).filter(
    (name) => !boardLabels.has(name.trim().toLowerCase()),
  );
  if (missingLists.length || missingLabels.length) {
    const details = [
      ...(missingLists.length ? [`missing lists: ${missingLists.join(", ")}`] : []),
      ...(missingLabels.length ? [`missing labels: ${missingLabels.join(", ")}`] : []),
    ].join("; ");
    throw new Error(`The proposed Trello mapping is not present on the configured board (${details}).`);
  }
}

export async function createBlacklistCard(input: {
  name: string;
  reason: string;
  type: BlacklistType;
  mappings?: TrelloMappings;
}): Promise<TrelloCard> {
  const mappings = input.mappings ?? defaultTrelloMappings();
  const list = await findList(mappings.lists[input.type]);
  const card = await request<TrelloCard>(
    "/cards",
    body({
      idList: list.id,
      name: input.name,
      desc: `- ${input.reason.trim()}`,
    }),
  );

  await addLabel(card.id, await ensureLabel(mappings.labels.blacklisted, "red"));
  await addLabel(card.id, await ensureLabel(mappings.labels[input.type], "orange"));
  return card;
}

export async function createGroupBlacklistCard(input: {
  groupUrl: string;
  reason: string;
  mappings?: TrelloMappings;
}): Promise<TrelloCard> {
  const mappings = input.mappings ?? defaultTrelloMappings();
  const list = await findList(mappings.lists.group);
  const card = await request<TrelloCard>(
    "/cards",
    body({
      idList: list.id,
      name: input.groupUrl,
      desc: `- ${input.reason.trim()}`,
    }),
  );

  await addLabel(card.id, await ensureLabel(mappings.labels.blacklisted, "red"));
  await addLabel(card.id, await ensureLabel(mappings.labels.group, "orange"));
  return card;
}

export async function findBlacklistCard(
  cardName: string,
): Promise<TrelloCard | undefined> {
  const { boardId } = requireTrelloConfig();
  const cards = await request<TrelloCard[]>(
    `/boards/${encodeURIComponent(boardId)}/cards?filter=all&fields=id,name,desc,idList,idLabels,url,dateLastActivity,closed`,
  );
  return cards.find(
    (card) => card.name.trim().toLowerCase() === cardName.trim().toLowerCase(),
  );
}

export async function findBlacklistCardByRobloxId(
  robloxId: number,
  mappings: TrelloMappings = defaultTrelloMappings(),
): Promise<TrelloBlacklistCard | undefined> {
  if (!Number.isSafeInteger(robloxId) || robloxId <= 0) return undefined;
  const cards = (await fetchBlacklistCards(mappings)).filter((card) => {
    const match = /^\s*[^|]+?\s*\|\s*(\d+)\s*$/.exec(card.name);
    return match ? Number(match[1]) === robloxId : false;
  });
  cards.sort((left, right) => {
    const leftTimestamp = Date.parse(left.dateLastActivity);
    const rightTimestamp = Date.parse(right.dateLastActivity);
    const timestamp =
      (Number.isFinite(rightTimestamp)
        ? rightTimestamp
        : Number.NEGATIVE_INFINITY) -
      (Number.isFinite(leftTimestamp)
        ? leftTimestamp
        : Number.NEGATIVE_INFINITY);
    if (timestamp !== 0) return timestamp;
    if (left.listType !== right.listType) {
      return left.listType === "revoked" ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
  });
  return cards[0];
}

async function addLabel(cardId: string, label: TrelloLabel): Promise<void> {
  await request(`/cards/${encodeURIComponent(cardId)}/idLabels`, {
    ...body({ value: label.id }),
  });
}

async function removeLabel(cardId: string, labelId: string): Promise<void> {
  await request(
    `/cards/${encodeURIComponent(cardId)}/idLabels/${encodeURIComponent(labelId)}`,
    { method: "DELETE" },
  );
}

export async function revokeBlacklistCard(
  card: TrelloCard,
  mappings: TrelloMappings = defaultTrelloMappings(),
): Promise<TrelloCard> {
  return revokeBlacklistCardById(card.id, mappings);
}

/**
 * Idempotently move one exact card into the revoked state.  Recovery uses the
 * saved card ID rather than a name/identity lookup, so a retry cannot affect a
 * subsequently created card for the same Roblox user.
 */
export async function revokeBlacklistCardById(
  cardId: string,
  mappings: TrelloMappings = defaultTrelloMappings(),
): Promise<TrelloCard> {
  const card = await request<TrelloCard>(
    `/cards/${encodeURIComponent(cardId)}?fields=id,name,desc,idList,idLabels,url,dateLastActivity,closed`,
  );
  if (card.closed) {
    throw new Error("The approved Trello blacklist card is closed and cannot be revoked.");
  }
  const revokedList = await findList(mappings.lists.revoked);
  if (card.idList !== revokedList.id) {
    await request<TrelloCard>(`/cards/${encodeURIComponent(card.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ idList: revokedList.id }),
    });
  }

  const labels = await getLabels();
  for (const label of labels) {
    if (
        [mappings.labels.appealable, mappings.labels.conditional, mappings.labels.permanent, mappings.labels.group]
          .map((name) => name.toLowerCase()).includes(label.name.toLowerCase()) &&
      card.idLabels.includes(label.id)
    ) {
      await removeLabel(card.id, label.id);
    }
  }

  const revokedLabel = await ensureLabel(mappings.labels.revoked, "green");
  if (!card.idLabels.includes(revokedLabel.id)) {
    await addLabel(card.id, revokedLabel);
  }
  return { ...card, idList: revokedList.id };
}
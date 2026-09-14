import { config, type BlacklistType } from "./config";

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
export async function fetchBlacklistCards(): Promise<TrelloBlacklistCard[]> {
  const lists = await getOpenLists();
  const listTypes: Array<[TrelloBlacklistListType, string]> = [
    ["appealable", config.trelloListNames.appealable],
    ["conditional", config.trelloListNames.conditional],
    ["permanent", config.trelloListNames.permanent],
    ["revoked", config.trelloListNames.revoked],
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

function configuredListNames(): string[] {
  return [...new Set(Object.values(config.trelloListNames))];
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

export async function checkTrelloReadiness(): Promise<TrelloReadiness> {
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
    const missingLists = configuredListNames().filter(
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

export async function requireTrelloReadiness(): Promise<void> {
  const current = getTrelloReadiness();
  const currentOrChecked =
    current.status === "unknown" ? await checkTrelloReadiness() : current;

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

export async function createBlacklistCard(input: {
  name: string;
  reason: string;
  type: BlacklistType;
}): Promise<TrelloCard> {
  const list = await findList(config.trelloListNames[input.type]);
  const card = await request<TrelloCard>(
    "/cards",
    body({
      idList: list.id,
      name: input.name,
      desc: `- ${input.reason.trim()}`,
    }),
  );

  await addLabel(card.id, await ensureLabel("blacklisted", "red"));
  await addLabel(card.id, await ensureLabel(input.type, "orange"));
  return card;
}

export async function createGroupBlacklistCard(input: {
  groupUrl: string;
  reason: string;
}): Promise<TrelloCard> {
  const list = await findList(config.trelloListNames.group);
  const card = await request<TrelloCard>(
    "/cards",
    body({
      idList: list.id,
      name: input.groupUrl,
      desc: `- ${input.reason.trim()}`,
    }),
  );

  await addLabel(card.id, await ensureLabel("blacklisted", "red"));
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
): Promise<TrelloBlacklistCard | undefined> {
  if (!Number.isSafeInteger(robloxId) || robloxId <= 0) return undefined;
  const cards = (await fetchBlacklistCards()).filter((card) => {
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
): Promise<TrelloCard> {
  const revokedList = await findList(config.trelloListNames.revoked);
  await request<TrelloCard>(`/cards/${encodeURIComponent(card.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ idList: revokedList.id }),
  });

  const labels = await getLabels();
  for (const label of labels) {
    if (
      ["appealable", "conditional", "permanent"].includes(
        label.name.toLowerCase(),
      ) &&
      card.idLabels.includes(label.id)
    ) {
      await removeLabel(card.id, label.id);
    }
  }

  await addLabel(card.id, await ensureLabel("revoked", "green"));
  return { ...card, idList: revokedList.id };
}
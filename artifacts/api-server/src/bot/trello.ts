import { config, type BlacklistType } from "./config";

interface TrelloList {
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
    `/boards/${encodeURIComponent(boardId)}/cards?filter=all&fields=name,desc,idList,idLabels,url`,
  );
  return cards.find(
    (card) => card.name.trim().toLowerCase() === cardName.trim().toLowerCase(),
  );
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
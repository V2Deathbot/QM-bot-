import { config, type BlacklistType } from "./config";
import {
  defaultTrelloMappings,
  type TrelloMappings,
} from "./setup-store";

export interface TrelloList {
  id: string;
  name: string;
  idBoard?: string;
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
  idBoard: string;
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

function requireTrelloCredentials(): {
  key: string;
  token: string;
} {
  const key = config.trelloApiKey;
  const token = config.trelloToken;
  if (!key || !token) {
    throw new Error("Trello is not configured. Add TRELLO_API_KEY and TRELLO_TOKEN.");
  }
  return { key, token };
}

function requireTrelloConfig(boardOverride?: string): {
  key: string;
  token: string;
  boardId: string;
} {
  const { key, token } = requireTrelloCredentials();
  const boardId = boardOverride?.trim() || config.trelloBoardId;

  if (!boardId) {
    throw new Error(
      "No Trello board is selected. Choose a board in /setup or set TRELLO_BOARD_ID for legacy guilds.",
    );
  }

  return { key, token, boardId };
}

async function request<T>(
  pathname: string,
  init: RequestInit = {},
): Promise<T> {
  const { key, token } = requireTrelloCredentials();
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

function boardIdFor(mappings?: TrelloMappings): string | undefined {
  return mappings?.boardId?.trim() || config.trelloBoardId;
}

function assertCardOnConfiguredBoard(
  card: TrelloCard,
  mappings: TrelloMappings,
  boardLists: TrelloList[],
): void {
  const { boardId } = requireTrelloConfig(boardIdFor(mappings));
  const canonicalBoardIds = new Set(
    boardLists
      .map((list) => list.idBoard)
      .filter((id): id is string => Boolean(id)),
  );
  // Trello accepts either its canonical board ID or a short link in board
  // routes, while card.idBoard always uses the canonical ID. Resolve aliases
  // through the configured board's own list records before rejecting.
  if (
    (card.idBoard &&
      card.idBoard !== boardId &&
      !canonicalBoardIds.has(card.idBoard)) ||
    (!card.idBoard && !boardLists.some((list) => list.id === card.idList))
  ) {
    throw new Error(
      "The selected Trello card is not on the configured board and cannot be changed.",
    );
  }
}

async function getOpenLists(mappings?: TrelloMappings): Promise<TrelloList[]> {
  const { boardId } = requireTrelloConfig(boardIdFor(mappings));
  return request<TrelloList[]>(
    `/boards/${encodeURIComponent(boardId)}/lists?filter=open&fields=id,name,idBoard`,
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
  const lists = await getOpenLists(mappings);
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

  const { boardId } = requireTrelloConfig(boardIdFor(mappings));
  const cards = await request<TrelloCard[]>(
    `/boards/${encodeURIComponent(boardId)}/cards?filter=all&fields=id,idBoard,name,desc,idList,idLabels,url,dateLastActivity,closed`,
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
    requireTrelloConfig(boardIdFor(mappings));
  } catch {
    return updateReadiness({
      ready: false,
      status: "not_configured",
      missingLists: [],
      error:
        "Trello credentials or a board selection are missing. Add TRELLO_API_KEY and TRELLO_TOKEN, then choose a board in /setup, or set TRELLO_BOARD_ID for legacy guilds.",
    });
  }

  try {
    const lists = await getOpenLists(mappings);
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

export async function findList(listName: string, mappings?: TrelloMappings): Promise<TrelloList> {
  const lists = await getOpenLists(mappings);
  const list = findListInSnapshot(lists, listName);

  if (!list) {
    throw new Error(
      `Trello list "${listName}" was not found on the configured board.`,
    );
  }

  return list;
}

function findListInSnapshot(
  lists: TrelloList[],
  listName: string,
): TrelloList | undefined {
  return lists.find(
    (candidate) => candidate.name.trim().toLowerCase() === listName.trim().toLowerCase(),
  );
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

async function getLabels(mappings?: TrelloMappings): Promise<TrelloLabel[]> {
  const { boardId } = requireTrelloConfig(boardIdFor(mappings));
  return request<TrelloLabel[]>(
    `/boards/${encodeURIComponent(boardId)}/labels?limit=100`,
  );
}

async function ensureLabel(
  name: string,
  color: string,
  knownLabels?: TrelloLabel[],
  mappings?: TrelloMappings,
): Promise<TrelloLabel> {
  const normalizedName = normalizedLabelName(name);
  const labels = knownLabels ?? (await getLabels(mappings));
  const existing = labels.find(
    (label) => normalizedLabelName(label.name) === normalizedName,
  );
  if (existing) return existing;

  const { boardId } = requireTrelloConfig(boardIdFor(mappings));
  return request<TrelloLabel>(
    "/labels",
    body({ idBoard: boardId, name: name.trim(), color }),
  );
}

/** Validate every saved list and label mapping against the configured board. */
export async function validateTrelloMappings(
  mappings: TrelloMappings,
): Promise<void> {
  assertMappings(mappings);
  const [lists, labels] = await Promise.all([getOpenLists(mappings), getLabels(mappings)]);
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
  const list = await findList(mappings.lists[input.type], mappings);
  const card = await request<TrelloCard>(
    "/cards",
    body({
      idList: list.id,
      name: input.name,
      desc: `- ${input.reason.trim()}`,
    }),
  );

  await addLabel(card.id, await ensureLabel(mappings.labels.blacklisted, "red", undefined, mappings));
  await addLabel(card.id, await ensureLabel(mappings.labels[input.type], "orange", undefined, mappings));
  return card;
}

export async function createGroupBlacklistCard(input: {
  groupUrl: string;
  reason: string;
  mappings?: TrelloMappings;
}): Promise<TrelloCard> {
  const mappings = input.mappings ?? defaultTrelloMappings();
  const list = await findList(mappings.lists.group, mappings);
  const card = await request<TrelloCard>(
    "/cards",
    body({
      idList: list.id,
      name: input.groupUrl,
      desc: `- ${input.reason.trim()}`,
    }),
  );

  await addLabel(card.id, await ensureLabel(mappings.labels.blacklisted, "red", undefined, mappings));
  await addLabel(card.id, await ensureLabel(mappings.labels.group, "orange", undefined, mappings));
  return card;
}

export async function findBlacklistCard(
  cardName: string,
  mappings?: TrelloMappings,
): Promise<TrelloCard | undefined> {
  const { boardId } = requireTrelloConfig(boardIdFor(mappings));
  const cards = await request<TrelloCard[]>(
    `/boards/${encodeURIComponent(boardId)}/cards?filter=all&fields=id,idBoard,name,desc,idList,idLabels,url,dateLastActivity,closed`,
  );
  return cards.find(
    (card) => card.name.trim().toLowerCase() === cardName.trim().toLowerCase(),
  );
}

function robloxIdFromCardName(cardName: string): number | undefined {
  const match = /^\s*[^|]+?\s*\|\s*(\d+)\s*$/.exec(cardName);
  if (!match) return undefined;
  const robloxId = Number(match[1]);
  return Number.isSafeInteger(robloxId) && robloxId > 0 ? robloxId : undefined;
}

/**
 * Return every open user blacklist card for an exact Roblox account id.
 * Names are deliberately not part of this match: Roblox usernames can be
 * renamed, and substring/name matching could select another account.
 */
export async function findBlacklistCardsByRobloxId(
  robloxId: number,
  mappings: TrelloMappings = defaultTrelloMappings(),
): Promise<TrelloBlacklistCard[]> {
  if (!Number.isSafeInteger(robloxId) || robloxId <= 0) return [];
  const cards = (await fetchBlacklistCards(mappings)).filter(
    (card) => robloxIdFromCardName(card.name) === robloxId,
  );
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
  return cards;
}

export async function findBlacklistCardByRobloxId(
  robloxId: number,
  mappings: TrelloMappings = defaultTrelloMappings(),
): Promise<TrelloBlacklistCard | undefined> {
  const cards = await findBlacklistCardsByRobloxId(robloxId, mappings);
  return cards[0];
}

async function addLabel(cardId: string, label: TrelloLabel): Promise<void> {
  await request(`/cards/${encodeURIComponent(cardId)}/idLabels`, {
    ...body({ value: label.id }),
  });
}

async function updateCard(
  cardId: string,
  updates: Record<string, string>,
): Promise<void> {
  await request<TrelloCard>(`/cards/${encodeURIComponent(cardId)}`, {
    method: "PUT",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(updates),
  });
}

function normalizedLabelName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Move one exact revoked card back into an active blacklist category. The
 * card id is intentionally supplied by the caller and re-read here, so the
 * operation preserves Trello history and cannot silently target a card whose
 * identity changed between the account lookup and this update.
 */
export async function reactivateBlacklistCardById(
  cardId: string,
  input: {
    robloxId: number;
    robloxUsername: string;
    reason: string;
    type: BlacklistType;
    mappings?: TrelloMappings;
  },
): Promise<TrelloCard> {
  if (!Number.isSafeInteger(input.robloxId) || input.robloxId <= 0) {
    throw new Error("The Roblox user id must be a positive safe integer.");
  }
  const mappings = input.mappings ?? defaultTrelloMappings();
  const card = await request<TrelloCard>(
    `/cards/${encodeURIComponent(cardId)}?fields=id,idBoard,name,desc,idList,idLabels,url,dateLastActivity,closed`,
  );
  if (card.closed) {
    throw new Error("The revoked Trello blacklist card is closed and cannot be reused.");
  }
  if (robloxIdFromCardName(card.name) !== input.robloxId) {
    throw new Error(
      "The selected revoked Trello card no longer matches the requested Roblox account.",
    );
  }

  const lists = await getOpenLists(mappings);
  assertCardOnConfiguredBoard(card, mappings, lists);
  const revokedList = findListInSnapshot(lists, mappings.lists.revoked);
  const targetList = findListInSnapshot(lists, mappings.lists[input.type]);
  if (!revokedList) {
    throw new Error(
      `Trello list "${mappings.lists.revoked}" was not found on the configured board.`,
    );
  }
  if (!targetList) {
    throw new Error(
      `Trello list "${mappings.lists[input.type]}" was not found on the configured board.`,
    );
  }
  if (card.idList !== revokedList.id) {
    throw new Error(
      "The selected Trello card is no longer in the configured revoked list.",
    );
  }

  const nextName = `${input.robloxUsername} | ${input.robloxId}`;
  const nextDescription = `- ${input.reason.trim()}`;
  const labels = await getLabels(mappings);
  const blacklistedLabel = await ensureLabel(
    mappings.labels.blacklisted,
    "red",
    labels,
    mappings,
  );
  if (!labels.some((label) => label.id === blacklistedLabel.id)) {
    labels.push(blacklistedLabel);
  }
  const typeLabel = await ensureLabel(
    mappings.labels[input.type],
    "orange",
    labels,
    mappings,
  );
  if (!labels.some((label) => label.id === typeLabel.id)) {
    labels.push(typeLabel);
  }

  // Only lifecycle labels are swapped. Any unrelated board labels remain
  // attached to the historical card. Compute this complete label set before
  // the single card update so a label preparation failure leaves the card in
  // its original revoked state.
  const lifecycleNames = new Set(
    [
      mappings.labels.appealable,
      mappings.labels.conditional,
      mappings.labels.permanent,
      mappings.labels.group,
      mappings.labels.revoked,
    ].map(normalizedLabelName),
  );
  const revokedName = normalizedLabelName(mappings.labels.revoked);
  const blacklistedName = normalizedLabelName(mappings.labels.blacklisted);
  const selectedTypeName = normalizedLabelName(mappings.labels[input.type]);
  const labelById = new Map(labels.map((label) => [label.id, label]));
  const desiredLabelIds = (card.idLabels ?? []).filter((labelId) => {
    const label = labelById.get(labelId);
    if (!label) return true;
    const normalizedName = normalizedLabelName(label.name);
    if (normalizedName === revokedName) return false;
    return (
      !lifecycleNames.has(normalizedName) ||
      normalizedName === selectedTypeName
    );
  });
  if (
    !desiredLabelIds.some(
      (labelId) =>
        normalizedLabelName(labelById.get(labelId)?.name ?? "") ===
        blacklistedName,
    )
  ) {
    desiredLabelIds.push(blacklistedLabel.id);
  }
  if (
    !desiredLabelIds.some(
      (labelId) =>
        normalizedLabelName(labelById.get(labelId)?.name ?? "") ===
        selectedTypeName,
    )
  ) {
    desiredLabelIds.push(typeLabel.id);
  }

  await updateCard(card.id, {
    idList: targetList.id,
    name: nextName,
    desc: nextDescription,
    idLabels: desiredLabelIds.join(","),
  });

  return {
    ...card,
    name: nextName,
    desc: nextDescription,
    idList: targetList.id,
    idLabels: desiredLabelIds,
  };
}

export async function reactivateBlacklistCard(
  card: TrelloCard,
  input: {
    robloxId: number;
    robloxUsername: string;
    reason: string;
    type: BlacklistType;
    mappings?: TrelloMappings;
  },
): Promise<TrelloCard> {
  return reactivateBlacklistCardById(card.id, input);
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
    `/cards/${encodeURIComponent(cardId)}?fields=id,idBoard,name,desc,idList,idLabels,url,dateLastActivity,closed`,
  );
  if (card.closed) {
    throw new Error("The approved Trello blacklist card is closed and cannot be revoked.");
  }
  const lists = await getOpenLists(mappings);
  assertCardOnConfiguredBoard(card, mappings, lists);
  const revokedList = findListInSnapshot(lists, mappings.lists.revoked);
  if (!revokedList) {
    throw new Error(
      `Trello list "${mappings.lists.revoked}" was not found on the configured board.`,
    );
  }
  const labels = await getLabels(mappings);
  const revokedLabel = await ensureLabel(
    mappings.labels.revoked,
    "green",
    labels,
    mappings,
  );
  if (!labels.some((label) => label.id === revokedLabel.id)) {
    labels.push(revokedLabel);
  }

  const labelById = new Map(labels.map((label) => [label.id, label]));
  const blacklistedName = normalizedLabelName(mappings.labels.blacklisted);
  const revokedName = normalizedLabelName(mappings.labels.revoked);
  const desiredLabelIds = (card.idLabels ?? []).filter((labelId) => {
    const label = labelById.get(labelId);
    return normalizedLabelName(label?.name ?? "") !== blacklistedName;
  });
  if (
    !desiredLabelIds.some(
      (labelId) =>
        normalizedLabelName(labelById.get(labelId)?.name ?? "") ===
        revokedName,
    )
  ) {
    desiredLabelIds.push(revokedLabel.id);
  }

  await updateCard(card.id, {
    idList: revokedList.id,
    idLabels: desiredLabelIds.join(","),
  });

  return {
    ...card,
    idList: revokedList.id,
    idLabels: desiredLabelIds,
  };
}

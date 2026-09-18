export interface RobloxUser {
  id: number;
  name: string;
  displayName: string;
}

export class RobloxUserNotFoundError extends Error {
  constructor() {
    super("No Roblox user was found.");
    this.name = "RobloxUserNotFoundError";
  }
}

export class RobloxInventoryPrivateError extends Error {
  constructor() {
    super("The customer's Roblox inventory is private, so ownership cannot be verified automatically.");
    this.name = "RobloxInventoryPrivateError";
  }
}

export class RobloxOwnershipUnavailableError extends Error {
  constructor() {
    super("Roblox ownership verification is temporarily unavailable.");
    this.name = "RobloxOwnershipUnavailableError";
  }
}

export interface RobloxClassicShirt {
  id: number;
  name: string;
  isForSale: boolean;
  description?: string;
}

export class RobloxAssetMetadataUnavailableError extends Error {
  constructor(public readonly status: number | undefined) {
    super(`Roblox could not verify the uploaded Classic Shirt (HTTP ${status ?? "unknown"}).`);
    this.name = "RobloxAssetMetadataUnavailableError";
  }
}

export async function getRobloxAssetProcessingState(assetId: number): Promise<string | undefined> {
  try {
    const response = await fetch(
      `https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}` +
      "&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false",
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) return undefined;
    const payload = await response.json() as {
      data?: Array<{ targetId?: unknown; state?: unknown }>;
    };
    const item = payload.data?.find((value) => value.targetId === assetId);
    return typeof item?.state === "string" ? item.state : undefined;
  } catch {
    return undefined;
  }
}

export async function verifyUploadedClassicShirt(assetId: number): Promise<RobloxClassicShirt> {
  if (!isPositiveSafeInteger(assetId)) throw new Error("The Roblox Classic Shirt asset ID must be a positive safe integer.");
  let response: Response | undefined;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      response = await fetch(`https://economy.roblox.com/v2/assets/${assetId}/details`, {
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new Error("Roblox could not verify the uploaded Classic Shirt.");
    }
    if (response.status !== 400 || attempt === 4) break;
    // Newly created Roblox assets can briefly return 400 before their Economy
    // details become available. Allow four total checks before surfacing it.
    await new Promise((resolve) => setTimeout(resolve, attempt * 400));
  }
  if (!response?.ok) {
    if (response?.status === 400) {
      const processingState = await getRobloxAssetProcessingState(assetId);
      if (processingState === "Pending") {
        throw new Error(
          "Roblox is still processing or moderating this Classic Shirt. Wait until the asset finishes processing, then submit the same link again.",
        );
      }
      if (processingState === "Blocked") {
        throw new Error(
          "Roblox has blocked this Classic Shirt. Use Mark Moderated instead of approving it.",
        );
      }
    }
    throw new RobloxAssetMetadataUnavailableError(response?.status);
  }
  const value = await response.json() as {
    AssetId?: unknown; AssetTypeId?: unknown; Name?: unknown; Description?: unknown; IsForSale?: unknown;
  };
  if (value.AssetId !== assetId || value.AssetTypeId !== 11 || typeof value.Name !== "string" ||
      typeof value.Description !== "string" || typeof value.IsForSale !== "boolean") {
    throw new Error("The supplied Roblox link is not an uploaded Classic Shirt.");
  }
  return { id: assetId, name: value.Name, description: value.Description, isForSale: value.IsForSale };
}

interface RobloxUserLookupResponse {
  data?: Array<RobloxUser>;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isSafeRobloxText(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 50 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function validatedRobloxUser(value: unknown): RobloxUser | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<RobloxUser>;
  if (!isPositiveSafeInteger(candidate.id as number) ||
      !isSafeRobloxText(candidate.name)) {
    return undefined;
  }
  const displayName = isSafeRobloxText(candidate.displayName)
    ? candidate.displayName
    : candidate.name;
  return {
    id: candidate.id!,
    name: candidate.name,
    displayName,
  };
}

export async function findRobloxUser(username: string): Promise<RobloxUser> {
  const requested = username.trim();
  if (!isSafeRobloxText(requested)) {
    throw new Error("The Roblox username must be a non-empty printable value.");
  }
  const response = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      usernames: [requested],
      excludeBannedUsers: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Roblox user lookup failed (${response.status}).`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Roblox user lookup returned an invalid response.");
  }
  const data = payload && typeof payload === "object" &&
    Array.isArray((payload as RobloxUserLookupResponse).data)
    ? (payload as RobloxUserLookupResponse).data
    : undefined;
  const user = validatedRobloxUser(data?.[0]);

  if (!user) {
    throw new Error(`No Roblox user was found for "${requested}".`);
  }

  return user;
}

/**
 * Look up the canonical Roblox username for an immutable user id.  This is
 * intentionally a separate endpoint from the username search: cards retain
 * their original title, while enforcement uses the name currently returned
 * by Roblox.
 */
export async function findRobloxUserById(id: number): Promise<RobloxUser> {
  if (!isPositiveSafeInteger(id)) {
    throw new Error("The Roblox user id must be a positive safe integer.");
  }

  let response: Response;
  try {
    response = await fetch(`https://users.roblox.com/v1/users/${id}`);
  } catch {
    throw new Error("Roblox user lookup failed.");
  }

  if (!response.ok) {
    if (response.status === 404) throw new RobloxUserNotFoundError();
    throw new Error("Roblox user lookup failed.");
  }

  let user: unknown;
  try {
    user = await response.json();
  } catch {
    throw new Error("Roblox user lookup returned an invalid response.");
  }

  const candidate = validatedRobloxUser(user);
  if (!candidate || candidate.id !== id) {
    throw new Error("Roblox user lookup returned an invalid response.");
  }

  return {
    id,
    name: candidate.name,
    displayName: candidate.displayName,
  };
}

export async function ownsRobloxAsset(
  userId: number,
  assetId: number,
): Promise<boolean> {
  if (!isPositiveSafeInteger(userId) || !isPositiveSafeInteger(assetId)) {
    throw new Error("Roblox ownership checks require valid user and asset IDs.");
  }

  const url =
    `https://inventory.roblox.com/v1/users/${userId}/items/Asset/${assetId}/is-owned`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.status === 403) throw new RobloxInventoryPrivateError();
      if (response.status === 429 || response.status >= 500) {
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 300));
          continue;
        }
        throw new RobloxOwnershipUnavailableError();
      }
      if (!response.ok) {
        throw new Error(`Roblox ownership verification failed (${response.status}).`);
      }
      const owned = (await response.json()) as unknown;
      if (typeof owned !== "boolean") {
        throw new RobloxOwnershipUnavailableError();
      }
      return owned;
    } catch (error) {
      if (error instanceof RobloxInventoryPrivateError) throw error;
      if (
        error instanceof Error &&
        /^Roblox ownership verification failed \(\d+\)\.$/.test(error.message)
      ) {
        throw error;
      }
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 300));
        continue;
      }
      throw new RobloxOwnershipUnavailableError();
    }
  }
  throw new RobloxOwnershipUnavailableError();
}

export async function verifyPublishedClassicShirt(
  assetId: number,
): Promise<RobloxClassicShirt> {
  if (!isPositiveSafeInteger(assetId)) {
    throw new Error("The Roblox Classic Shirt asset ID must be a positive safe integer.");
  }
  let response: Response;
  try {
    response = await fetch(`https://economy.roblox.com/v2/assets/${assetId}/details`, {
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error("Roblox could not verify the published Classic Shirt.");
  }
  if (!response.ok) {
    throw new Error(`Roblox could not verify the published Classic Shirt (HTTP ${response.status}).`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Roblox returned an invalid Classic Shirt response.");
  }
  const value = payload as {
    AssetId?: unknown;
    AssetTypeId?: unknown;
    Name?: unknown;
    IsForSale?: unknown;
  };
  if (
    !payload ||
    typeof payload !== "object" ||
    value.AssetId !== assetId ||
    value.AssetTypeId !== 11 ||
    typeof value.Name !== "string" ||
    typeof value.IsForSale !== "boolean"
  ) {
    throw new Error("The supplied Roblox link is not a published Classic Shirt.");
  }
  if (!value.IsForSale) {
    throw new Error("The Roblox Classic Shirt is not on sale yet.");
  }
  return { id: assetId, name: value.Name, isForSale: value.IsForSale };
}

export function getRobloxGroupUrl(groupId: string): string {
  const normalized = groupId.trim();
  if (!/^\d+$/.test(normalized) ||
      !isPositiveSafeInteger(Number(normalized))) {
    throw new Error("The Roblox group id must be a positive safe integer.");
  }

  return `https://www.roblox.com/communities/${normalized}`;
}
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

interface RobloxUserLookupResponse {
  data?: Array<RobloxUser>;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export async function findRobloxUser(username: string): Promise<RobloxUser> {
  const response = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      usernames: [username.trim()],
      excludeBannedUsers: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Roblox user lookup failed (${response.status}).`);
  }

  const payload = (await response.json()) as RobloxUserLookupResponse;
  const user = payload.data?.[0];

  if (!user) {
    throw new Error(`No Roblox user was found for "${username}".`);
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

  if (
    !user ||
    typeof user !== "object" ||
    !isPositiveSafeInteger((user as { id?: unknown }).id as number) ||
    (user as { id: number }).id !== id ||
    typeof (user as { name?: unknown }).name !== "string" ||
    !(user as { name: string }).name.trim()
  ) {
    throw new Error("Roblox user lookup returned an invalid response.");
  }

  const candidate = user as Partial<RobloxUser>;
  return {
    id,
    name: candidate.name!,
    displayName:
      typeof candidate.displayName === "string"
        ? candidate.displayName
        : candidate.name!,
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

export function getRobloxGroupUrl(groupId: string): string {
  if (!/^\d+$/.test(groupId.trim())) {
    throw new Error("The Roblox group id must contain only numbers.");
  }

  return `https://www.roblox.com/communities/${groupId.trim()}`;
}
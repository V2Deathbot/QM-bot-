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

export function getRobloxGroupUrl(groupId: string): string {
  if (!/^\d+$/.test(groupId.trim())) {
    throw new Error("The Roblox group id must contain only numbers.");
  }

  return `https://www.roblox.com/communities/${groupId.trim()}`;
}
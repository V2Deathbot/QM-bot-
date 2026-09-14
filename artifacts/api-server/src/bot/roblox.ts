export interface RobloxUser {
  id: number;
  name: string;
  displayName: string;
}

interface RobloxUserLookupResponse {
  data?: Array<RobloxUser>;
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

export function getRobloxGroupUrl(groupId: string): string {
  if (!/^\d+$/.test(groupId.trim())) {
    throw new Error("The Roblox group id must contain only numbers.");
  }

  return `https://www.roblox.com/communities/${groupId.trim()}`;
}
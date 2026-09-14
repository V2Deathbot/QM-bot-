import type { GuildMember } from "discord.js";

export interface RoleActionResult {
  changed: string[];
  skipped: string[];
}

export function getRemovableRoleIds(member: GuildMember): RoleActionResult {
  const botMember = member.guild.members.me;
  const changed: string[] = [];
  const skipped: string[] = [];

  for (const role of member.roles.cache.values()) {
    if (role.id === member.guild.id || role.managed) continue;
    if (botMember && role.position < botMember.roles.highest.position) {
      changed.push(role.id);
    } else {
      skipped.push(role.id);
    }
  }

  return { changed, skipped };
}

export async function removeAssignableRoles(
  member: GuildMember,
  reason = "Roblox blacklist",
): Promise<RoleActionResult> {
  const result = getRemovableRoleIds(member);
  if (result.changed.length > 0) {
    await member.roles.remove(result.changed, reason);
  }
  return result;
}

export async function restoreAssignableRoles(
  member: GuildMember,
  roleIds: string[],
  reason = "Roblox blacklist revoked",
): Promise<RoleActionResult> {
  const botMember = member.guild.members.me;
  const changed: string[] = [];
  const skipped: string[] = [];

  for (const roleId of roleIds) {
    const role = member.guild.roles.cache.get(roleId);
    if (member.roles.cache.has(roleId)) continue;
    if (
      role &&
      !role.managed &&
      botMember &&
      role.position < botMember.roles.highest.position
    ) {
      changed.push(roleId);
    } else {
      skipped.push(roleId);
    }
  }

  if (changed.length > 0) {
    await member.roles.add(changed, reason);
  }
  return { changed, skipped };
}

export function describeRoles(
  member: GuildMember,
  roleIds: string[],
): string {
  if (roleIds.length === 0) return "None";
  return roleIds
    .map((roleId) => {
      const role = member.guild.roles.cache.get(roleId);
      return role ? `${role.name} (${role.id})` : roleId;
    })
    .join(", ")
    .slice(0, 1_000);
}
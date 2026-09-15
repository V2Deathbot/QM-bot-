---
name: Configured payout authority
description: Setup-selected security authority boundaries for payout and destructive-action configuration.
---

The actual Discord server owner must select the Security / Payout Owner in setup. Only that selected member may run payouts or change destructive-action security limits; an Administrator role alone must not grant those capabilities.

**Why:** A privileged role can be granted or compromised independently of the server owner. Requiring the server owner to select the authorized member makes the authority explicit while supporting a trusted operator who is not the Discord owner.

**How to apply:** Keep the selected-member check at command entry and confirmation/modal execution. Let only `guild.ownerId` assign or replace the configured owner. Continue checking current Administrator permission for other moderation commands and keep escalation state fail-closed for first observations.
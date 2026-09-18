---
name: Manual Roblox shirt review
description: Defines who is responsible for checking newly uploaded Classic Shirts before publisher handoff.
---

Senior Quartermasters manually verify the uploaded Classic Shirt before submitting its catalog link. The bot should accept that submission as approval and immediately forward the exact asset to publishers without polling Roblox moderation or metadata APIs.

**Why:** Roblox public metadata APIs reject or hide newly uploaded private shirts, and the user explicitly chose manual review instead of automated moderation checks.

**How to apply:** Keep URL/asset-ID parsing and exact approved-asset enforcement, but do not block the SEQM-to-publisher handoff on Roblox name, description, type, thumbnail, catalog, Economy, or moderation status checks. Manual “moderated” actions remain authoritative.
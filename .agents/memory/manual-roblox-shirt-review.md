---
name: Manual Roblox shirt review
description: Defines who is responsible for checking newly uploaded Classic Shirts before publisher handoff.
---

Senior Quartermasters manually verify the uploaded Classic Shirt before submitting its catalog link. The bot accepts that submission as approval. It may perform one narrow public check to determine whether the shirt is already on sale.

A single created-uniform submission may contain up to five shirts. For mixed outcomes, deliver successful shirts immediately, log denied shirts in the moderated worksheet, and tell the customer how many moderated shirts will be sent later.

**Why:** Roblox public metadata APIs reject or hide newly uploaded private shirts, and the user explicitly chose manual review instead of automated moderation checks.

**How to apply:** Keep URL/asset-ID parsing and exact approved-asset enforcement. If Roblox confirms the shirt is already published and on sale, record the SEQM as publisher and deliver directly to the customer. Otherwise, including any lookup failure, immediately use the publisher handoff. Never poll or block on Roblox metadata or moderation status. Manual “moderated” selections remain authoritative, including per-shirt selections in multi-shirt submissions.
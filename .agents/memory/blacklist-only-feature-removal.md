---
name: Blacklist-only feature removal
description: Why inactive legacy documents survive the blacklist-only bot transition.
---

When removing non-blacklist bot features, preserve existing historical documents and the minimal validation needed to import them, while removing their commands, live handlers, and setup UI.

**Why:** Deleting a feature is not permission to erase existing records or make older guild settings unreadable. Existing moderation and role-restoration state must remain intact, and archived non-blacklist records may still need migration or retention.

**How to apply:** When changing bot setup, storage, or import behavior, keep old documents readable without reconnecting the retired workflows; explicitly separate legacy import compatibility from live features.
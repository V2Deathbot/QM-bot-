---
name: Role snapshot runtime state
description: Operational caveat for cleaning the file-backed role snapshot store.
---

The role snapshot store caches its parsed file in memory for the lifetime of the bot process. If a snapshot file is edited outside the running process, restart the bot before trusting or persisting the cleaned state.

**Why:** A failed live command can leave a stale in-memory snapshot even after its file entry is removed; a later successful write can put that stale entry back.

**How to apply:** Treat file cleanup and process restart as one operation when recovering from a failed moderation test.
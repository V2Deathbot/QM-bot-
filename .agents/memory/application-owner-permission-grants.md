---
name: Application-owner permission grants
description: Authority boundary and defaults for configurable command access.
---

Every registered command except `/blacklist_lookup` defaults to Discord Administrator/server-owner access. Only the Discord application owner may add, replace, or remove per-command role/member grants. `/blacklist_lookup` is always public and is not configurable.

**Why:** Permission grants let non-Administrators use bot features. The user requires each command to be delegated independently and requires delegation authority to remain exclusively with the Discord application owner.

**How to apply:** Resolve ownership from Discord application metadata and fail closed when unavailable. Do not use Discord's Administrator-only command registration flag because it blocks granted users before runtime checks. Recheck grants at execution boundaries.
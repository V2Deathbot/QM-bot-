---
name: Application-owner permission grants
description: Authority boundary for configurable uploading and blacklist access.
---

Only the Discord application owner may add, replace, or remove configured uploading and blacklist role/member grants. Blacklist grants default to empty, so server-owner or current-Administrator access remains the default.

**Why:** Permission grants let non-Administrators use sensitive bot features. The user requires this delegation authority to remain exclusively with the Discord application owner, not each server's Administrators.

**How to apply:** Resolve ownership from Discord application metadata and fail closed when it is unavailable. Keep grants narrowly scoped: blacklist grants authorize blacklist actions only, and uploading grants authorize uniform uploads only. Recheck authorization at execution boundaries.
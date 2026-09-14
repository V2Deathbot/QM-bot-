---
name: Trello list configuration
description: Trello list names can be overridden per deployment and should not be assumed to use the defaults.
---

Trello list names are deployment configuration, so behavior and tests must derive expected names from the active configuration rather than hardcoding the default labels.

**Why:** The running workspace uses customized list names, and hardcoded test expectations failed even though readiness matching was correct.

**How to apply:** When testing or documenting list readiness, use the configured list-name map and verify every configured entry.
---
name: Trello list configuration
description: Trello list names can differ from defaults; tests must respect active guild mappings and environment defaults.
---

Trello list names are configurable, so behavior and tests must derive expected names from the effective guild configuration rather than hardcoding the default labels.

**Why:** The running workspace uses customized list names, and hardcoded test expectations failed even though readiness matching was correct.

**How to apply:** When testing or documenting list readiness, use the configured list-name map and verify every configured entry.

Tests must set their environment overrides before importing modules that depend on the bot configuration.

**Why:** Configuration is read when its module is evaluated, so importing the app before test setup can cache deployment values and write to the wrong snapshot file.

**How to apply:** Use dynamic imports after test environment setup for routes or bot modules that import the configuration.

Trello board routes may use a short link while cards report the canonical board ID.

**Why:** Literal comparison between those valid identifiers rejects cards fetched from the configured board.

**How to apply:** Resolve canonical identity from the configured board's list records before exact-card mutations, while still rejecting genuinely cross-board cards.
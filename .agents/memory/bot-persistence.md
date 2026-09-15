---
name: Bot persistence constraints
description: Non-obvious migration and single-runtime constraints for always-on hosting.
---

Preserve legacy JSON documents in PostgreSQL TEXT rather than JSONB.

**Why:** Actual legacy composite keys contain escaped NUL characters. JSONB rejects these with an unsupported Unicode escape error. TEXT preserves the serialized JSON exactly without dropping or rewriting keys.

**How to apply:** Parse after retrieval, validate strictly, and include escaped NUL keys and values in persistence tests. Import must verify exact bytes and refuse mismatched existing records.

Keep only one environment connected to the real Discord bot.

**Why:** Development and production use separate databases, so a database advisory lock cannot prevent one runtime in each environment from responding to the same Discord events.

**How to apply:** Treat the environment-specific runtime toggle as a cutover prerequisite. Session leadership loss must stop the process and prevent pending refresh work from reconnecting. First publishing must include the imported development data using the supported Publish UI, not a production startup import.

During a rolling publish, a replacement process must retry initial leadership acquisition while the prior healthy process still holds the advisory lock.

**Why:** Replit can start and health-check the replacement API before terminating the previous VM process. A one-shot lock attempt leaves the replacement API healthy but Discord permanently disconnected.

**How to apply:** Retry only the expected lock-contention result. Unexpected database errors still fail startup, and losing an already-acquired lease still stops the process fail-closed.
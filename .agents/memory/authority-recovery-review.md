---
name: Authority and recovery review
description: Why moderation safety must be verified at lifecycle boundaries, not just command authorization.
---

Treat authorization, approval persistence, provider updates, and Discord restoration as separate failure boundaries during moderation reviews.

**Why:** Security-upgrade review repeatedly found cases that passed command permission tests but failed after a member left or a provider operation succeeded before the next local save. A shared role-operation lock alone does not prevent stale lifecycle state being written outside that lock.

**How to apply:** For future moderation changes, test interruption before and after each provider/local-store boundary, owner identity at every role-restoration sink, and rejoin during pending work. Do not treat a green Administrator/confirmation test suite as proof that recovery is safe.
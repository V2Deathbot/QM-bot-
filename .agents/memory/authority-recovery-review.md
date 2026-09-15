---
name: Authority and recovery review
description: Why moderation safety must be verified at lifecycle boundaries, not just command authorization.
---

Treat authorization, approval persistence, provider updates, and Discord restoration as separate failure boundaries during moderation reviews.

**Why:** Security-upgrade review repeatedly found cases that passed command permission tests but failed after a member left or a provider operation succeeded before the next local save. A shared role-operation lock alone does not prevent stale lifecycle state being written outside that lock.

**How to apply:** For future moderation changes, test interruption before and after each provider/local-store boundary, owner identity at every role-restoration sink, and rejoin during pending work. Do not treat a green Administrator/confirmation test suite as proof that recovery is safe.

Provider recovery must work independently of Discord membership; destructive confirmations must bind the exact provider record even when there is no saved role snapshot.

**Why:** Nonmember support exposed recovery that only ran after a member joined and confirmations that silently selected a replacement card. Happy-path tests did not reveal either gap.

**How to apply:** Test failed provider writes while the target remains absent through subsequent polls, and replacement records between confirmation and execution. For shared Discord identities, test overlapping restrictions and final-revocation role restoration.
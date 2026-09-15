---
name: Payout reset safety
description: Report delivery and destructive spreadsheet reset recovery boundaries.
---

Verify recovery of an already-performed reset against its target postconditions, not the old calculated payout totals.

**Why:** Clearing uniform rows legitimately recalculates the payout source. Requiring its old calculated fingerprint during verify-only recovery strands a successful reset.

**How to apply:** Before deletion require the approved source snapshot; after an uncertain deletion verify the exact archived target ranges are empty/unchecked without deleting again.

Report completion requires every planned DM page to be delivered or explicitly acknowledged.

**Why:** Acknowledging one uncertain page must not skip later unsent pages and permit deletion before the administrator has the full report. Discord's 6,000-character embed limit is aggregate per message.

**How to apply:** Persist each page independently. Atomically finalize reset completion, workbook generation, and lock release so crashes cannot leave a completed payout permanently locked.
---
name: Uniform ledger operation IDs
description: Keeping downstream spreadsheet mutations bound to the operation ID that reserved the original rows.
---

Downstream spreadsheet operations must use the exact operation ID under which the original rows were reserved, including any outcome suffix that separates successful and moderated rows.

**Why:** A published-shirt flow saved successful rows under a suffixed ID while purchase confirmation queried the base submission ID, making valid purchases fail as if trusted row metadata were missing.

**How to apply:** When one submission writes separate outcome batches, persist or deterministically derive each batch's ledger ID and use that same ID for Sold updates, replacements, and verification.
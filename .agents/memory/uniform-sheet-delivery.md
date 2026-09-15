---
name: Uniform spreadsheet delivery
description: Failure boundaries and existing-data safety for Sheets-backed uniform logging.
---

Treat spreadsheet persistence and Discord notification as separate outcomes; never infer notification delivery just because submission rows exist.

**Why:** Review found that an append could commit despite a transport error, leaving saved rows but no notification. Row deduplication alone would then suppress the missing notification on retry.

**How to apply:** Test uncertain append outcomes and failures between saving, sending, and recording delivery. Preserve submission identity across retries.

Check spreadsheet content using formula rendering before considering cells empty.

**Why:** A formula displaying an empty string is still user data and must not be overwritten by automatic headers.

**How to apply:** Include formula-empty cells in occupied-row safety tests. Merge configuration changes against the latest saved record after slow provider validation, not a previously read whole configuration.

Do not put operational bookkeeping or automatically generated headers in the uniform worksheets.

**Why:** The user supplies preformatted worksheets with a separate Sold checkbox column and explicitly wants only participant usernames and the uniform link. Extra metadata breaks that layout.

**How to apply:** Keep delivery tracking outside Sheets. Preserve headers and adjacent columns; never insert entire rows to log uniforms.
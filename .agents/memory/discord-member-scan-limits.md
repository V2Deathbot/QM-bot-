---
name: Discord member scan rate limits
description: Why bulk member reads must not rely on repeated Gateway requests.
---

Keep bulk member enumeration separate from fresh individual authorization checks. Prefer paginated REST enumeration with the client's rate-limit handling, and reuse one member list throughout a scan.

**Why:** Live startup and reconciliation issued multiple full Gateway member requests close together, producing GatewayRateLimitError while Trello readiness was healthy. Generic sync errors hid the real provider failure.

**How to apply:** When changing startup, lookup, or polling, avoid adding independent Gateway full-member fetches. Preserve forced fresh individual-member reads for authorization and safe stage-specific diagnostics without provider credentials.

Surface the Discord REST status and endpoint path when a member-list scan fails.

**Why:** A production audit reported a synchronization failure, but the old log retained only `HTTPError`, making a missing Server Members intent indistinguishable from rate limiting or a Discord outage.

**How to apply:** Keep request diagnostics limited to HTTP status, method, and path; never log authorization headers, request bodies, or full provider URLs.
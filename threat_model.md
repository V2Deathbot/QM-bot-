# Threat Model

## Project Overview

A Discord "Quartermaster" moderation bot (TypeScript, Node.js 24) living in the
pnpm monorepo artifact `artifacts/api-server`. It combines:

- A minimal Express 5 HTTP service (`src/app.ts`, `src/routes/`) exposing only
  `/api/healthz`, `/api/bot/status` (non-secret config/readiness), and
  `/api/bot/refresh` (intentionally hard-coded `403`).
- A discord.js bot (`src/bot/`) driving slash commands for Roblox-user
  blacklisting (Trello-backed), role removal/restoration, uniform-log delivery
  (Google Sheets + Discord channels), and Robux payout preview/reset.

Outbound integrations: Roblox API (user/group lookup), Trello REST API
(blacklist records), Google Sheets (uniform ledger + payout workbook). The
`artifacts/mockup-sandbox` artifact is design-only and not production.

## Assets

- **Provider credentials** — `DISCORD_BOT_TOKEN`, `TRELLO_API_KEY`/`TRELLO_TOKEN`,
  and the Google connector/service-account access. Compromise allows full
  impersonation of the bot and manipulation of blacklists, roles, and payouts.
- **Discord role state** — the bot removes and later restores members' roles.
  Incorrect enforcement can wrongly punish or wrongly clear a member.
- **Blacklist records** — Trello cards categorizing Roblox users; business- and
  moderation-sensitive.
- **Payout / uniform ledgers** — Google Sheets rows representing owed Robux and
  uniform-submission history; integrity failures allow double-pay or lost data.
- **Persisted security state** — per-guild rate limits, lockdown flags, observed
  admin escalations, and identity associations (`data/*.json` / DB-backed).

## Trust Boundaries

- **Discord gateway → bot** — the primary attacker surface. Slash-command
  options and interaction/button payloads come from guild members of varying
  privilege. All authorization is enforced server-side per interaction.
- **HTTP client → Express** — effectively no sensitive surface; no auth,
  no cookies/sessions, CORS `*`, but no sensitive endpoints. `/api/bot/refresh`
  is a hard 403 and cannot trigger bot mutations.
- **Bot → external APIs** — outbound calls to Roblox/Trello/Google carry secret
  credentials; responses are treated as untrusted input.
- **User / Admin boundary** — most commands require a *freshly fetched* Discord
  Administrator permission (or guild owner). Uniform logging is a separate,
  narrower authorization (configured Quartermaster roles / member IDs). Legacy
  moderator-role IDs never authorize commands.

## Scan Anchors

- Production entry points: `artifacts/api-server/src/index.ts` (HTTP + `startBot`),
  `src/routes/bot.ts`, and the discord.js interaction dispatch in
  `src/bot/index.ts` (`handleInteraction`, command switch ~lines 4060-4427).
- Highest-risk code: `src/bot/index.ts` (authorization, payout/uniform dispatch,
  security-state mutation), `src/bot/payout.ts` + `google-sheets.ts` (money /
  Sheets integrity), `src/bot/uniforms.ts` (uniform authz + delivery),
  `src/bot/trello.ts` + `blacklist-sync.ts` (enforcement correctness).
- Authorization helpers: `requireCurrentAdministrator` / `currentAdministrator`
  (`index.ts:501-526`), `requireUniformSubmitter` (`uniforms.ts`),
  `requirePayoutSafety` (`index.ts:~3846`), `reserveDestructiveAction`
  (`index.ts:561`).
- Dev-only / ignore unless proven reachable: `artifacts/mockup-sandbox/**`,
  `test/**`, generated code.

## Threat Categories

### Spoofing / Elevation of Privilege

Command authorization is enforced server-side on every interaction against a
freshly fetched Discord Administrator permission, not cached UI state or legacy
role IDs. Uniform and payout paths have their own scoped checks. Confirmations
(payout, destructive, maintenance) are bound to nonce + user + guild + message +
TTL and re-check Administrator at execution. The main residual weakness is the
**recent-permission-escalation delay**, which depends on an asynchronous
`GuildMemberUpdate` observation and can be raced (see
`.local/new_vulnerabilities/security-state-timing/`). Guarantee: destructive and
payout actions MUST verify current server-side privilege and SHOULD fail closed
when a just-observed privilege transition cannot be confirmed.

### Tampering / Business Logic

Payout follows a preview → confirm → report → clear ordering with durable
workbook locks, source-fingerprint and cell-content re-validation at confirm
time, atomic reset, and unknown-outcome recovery; amounts are strictly numeric
and totals cross-checked. Manual Trello edits are monitoring-only and never move
Discord roles; enforcement/restoration bind to exact Discord IDs. Guarantee:
payout and blacklist state changes MUST be validated against durable
authoritative records, never client-supplied amounts or stale previews.

### Information Disclosure

Audit output redacts configured secrets and neutralizes mentions; provider error
bodies are not echoed. Google/Trello/Discord credentials stay server-side and are
never returned by the HTTP status route. Guarantee: secrets and raw provider
error bodies MUST NOT appear in audit logs, Discord replies, or HTTP responses.

### Injection / SSRF

Trello and Sheets calls use URL/query encoding and parameterized form bodies;
spreadsheet IDs are restricted to Google Sheets hosts/safe IDs; Roblox lookups
send JSON bodies with validated numeric IDs. Uniform asset inputs are
canonicalized to allowlisted Roblox URLs with no server-side fetch, so there is
no SSRF or unsafe-upload path. Guarantee: outbound request components derived
from user input MUST remain encoded/allowlisted and MUST NOT be fetched
server-side without validation.

### Denial of Service

Per-admin and global destructive-action windows plus automatic lockdown throttle
abuse; Trello sync interval is clamped (15s–1h). The bot is not started when
required configuration is missing.

# Discord Roblox Blacklist Bot

A Discord moderation bot that looks up Roblox users, manages blacklist records in Trello, removes and restores Discord roles, and sends private status notifications.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secrets: `DISCORD_BOT_TOKEN`, `TRELLO_API_KEY`, `TRELLO_TOKEN`
- Required environment variables: `DISCORD_GUILD_ID`, `TRELLO_BOARD_ID`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot` — Discord commands, setup and audit persistence, Roblox API calls, Trello API client, and role snapshots
- `artifacts/api-server/src/routes/bot.ts` — non-secret bot configuration status endpoint
- `.env.example` — required and optional configuration names

## Architecture decisions

- The configured guild receives `/setup` and `/settings` until a valid audit channel is saved; blacklist commands are registered after setup and Trello readiness.
- Administrative authorization is based exclusively on a freshly fetched Discord `Administrator` permission (the server owner is recognized too). Legacy moderator-role IDs remain in setup JSON only for migration and never authorize commands.
- Audit delivery is verified before moderation side effects begin, then role and Trello changes are recorded without provider credentials or raw error bodies.
- Trello list names are configurable, while card names and descriptions follow the requested format exactly.
- Bot-approved command snapshots are the Discord enforcement source of truth. Trello is polled for monitoring, desync reports, and approved-record enforcement only; manual Trello cards/moves are audited but never add/remove Discord roles automatically.
- A role snapshot is persisted after the Trello card exists but before roles are removed. Pending enforcement and revocation states survive restarts, and the original assignable roles are preserved until restoration succeeds.
- Duplicate cards are resolved by latest Trello activity; revoked wins exact timestamp ties. Closed and group-list cards are excluded from individual-member enforcement.
- Full scans and member joins serialize changes per Discord member. Ambiguous identity matches are skipped and audited rather than risking incorrect removal or restoration.
- Per-admin and global destructive-action windows, lockdown state, observed permission escalations, and identity associations are stored atomically in `BOT_SECURITY_FILE` (default `data/guild-security.json`). Defaults are 3/admin and 8/global in five minutes, confirmation and automatic lockdown enabled.
- `/setup` uses administrator-bound, expiring Discord components for security, protected IDs/roles, audit channels, Trello monitoring, identity warnings, and blacklist-role controls. Every saved change is audited without credentials.
- The bot is deliberately not started when required configuration is missing; the API health endpoint remains available and the status route reports only missing names.

## Product

- `/blacklist user type reason` looks up the Roblox username, resolves or pings the Discord member, creates a categorized Trello card with `blacklisted` and type labels, persists a role snapshot, removes assignable roles, and DMs the Trello link.
- The `/settings` group-blacklist action creates a group URL card in the group blacklist list with a `- ` reason prefix and no Discord link preview.
- `/revoke_blacklist username` moves the user card to the revoked list, updates labels, restores saved roles, and DMs the revoked card link.
- `/setup` is administrator-only and opens the interactive configuration menu after first-time audit-channel setup. It can retain a legacy role field but no role tier grants command access.
- `/setup` persists per-guild Trello mappings for all five blacklist lists and six labels. Each mapping change (and reset) is validated against the configured board before it is saved; blacklist creation, group blacklist creation, lookup, revocation, and monitoring use the saved mapping rather than environment defaults.
- `/blacklist_lookup` is a slash command; the blacklist notes, synchronization report, identity lookup, and security/maintenance controls are available through `/settings`. The synchronization view is report-only.

## User preferences

- The user wants the bot to be easy to configure and use with Discord slash commands and Trello.

## Gotchas

- The Discord application must have the Server Members intent enabled because the bot fetches members and role snapshots.
- The bot's highest Discord role must be above the roles it is expected to remove and later restore.
- The bot needs View Channel, Send Messages, and Embed Links in the audit channel. Legacy role IDs in stored setup data are not required for blacklist readiness.
- Trello list names must match the configured names exactly, ignoring case and surrounding whitespace.
- `TRELLO_SYNC_INTERVAL_MS` controls polling and is clamped to a safe range of 15 seconds through 1 hour.
- `BOT_SECURITY_FILE` may be set to relocate persisted rate-limit/lockdown/identity state. The unauthenticated `POST /api/bot/refresh` endpoint intentionally returns 403; it cannot bypass Discord authorization.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

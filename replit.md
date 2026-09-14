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

- The configured guild receives only `/setup` until a valid moderator role and audit channel are saved; moderation commands are registered after setup.
- Moderation authorization is based on Discord role position, with the server owner and administrators always permitted.
- Audit delivery is verified before moderation side effects begin, then role and Trello changes are recorded without provider credentials or raw error bodies.
- Trello list names are configurable, while card names and descriptions follow the requested format exactly.
- Role snapshots are stored before Trello creation so a failed Trello request can restore roles and a later revoke can restore them after a restart.
- The bot is deliberately not started when required configuration is missing; the API health endpoint remains available and the status route reports only missing names.

## Product

- `/blacklist user type reason` looks up the Roblox username, resolves or pings the Discord member, removes assignable roles, creates a categorized Trello card with `blacklisted` and type labels, and DMs the Trello link.
- `/group_blacklist id reason` creates a group URL card in the group blacklist list with a `- ` reason prefix and no Discord link preview.
- `/revoke_blacklist username` moves the user card to the revoked list, updates labels, restores saved roles, and DMs the revoked card link.
- `/setup role audit_channel_id` lets the server owner or an administrator choose the minimum moderator role and the text channel used for audit records.

## User preferences

- The user wants the bot to be easy to configure and use with Discord slash commands and Trello.

## Gotchas

- The Discord application must have the Server Members intent enabled because the bot fetches members and role snapshots.
- The bot's highest Discord role must be above the roles it is expected to remove and later restore.
- The configured moderator role must be below the bot's highest role, and the bot needs View Channel, Send Messages, and Embed Links in the audit channel.
- Trello list names must match the configured names exactly, ignoring case and surrounding whitespace.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

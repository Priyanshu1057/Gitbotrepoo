# ZIP-to-GitHub Telegram Bot

A Telegram bot that lets approved users connect their own GitHub account, manage repositories, and safely sync ZIP contents into GitHub.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server and Telegram polling bot (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- Required secrets: `TELEGRAM_BOT_TOKEN`, `MONGODB_URI`, and `SESSION_SECRET` (or `BOT_TOKEN_ENCRYPTION_KEY`)
- Required env: `AUTHORIZED_TELEGRAM_USERS` — comma-separated bootstrap admin Telegram IDs
- Optional env: `MONGODB_DB_NAME`, ZIP safety limits, and webhook settings

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: MongoDB
- GitHub: REST API with per-user encrypted fine-grained tokens
- Build: esbuild (ESM bundle)

## Where things live

- `artifacts/api-server/src/telegram/bot.ts` — Telegram commands, callbacks, upload, and admin flows
- `artifacts/api-server/src/github/client.ts` — GitHub REST client and repository actions
- `artifacts/api-server/src/database/repository.ts` — MongoDB persistence and token encryption
- `artifacts/api-server/src/zip/safe-extract.ts` — ZIP traversal, symlink, size, and compression protections

## Architecture decisions

- Bootstrap admin IDs come from `AUTHORIZED_TELEGRAM_USERS`; all other access is stored in MongoDB and managed from `/users`.
- GitHub tokens are validated, removed from the incoming Telegram chat when possible, and encrypted with AES-256-GCM before storage.
- ZIP uploads default to root-level exact sync: matching paths are updated and tracked files missing from the ZIP are deleted in one commit.

## Product

- Per-user GitHub token setup through `/token`
- Admin authorization and revocation of Telegram users
- Repository browsing, creation, default selection, visibility changes, archive/unarchive, and deletion confirmation
- Safe ZIP uploads with branch, destination, commit message, and sync/merge choices
- Upload progress, cancellation, status, and configurable ZIP safety limits

## User preferences

- No shared hard-coded GitHub token: each user must connect their own GitHub account.

## Gotchas

- `SESSION_SECRET` is used as the encryption-key fallback when `BOT_TOKEN_ENCRYPTION_KEY` is not set; changing it makes existing encrypted tokens unreadable.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

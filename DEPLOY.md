# ZIP-to-GitHub Telegram Bot deployment

## Required environment

Set these values in the deployment environment. Do not commit them to the repository.

- `TELEGRAM_BOT_TOKEN` — token from BotFather
- `MONGODB_URI` — MongoDB connection string
- `SESSION_SECRET` or `BOT_TOKEN_ENCRYPTION_KEY` — stable secret used to encrypt saved GitHub tokens
- `AUTHORIZED_TELEGRAM_USERS` — comma-separated Telegram user IDs for the initial bootstrap admins

Optional settings:

- `MONGODB_DB_NAME` — defaults to `zip_to_github`
- `MAX_ZIP_SIZE_MB` — defaults to `500`
- `MAX_EXTRACTED_SIZE_MB` — defaults to `1000`
- `MAX_FILES_PER_ZIP` — defaults to `10000`
- `MAX_COMPRESSION_RATIO` — defaults to `1000`
- `TELEGRAM_WEBHOOK_URL` and `TELEGRAM_WEBHOOK_SECRET` — use these instead of polling when deploying behind a public HTTPS endpoint

Keep the encryption secret unchanged after users save GitHub tokens. Changing it makes existing encrypted tokens unreadable.

## Docker deployment

The repository is ready for Render, Koyeb, and VPS deployment with the included `Dockerfile`.

```bash
cp .env.example .env
# Fill in .env without committing it.
docker compose up -d --build
curl http://127.0.0.1:8080/api/healthz
```

- Render: use the included `render.yaml` Blueprint or connect the repository as a Docker service.
- Koyeb: connect the repository as a Dockerfile service; see `KOYEB.md`.
- VPS: use Docker Compose; see `VPS.md`.

## Manual build and run

```bash
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/api-server run build
NODE_ENV=production PORT=8080 node artifacts/api-server/dist/index.mjs
```

The health endpoint is:

```text
/api/healthz
```

After the bot starts, the bootstrap admin should open the bot and use `/token` to connect a GitHub token. Other users can then be approved from `/users`.
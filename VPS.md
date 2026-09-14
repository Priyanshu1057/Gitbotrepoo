# Deploy on a VPS

## Requirements

- Docker Engine and Docker Compose plugin
- A MongoDB deployment reachable from the VPS
- A Telegram bot token
- A stable public hostname if using Telegram webhooks

## Steps

```bash
cp .env.example .env
chmod 600 .env
# Edit .env and fill in the required values.
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8080/api/healthz
```

The bot runs with Telegram polling by default, so no inbound Telegram webhook route is required. Put the service behind Nginx, Caddy, or another TLS reverse proxy if you need a public HTTPS endpoint.

To inspect or update the service:

```bash
docker compose logs -f github-upload-telegram-bot
docker compose pull
docker compose up -d --build
```

Keep `.env` outside version control. Back up the MongoDB database and keep the encryption secret unchanged so saved GitHub tokens remain decryptable.
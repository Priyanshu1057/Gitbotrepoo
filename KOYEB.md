# Deploy on Koyeb

The repository includes a production `Dockerfile`, so Koyeb can deploy it as a Docker service.

## Dashboard

1. Create a new Koyeb App.
2. Choose **GitHub** as the deployment source and select this repository.
3. Set the builder to **Dockerfile** and keep the Dockerfile path as `/Dockerfile`.
4. Expose port `8080` over HTTP.
5. Add the required environment variables from `.env.example`.
6. Deploy the service.

The health check path is `/api/healthz`.

## CLI

After installing and authenticating the Koyeb CLI, create an app and deploy the GitHub repository. Select the Dockerfile builder:

```bash
koyeb app init github-upload-telegram-bot \
  --git https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY \
  --git-branch main \
  --git-builder docker \
  --type WEB \
  --ports 8080:http \
  --routes /:8080 \
  --env PORT=8080
```

Configure the required secrets in the Koyeb dashboard or with the CLI environment options. Do not put Telegram, MongoDB, or encryption secrets in this file.

Telegram polling is enabled by default. If using a public HTTPS URL with Telegram webhooks, set `TELEGRAM_WEBHOOK_URL` and `TELEGRAM_WEBHOOK_SECRET`.
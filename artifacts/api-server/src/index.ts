import app from "./app";
import { closeDatabase, connectDatabase } from "./database/mongodb";
import { logger } from "./lib/logger";
import { telegramBot } from "./telegram/runtime";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, "0.0.0.0", async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  try {
    await connectDatabase();
    await telegramBot.start();
    logger.info({ port, mode: process.env.TELEGRAM_WEBHOOK_URL ? "webhook" : "polling" }, "Server and Telegram bot ready");
  } catch (error) {
    logger.error({ err: error }, "Unable to start Telegram bot");
    process.exit(1);
  }
});

const shutdown = () => {
  telegramBot.stop();
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

import { Router, type IRouter } from "express";
import { telegramBot } from "../telegram/runtime";

const router: IRouter = Router();

router.post("/telegram/webhook", async (req, res) => {
  const expectedSecret = telegramBot["config"].telegramWebhookSecret;
  if (expectedSecret && req.header("x-telegram-bot-api-secret-token") !== expectedSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    await telegramBot.handleWebhookUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    req.log.error({ err: error }, "Telegram webhook update failed");
    res.sendStatus(500);
  }
});

export default router;
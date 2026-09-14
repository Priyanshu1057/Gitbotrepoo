import { loadConfig } from "../config/env";
import { TelegramBotService } from "./bot";

export const botConfig = loadConfig();
export const telegramBot = new TelegramBotService(botConfig);
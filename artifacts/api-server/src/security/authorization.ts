import type { BotConfig } from "../config/env";

export function isAuthorizedTelegramUser(config: BotConfig, userId: number | string): boolean {
  return config.bootstrapAdminTelegramUsers.has(String(userId));
}

export function isBootstrapAdmin(config: BotConfig, userId: number | string): boolean {
  return config.bootstrapAdminTelegramUsers.has(String(userId));
}

export function publicErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong while processing that request.";
}
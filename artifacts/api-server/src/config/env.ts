export type BotConfig = {
  telegramBotToken: string;
  bootstrapAdminTelegramUsers: Set<string>;
  mongoUri: string;
  mongoDatabaseName: string;
  tokenEncryptionKey: string;
  maxZipSizeBytes: number;
  maxFilesPerZip: number;
  maxExtractedSizeBytes: number;
  maxCompressionRatio: number;
  telegramWebhookUrl?: string;
  telegramWebhookSecret?: string;
};

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(): BotConfig {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const mongoUri = process.env.MONGODB_URI?.trim();
  const mongoDatabaseName = process.env.MONGODB_DB_NAME?.trim() || "zip_to_github";
  const tokenEncryptionKey = process.env.BOT_TOKEN_ENCRYPTION_KEY?.trim() || process.env.SESSION_SECRET?.trim();

  if (!telegramBotToken) throw new Error("TELEGRAM_BOT_TOKEN is required");
  if (!mongoUri) throw new Error("MONGODB_URI is required");
  if (!tokenEncryptionKey) throw new Error("BOT_TOKEN_ENCRYPTION_KEY or SESSION_SECRET is required");

  const bootstrapAdminTelegramUsers = new Set(
    (process.env.AUTHORIZED_TELEGRAM_USERS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^\d+$/.test(id)),
  );
  if (bootstrapAdminTelegramUsers.size === 0) {
    throw new Error("AUTHORIZED_TELEGRAM_USERS must contain at least one bootstrap admin Telegram user ID");
  }

  const maxZipSizeMb = positiveInteger("MAX_ZIP_SIZE_MB", 500);
  const maxExtractedSizeMb = positiveInteger("MAX_EXTRACTED_SIZE_MB", 1000);

  return {
    telegramBotToken,
    bootstrapAdminTelegramUsers,
    mongoUri,
    mongoDatabaseName,
    tokenEncryptionKey,
    maxZipSizeBytes: maxZipSizeMb * 1024 * 1024,
    maxFilesPerZip: positiveInteger("MAX_FILES_PER_ZIP", 10_000),
    maxExtractedSizeBytes: maxExtractedSizeMb * 1024 * 1024,
    maxCompressionRatio: positiveInteger("MAX_COMPRESSION_RATIO", 1_000),
    telegramWebhookUrl: process.env.TELEGRAM_WEBHOOK_URL?.trim() || undefined,
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || undefined,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (const candidate of units) {
    unit = candidate;
    if (value < 1024 || candidate === units.at(-1)) break;
    value /= 1024;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}
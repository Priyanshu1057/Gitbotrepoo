export type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
};

export type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
  document?: {
    file_id: string;
    file_name?: string;
    file_size?: number;
    mime_type?: string;
  };
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    data?: string;
    message?: TelegramMessage;
  };
};

type TelegramResponse<T> = { ok: boolean; result: T; description?: string };

export class TelegramApi {
  private readonly apiRoot: string;

  constructor(private readonly token: string) {
    this.apiRoot = `https://api.telegram.org/bot${token}`;
  }

  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.apiRoot}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !payload.ok) {
      throw new Error(`Telegram API ${method} failed: ${payload.description ?? response.statusText}`);
    }
    return payload.result;
  }

  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    return this.call("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message", "callback_query"],
    });
  }

  sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<TelegramMessage> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
      disable_web_page_preview: true,
    });
  }

  editMessageText(chatId: number, messageId: number, text: string): Promise<TelegramMessage> {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    return this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  }

  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<boolean> {
    return this.call("setMyCommands", { commands });
  }

  getFile(fileId: string): Promise<{ file_path?: string }> {
    return this.call("getFile", { file_id: fileId });
  }

  async downloadFile(filePath: string, destination: string, maxBytes: number): Promise<void> {
    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`);
    if (!response.ok || !response.body) {
      throw new Error(`Telegram file download failed with status ${response.status}`);
    }
    const { createWriteStream } = await import("node:fs");
    const { Transform } = await import("node:stream");
    const { pipeline } = await import("node:stream/promises");
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          callback(new Error(`The ZIP is larger than the configured ${Math.round(maxBytes / 1024 / 1024)} MB limit.`));
        } else {
          callback(null, chunk);
        }
      },
    });
    await pipeline(
      response.body as unknown as NodeJS.ReadableStream,
      limiter,
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
  }

  setWebhook(url: string, secretToken?: string): Promise<boolean> {
    return this.call("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message", "callback_query"],
    });
  }

  deleteWebhook(): Promise<boolean> {
    return this.call("deleteWebhook", { drop_pending_updates: false });
  }

  deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }
}
import { logger } from "./lib/logger";

interface TelegramUser {
  id: number;
}

interface TelegramChat {
  id: number;
}

interface TelegramMessage {
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
  };
}

const POLLING_TIMEOUT_SECONDS = 50;
const REQUEST_TIMEOUT_MS = 65_000;
const RETRY_DELAY_MS = 3_000;

const activeUsers = new Set<number>();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function callTelegram<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const result = (await response.json()) as TelegramApiResponse<T>;
  if (!response.ok || !result.ok || result.result === undefined) {
    const error = new Error(
      `Telegram ${method} failed with HTTP ${response.status}${
        result.error_code ? ` / API ${result.error_code}` : ""
      }${result.description ? `: ${result.description}` : ""}`,
    );
    Object.assign(error, {
      status: response.status,
      apiErrorCode: result.error_code,
      retryAfter: result.parameters?.retry_after,
    });
    throw error;
  }

  return result.result;
}

async function handleUpdate(
  token: string,
  update: TelegramUpdate,
): Promise<void> {
  const message = update.message;
  const userId = message?.from?.id;
  const text = message?.text?.trim();

  if (!message || userId === undefined || !text) {
    return;
  }

  if (/^\/offerteam(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
    await callTelegram(token, "sendMessage", {
      chat_id: message.chat.id,
      text: "Доступ открыт",
    });
    activeUsers.add(userId);
    logger.info({ userId }, "Telegram user access opened");
    return;
  }

  if (!activeUsers.has(userId)) {
    return;
  }

  // Feature-specific replies will be added once the user describes the workflow.
}

function getStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const status = error.status;
  return typeof status === "number" ? status : undefined;
}

function getRetryAfter(error: unknown): number | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("retryAfter" in error)
  ) {
    return undefined;
  }
  const retryAfter = error.retryAfter;
  return typeof retryAfter === "number" ? retryAfter : undefined;
}

async function pollTelegram(token: string): Promise<never> {
  const bot = await callTelegram<{
    id: number;
    username?: string;
  }>(token, "getMe", {});
  logger.info(
    { botUsername: bot.username },
    "Telegram bot connected; polling for messages",
  );

  let offset: number | undefined;

  while (true) {
    try {
      const updates = await callTelegram<TelegramUpdate[]>(
        token,
        "getUpdates",
        {
          ...(offset === undefined ? {} : { offset }),
          timeout: POLLING_TIMEOUT_SECONDS,
          allowed_updates: ["message"],
        },
      );

      for (const update of updates) {
        try {
          await handleUpdate(token, update);
        } catch (error) {
          logger.error(
            { err: error, updateId: update.update_id },
            "Failed to process Telegram update",
          );
        } finally {
          offset = update.update_id + 1;
        }
      }
    } catch (error) {
      const status = getStatus(error);
      if (status === 401 || status === 409) {
        throw error;
      }

      const retryAfter = getRetryAfter(error);
      const retryDelay = retryAfter
        ? retryAfter * 1_000
        : RETRY_DELAY_MS;
      logger.warn(
        { err: error, retryDelay },
        "Telegram polling failed; retrying",
      );
      await delay(retryDelay);
    }
  }
}

export function startTelegramBot(): void {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is required to start the Telegram bot.",
    );
  }

  void pollTelegram(token).catch((error: unknown) => {
    logger.error({ err: error }, "Telegram bot stopped");
    process.exit(1);
  });
}

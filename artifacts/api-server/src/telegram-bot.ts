import { logger } from "./lib/logger";
import { randomUUID } from "node:crypto";

interface TelegramUser {
  id: number;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  business_connection_id?: string;
}

interface TelegramBusinessConnection {
  id: string;
  user: TelegramUser;
  is_enabled: boolean;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
}

interface TelegramOffer {
  businessConnectionId: string;
  chatId: number;
  messageId: number;
  recipientUserId: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  business_connection?: TelegramBusinessConnection;
  business_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
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
const businessConnections = new Map<string, number>();
const pendingOffers = new Map<string, TelegramOffer>();

const OFFER_COMMAND =
  /^\/offer(?:@[A-Za-z0-9_]+)?(?:\s|$)/i;
const OFFER_FORMAT =
  /^\/offer(?:@[A-Za-z0-9_]+)?\s+(https:\/\/t\.me\/nft\/[A-Za-z0-9_-]+)\s+(\d+(?:[.,]\d+)?)\s+(stars?|gram)$/i;

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
  if (update.business_connection) {
    handleBusinessConnection(update.business_connection);
    return;
  }

  if (update.callback_query) {
    await handleCallbackQuery(token, update.callback_query);
    return;
  }

  if (update.business_message) {
    await handleBusinessMessage(token, update.business_message);
    return;
  }

  const message = update.message;
  const userId = message?.from?.id;
  const text = message?.text?.trim();

  if (!message || userId === undefined || !text) {
    return;
  }

  if (!/^\/offerteam(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
    return;
  }

  if (message.chat.type !== "private" || !isConnectedBusinessOwner(userId)) {
    return;
  }

  activeUsers.add(userId);
  await callTelegram(token, "sendMessage", {
    chat_id: message.chat.id,
    text: "Доступ открыт",
  });
  logger.info({ userId }, "Telegram business owner access opened");
}

function handleBusinessConnection(connection: TelegramBusinessConnection): void {
  if (connection.is_enabled) {
    businessConnections.set(connection.id, connection.user.id);
    logger.info(
      { userId: connection.user.id },
      "Telegram business connection enabled",
    );
    return;
  }

  businessConnections.delete(connection.id);
  activeUsers.delete(connection.user.id);
  logger.info(
    { userId: connection.user.id },
    "Telegram business connection disabled",
  );
}

function isConnectedBusinessOwner(userId: number): boolean {
  return [...businessConnections.values()].includes(userId);
}

async function handleBusinessMessage(
  token: string,
  message: TelegramMessage,
): Promise<void> {
  const userId = message.from?.id;
  const businessConnectionId = message.business_connection_id;
  const text = message.text?.trim();

  if (userId === undefined || !businessConnectionId || !text) {
    return;
  }

  const connection = await getBusinessConnection(token, businessConnectionId);
  if (!connection?.is_enabled || connection.user.id !== userId) {
    return;
  }

  if (/^\/offerteam(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
    activeUsers.add(userId);
    await callTelegram(token, "sendMessage", {
      business_connection_id: businessConnectionId,
      chat_id: message.chat.id,
      text: "Доступ открыт",
    });
    logger.info({ userId }, "Telegram business owner access opened");
    return;
  }

  if (!activeUsers.has(userId) || !OFFER_COMMAND.test(text)) {
    return;
  }

  if (message.chat.type !== "private") {
    await sendBusinessText(
      token,
      businessConnectionId,
      message.chat.id,
      "Команда /offer работает только в личном чате.",
    );
    return;
  }

  const match = OFFER_FORMAT.exec(text);
  if (!match) {
    await sendBusinessText(
      token,
      businessConnectionId,
      message.chat.id,
      "Формат: /offer https://t.me/nft/Collection-123 сумма stars|gram",
    );
    return;
  }

  const [, nftUrl, amountInput, currencyInput] = match;
  if (!nftUrl || !amountInput || !currencyInput) {
    return;
  }

  const amount = amountInput.replace(",", ".");
  const currency = currencyInput.toLowerCase();
  if (currency.startsWith("star") && !/^\d+$/.test(amount)) {
    await sendBusinessText(
      token,
      businessConnectionId,
      message.chat.id,
      "Количество Stars должно быть целым числом.",
    );
    return;
  }

  const title = getNftTitle(nftUrl);
  const offerId = randomUUID();
  const currencyLabel = currency.startsWith("star") ? "⭐" : "gram";
  const sentMessage = await callTelegram<TelegramMessage>(
    token,
    "sendMessage",
    {
      business_connection_id: businessConnectionId,
      chat_id: message.chat.id,
      text: `Пользователь предлагает Вам <b>${escapeHtml(amount)} ${currencyLabel}</b>\nза коллекционный предмет <a href="${escapeHtml(nftUrl)}">${escapeHtml(title)}</a>`,
      parse_mode: "HTML",
      link_preview_options: {
        url: nftUrl,
        prefer_large_media: true,
        show_above_text: true,
      },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✖ Отклонить",
              callback_data: `offer:reject:${offerId}`,
            },
            {
              text: "✓ Принять",
              callback_data: `offer:accept:${offerId}`,
            },
          ],
        ],
      },
    },
  );

  if (sentMessage.message_id === undefined) {
    throw new Error("Telegram did not return the sent offer message ID.");
  }

  pendingOffers.set(offerId, {
    businessConnectionId,
    chatId: message.chat.id,
    messageId: sentMessage.message_id,
    recipientUserId: message.chat.id,
  });

  if (message.message_id !== undefined) {
    await callTelegram(token, "deleteMessage", {
      business_connection_id: businessConnectionId,
      chat_id: message.chat.id,
      message_id: message.message_id,
    });
  }

  logger.info(
    { userId, chatId: message.chat.id, offerId },
    "Telegram NFT offer sent",
  );
}

async function getBusinessConnection(
  token: string,
  connectionId: string,
): Promise<TelegramBusinessConnection | undefined> {
  const cachedUserId = businessConnections.get(connectionId);
  if (cachedUserId !== undefined) {
    return {
      id: connectionId,
      user: { id: cachedUserId },
      is_enabled: true,
    };
  }

  try {
    const connection = await callTelegram<TelegramBusinessConnection>(
      token,
      "getBusinessConnection",
      { business_connection_id: connectionId },
    );
    if (connection.is_enabled) {
      businessConnections.set(connection.id, connection.user.id);
    }
    return connection;
  } catch (error) {
    logger.warn(
      { err: error },
      "Unable to verify Telegram business connection",
    );
    return undefined;
  }
}

async function sendBusinessText(
  token: string,
  businessConnectionId: string,
  chatId: number,
  text: string,
): Promise<void> {
  await callTelegram(token, "sendMessage", {
    business_connection_id: businessConnectionId,
    chat_id: chatId,
    text,
  });
}

function getNftTitle(nftUrl: string): string {
  const slug = new URL(nftUrl).pathname.split("/").at(-1) ?? "NFT";
  const match = /^(.*?)-(\d+)$/.exec(slug);
  const name = (match?.[1] ?? slug)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ");
  return match?.[2] ? `${name} #${match[2]}` : name;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function handleCallbackQuery(
  token: string,
  query: TelegramCallbackQuery,
): Promise<void> {
  const match = /^offer:(reject|accept):([0-9a-f-]{36})$/i.exec(
    query.data ?? "",
  );
  const action = match?.[1]?.toLowerCase();
  const offerId = match?.[2];
  const offer = offerId ? pendingOffers.get(offerId) : undefined;

  if (!offer || !action || !offerId) {
    await answerCallback(token, query.id, "Предложение больше недоступно.", true);
    return;
  }

  if (query.from.id !== offer.recipientUserId) {
    await answerCallback(
      token,
      query.id,
      "Эта кнопка доступна только получателю предложения.",
      true,
    );
    return;
  }

  if (action === "accept") {
    await answerCallback(
      token,
      query.id,
      "Действие кнопки «Принять» будет настроено по твоим следующим инструкциям.",
      true,
    );
    return;
  }

  try {
    await callTelegram(token, "editMessageReplyMarkup", {
      business_connection_id: offer.businessConnectionId,
      chat_id: offer.chatId,
      message_id: offer.messageId,
      reply_markup: { inline_keyboard: [] },
    });
    pendingOffers.delete(offerId);
    await answerCallback(token, query.id);
  } catch (error) {
    logger.error({ err: error, offerId }, "Failed to remove rejected offer buttons");
    await answerCallback(token, query.id, "Не удалось убрать кнопки.", true);
  }
}

async function answerCallback(
  token: string,
  callbackQueryId: string,
  text?: string,
  showAlert = false,
): Promise<void> {
  await callTelegram(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
    ...(showAlert ? { show_alert: true } : {}),
  });
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
          allowed_updates: [
            "message",
            "business_connection",
            "business_message",
            "callback_query",
          ],
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

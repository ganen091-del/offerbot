import {
  getTelegramOfferHistory,
} from "./telegram-store";

export const OFFERS_COMMAND = /^\/offers(?:@[A-Za-z0-9_]+)?(?:\s|$)/i;
const FORMAT = /^\/offers(?:@[A-Za-z0-9_]+)?\s+(\d{1,16})$/i;
type Transport = (method: string, payload: Record<string, unknown>) => Promise<unknown>;
interface HistoryMessage {
  message_id?: number;
  chat: { id: number; type: string };
}
interface HistoryCallback {
  id: string;
  from: { id: number };
  data?: string;
  message?: HistoryMessage;
}
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dates = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Kyiv", dateStyle: "short", timeStyle: "short",
});
const statuses: Record<string, string> = {
  pending: "Ожидает ответа",
  accepted: "Принят",
  rejected: "Отклонён",
};
const currencies: Record<string, string> = {
  stars: "Stars ⭐", gram: "Gram", rub: "RUB ₽", uah: "UAH ₴",
};

async function historyPayload(userId: number, page: number) {
  const history = await getTelegramOfferHistory(userId, page);
  const header = `<b>История отправленных офферов</b>\nTelegram ID: <code>${userId}</code>\nВсего: ${history.total}. Страница ${history.page + 1}/${history.pages}.\nВремя: Киев.`;
  const entries = history.offers.map((offer, index) => {
    const amount = offer.amount.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
    const title = escape(offer.nftTitle.slice(0, 100));
    return `${history.page * 5 + index + 1}. <a href="${escape(offer.nftUrl)}">${title}</a>\n` +
      `${dates.format(offer.createdAt)} · <b>${escape(amount)} ${escape(currencies[offer.currency] ?? offer.currency)}</b>\n` +
      `Статус: ${escape(statuses[offer.status] ?? offer.status)}\n` +
      `Получатель NFT: @${escape(offer.nftRecipientUsername)}`;
  });
  const buttons = [];
  if (history.page > 0) buttons.push({
    text: "← Назад", callback_data: `offers:${userId}:${history.page - 1}`,
  });
  if (history.page + 1 < history.pages) buttons.push({
    text: "Далее →", callback_data: `offers:${userId}:${history.page + 1}`,
  });
  return {
    text: `${header}\n\n${entries.length ? entries.join("\n\n") : "Сохранённых офферов нет."}`,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: buttons.length ? [buttons] : [] },
  };
}

export async function sendOfferHistory(
  send: Transport,
  chatId: number,
  text: string,
  authorized: boolean,
): Promise<void> {
  if (!authorized) {
    await send("sendMessage", {
      chat_id: chatId, text: "Команда /offers доступна только @owbixxxx.",
    });
    return;
  }
  const target = FORMAT.exec(text)?.[1];
  const userId = Number(target);
  if (!target || !Number.isSafeInteger(userId) || userId <= 0) {
    await send("sendMessage", {
      chat_id: chatId, text: "Формат: /offers <Telegram ID>\nНапример: /offers 123456789",
    });
    return;
  }
  await send("sendMessage", { chat_id: chatId, ...await historyPayload(userId, 0) });
}

export async function turnOfferHistoryPage(
  send: Transport,
  query: HistoryCallback,
  authorized: boolean,
): Promise<void> {
  const message = query.message;
  if (!authorized || message?.chat.type !== "private" || message.chat.id !== query.from.id) {
    await send("answerCallbackQuery", {
      callback_query_id: query.id, text: "История доступна только @owbixxxx в личке с ботом.",
      show_alert: true,
    });
    return;
  }
  const match = /^offers:(\d{1,16}):(\d{1,7})$/.exec(query.data ?? "");
  const userId = Number(match?.[1]);
  const page = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(userId) || userId <= 0 ||
      message.message_id === undefined) {
    await send("answerCallbackQuery", {
      callback_query_id: query.id, text: "Некорректная страница истории.",
    });
    return;
  }
  // Acknowledge before database work so the client does not spin indefinitely.
  await send("answerCallbackQuery", { callback_query_id: query.id });
  try {
    await send("editMessageText", {
      chat_id: message.chat.id, message_id: message.message_id,
      ...await historyPayload(userId, page),
    });
  } catch (error) {
    if (!(error instanceof Error && error.message.includes("message is not modified"))) throw error;
  }
}

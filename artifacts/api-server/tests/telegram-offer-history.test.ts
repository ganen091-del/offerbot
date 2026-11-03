import assert from "node:assert/strict";
import test from "node:test";
import { randomInt, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import {
  getTelegramOfferHistory,
  saveTelegramOffer,
} from "../src/telegram-store";
import { sendOfferHistory, turnOfferHistoryPage } from "../src/telegram-offer-history";

test("ID-only offer history without target activation, private authorization and pagination", async () => {
  assert.notEqual(process.env.NODE_ENV, "production");
  const userId = 8_200_000_000_000 + randomInt(1_000_000);
  const otherId = userId + 1;
  const adminId = userId + 2;
  const connectionId = `history-test-${userId}`;
  const calls: { method: string; payload: Record<string, any> }[] = [];
  const send = async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    return true;
  };
  const currencies = ["stars", "gram", "rub", "uah"] as const;
  try {
    for (let i = 0; i < 7; i++) {
      const id = randomUUID();
      await saveTelegramOffer({
        id, businessConnectionId: connectionId, chatId: otherId, messageId: i + 1,
        senderUserId: userId, recipientUserId: otherId,
        nftUrl: `https://t.me/nft/Example-${i + 1}`, nftTitle: `NFT ${i} <tag> & test`,
        nftRecipientUsername: "history_target", amount: "10.50", currency: currencies[i % 4]!,
      });
      await pool.query("UPDATE telegram_offers SET created_at = $1, status = $2 WHERE id = $3",
        [new Date(Date.UTC(2026, 0, i + 1)), ["pending", "accepted", "rejected"][i % 3], id]);
    }

    // The target has never activated or contacted the bot.
    const activation = await pool.query(
      "SELECT count(*) FROM telegram_access_users WHERE user_id = $1", [userId]);
    assert.equal(activation.rows[0].count, "0");

    calls.length = 0;
    await sendOfferHistory(send, adminId, `/offers ${userId}`, false);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.payload.text, /только @owbixxxx/);
    assert.ok(!calls[0]!.payload.text.includes("NFT"));
    calls.length = 0;
    await sendOfferHistory(send, adminId, "/offers", true);
    assert.match(calls[0]!.payload.text, /Формат/);
    calls.length = 0;
    await sendOfferHistory(send, adminId, "/offers @someone", true);
    assert.match(calls[0]!.payload.text, /Формат: \/offers <Telegram ID>/);

    calls.length = 0;
    await sendOfferHistory(send, adminId, `/offers ${userId}`, true);
    const first = calls[0]!.payload;
    assert.match(first.text, /Всего: 7. Страница 1\/2/);
    assert.match(first.text, /NFT 6 &lt;tag&gt; &amp; test/);
    assert.match(first.text, /10.5/);
    assert.match(first.text, /RUB|UAH|Gram|Stars/);
    assert.match(first.text, /Принят/);
    assert.match(first.text, /Отклонён/);
    assert.match(first.text, /Получатель NFT: @history_target/);
    assert.ok(first.text.length < 4096);
    assert.equal(first.reply_markup.inline_keyboard[0][0].callback_data, `offers:${userId}:1`);

    const callback = {
      id: "page", from: { id: adminId }, data: `offers:${userId}:1`,
      message: { message_id: 99, chat: { id: adminId, type: "private" } },
    };
    for (const variant of [
      { authorized: false, query: callback },
      { authorized: true, query: { ...callback, message: { ...callback.message, chat: { id: otherId, type: "private" } } } },
      { authorized: true, query: { ...callback, message: { ...callback.message, chat: { id: adminId, type: "group" } } } },
    ]) {
      calls.length = 0;
      await turnOfferHistoryPage(send, variant.query, variant.authorized);
      assert.equal(calls[0]!.method, "answerCallbackQuery");
      assert.ok(!calls.some((call) => call.method === "editMessageText"));
    }
    calls.length = 0;
    await turnOfferHistoryPage(send, callback, true);
    assert.equal(calls[0]!.method, "answerCallbackQuery");
    const second = calls[1]!.payload;
    assert.match(second.text, /Страница 2\/2/);
    assert.match(second.text, /NFT 0/);
    assert.ok(!second.text.includes("NFT 6"));
    assert.equal(second.reply_markup.inline_keyboard[0][0].callback_data, `offers:${userId}:0`);
    assert.equal((await getTelegramOfferHistory(userId, 999)).page, 1);

    assert.equal((await getTelegramOfferHistory(userId, 0)).total, 7);
    calls.length = 0;
    await sendOfferHistory(send, adminId, `/offers ${otherId}`, true);
    assert.match(calls[0]!.payload.text, /Сохранённых офферов нет/);
  } finally {
    await pool.query("DELETE FROM telegram_offers WHERE business_connection_id = $1", [connectionId]);
    await pool.end();
  }
});

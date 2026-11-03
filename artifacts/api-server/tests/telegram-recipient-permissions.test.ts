import assert from "node:assert/strict";
import test from "node:test";
import { randomInt } from "node:crypto";
import { pool } from "@workspace/db";
import { handleUpdate, processTelegramUpdate } from "../src/telegram-bot";
import {
  activateTelegramUser,
  hasTelegramRecipientPermission,
} from "../src/telegram-store";

test("admin recipient grants and per-offer routing (mock Telegram, development DB)", async () => {
  assert.notEqual(process.env.NODE_ENV, "production", "Never run against production");
  const base = 8_000_000_000_000 + randomInt(1_000_000);
  const adminId = base;
  const memberId = base + 1;
  const ordinaryId = base + 2;
  const recipientId = base + 3;
  const legacyId = base + 4;
  const username = `permtest_${base}`;
  const businessIds = [memberId, ordinaryId, legacyId].map((id) => `permission-test-${id}`);
  const calls: { method: string; payload: Record<string, any> }[] = [];
  const originalFetch = globalThis.fetch;
  let updateId = base;
  let messageId = 100;
  let ownerId = memberId;
  let reportErrors = false;
  let businessFailure: string | undefined;
  let businessFailureStatus = 400;

  globalThis.fetch = async (input, init) => {
    const method = String(input).split("/").at(-1)!;
    const payload = JSON.parse(String(init?.body));
    calls.push({ method, payload });
    if (method === "sendMessage" && payload.business_connection_id && businessFailure) {
      return new Response(JSON.stringify({
        ok: false, error_code: businessFailureStatus,
        description: businessFailure, parameters: { retry_after: 17 },
      }), { status: businessFailureStatus });
    }
    const result = method === "getBusinessConnection"
      ? { id: payload.business_connection_id, user: { id: ownerId }, is_enabled: true }
      : method === "sendMessage"
        ? { message_id: ++messageId, chat: { id: payload.chat_id, type: "private" } }
        : true;
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  async function command(id: number, fromUsername: string, text: string) {
    calls.length = 0;
    await handleUpdate("fake-test-token", {
      update_id: ++updateId,
      message: { from: { id, username: fromUsername }, chat: { id, type: "private" }, text },
    });
  }

  async function offer(id: number, fromUsername: string, suffix: string, currency = "stars", amount = "15") {
    calls.length = 0;
    ownerId = id;
    await (reportErrors ? processTelegramUpdate : handleUpdate)("fake-test-token", {
      update_id: ++updateId,
      business_message: {
        message_id: ++messageId,
        from: { id, username: fromUsername },
        chat: { id: recipientId, type: "private" },
        business_connection_id: `permission-test-${id}`,
        text: `/offer https://t.me/nft/Example-123 ${amount} ${currency}${suffix}`,
      },
    });
  }

  async function lastOffer() {
    const result = await pool.query(
      "SELECT * FROM telegram_offers WHERE sender_user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [ownerId],
    );
    return result.rows[0];
  }

  try {
    await command(adminId, "owbixxxx", `/dostup @${username}`);
    assert.equal(calls.length, 0, "activation gate remains in place");
    await Promise.all([adminId, memberId, ordinaryId].map(activateTelegramUser));

    await command(ordinaryId, "ordinary_test", `/dostup @${username}`);
    assert.match(calls[0]!.payload.text, /только администраторам/);
    assert.equal(await hasTelegramRecipientPermission(memberId, username), false);

    for (const formerAdmin of ["garantxnotcoin", "itzrealchartik"]) {
      await command(ordinaryId, formerAdmin, `/dostup @${username}`);
      assert.match(calls[0]!.payload.text, /только администраторам/);
      await command(ordinaryId, formerAdmin, `/add ${memberId} 15 stars`);
      assert.match(calls[0]!.payload.text, /только администраторам/);
    }

    await command(adminId, "OWBIXXXX", "/dostup invalid!");
    assert.match(calls[0]!.payload.text, /Формат/);
    await command(adminId, "OWBIXXXX", `/dostup @${username.toUpperCase()}`);
    assert.match(calls[0]!.payload.text, /Доступ.*выдан/);
    assert.equal(await hasTelegramRecipientPermission(memberId, username), true);
    await command(adminId, "owbixxxx", `/dostup ${username}`);
    assert.equal(await hasTelegramRecipientPermission(ordinaryId, username), false,
      "duplicate grants must not reset the bound identity");
    assert.equal(await hasTelegramRecipientPermission(memberId, "renamed_user"), true);

    for (const currency of ["stars", "gram", "rub", "uah"]) {
      await offer(memberId, "renamed_user", " @new_recipient", currency);
      const saved = await lastOffer();
      assert.equal(saved.nft_recipient_username, "new_recipient");
      assert.equal(saved.currency, currency);
      assert.ok(calls.some((call) => call.method === "deleteBusinessMessages"));
    }

    // Accepting an offer must use its stored destination, not a global setting.
    const acceptedOffer = await lastOffer();
    await command(adminId, "owbixxxx", `/add ${memberId} 15,50 UAH`);
    assert.match(calls.find((call) => call.method === "sendMessage")!.payload.text,
      /Начислено 15.5 uah/);
    calls.length = 0;
    await handleUpdate("fake-test-token", {
      update_id: ++updateId,
      callback_query: {
        id: "test-accept", from: { id: recipientId },
        data: `offer:accept:${acceptedOffer.id}`,
      },
    });
    const edited = calls.find((call) => call.method === "editMessageText")!;
    assert.equal(edited.payload.reply_markup.inline_keyboard[0][0].url,
      "tg://send_gift?to=new_recipient");
    assert.ok(calls.some((call) =>
      call.method === "answerCallbackQuery" && call.payload.text.includes("@new_recipient")));
    assert.ok(calls.some((call) =>
      call.method === "answerCallbackQuery" && call.payload.text.includes("₴")));
    const balance = await pool.query(
      "SELECT balance FROM telegram_balances WHERE user_id = $1 AND currency = 'uah'", [memberId]);
    assert.equal(Number(balance.rows[0].balance), 0.5);

    for (const invalidAmount of ["0", "1.234"]) {
      await command(adminId, "owbixxxx", `/add ${memberId} ${invalidAmount} uah`);
      assert.match(calls.find((call) => call.method === "sendMessage")!.payload.text, /Для UAH/);
      await offer(memberId, "renamed_user", "", "UAH", invalidAmount);
      assert.match(calls.find((call) => call.method === "sendMessage")!.payload.text, /Для UAH/);
    }
    await offer(memberId, "renamed_user", "", "UAH", "12,34");
    assert.equal((await lastOffer()).currency, "uah");
    assert.equal(Number((await lastOffer()).amount), 12.34);
    assert.ok(calls.some((call) => call.method === "sendMessage" && call.payload.text.includes("₴")));

    await offer(memberId, "renamed_user", "");
    assert.equal((await lastOffer()).nft_recipient_username, "GarantXNotcoin");
    await offer(ordinaryId, "ordinary_test", " @new_recipient");
    assert.match(calls.find((call) => call.method === "sendMessage")!.payload.text,
      /после выдачи администратором/);
    assert.equal(await lastOffer(), undefined);
    await offer(ordinaryId, "ordinary_test", "");
    assert.equal((await lastOffer()).nft_recipient_username, "GarantXNotcoin");

    await offer(legacyId, "vansLuo", "");
    assert.ok(!calls.some((call) => call.method === "sendMessage"),
      "the former whitelisted user must activate just like everyone else");
    await activateTelegramUser(legacyId);
    await offer(legacyId, "vansLuo", " @legacy_recipient");
    assert.match(calls.find((call) => call.method === "sendMessage")!.payload.text,
      /после выдачи администратором/);
    assert.equal(await lastOffer(), undefined);
    await offer(legacyId, "vansLuo", "");
    assert.equal((await lastOffer()).nft_recipient_username, "GarantXNotcoin");

    // Use a synthetic username for the grant so this test never claims a real
    // user's pending permission. Re-granted users follow the same normal path.
    const regrantUsername = `regrant_${base}`;
    await command(adminId, "owbixxxx", `/dostup @${regrantUsername}`);
    await offer(legacyId, regrantUsername, " @legacy_recipient");
    assert.equal((await lastOffer()).nft_recipient_username, "legacy_recipient");

    await command(adminId, "owbixxxx", "/offerteam");
    await command(ordinaryId, "ordinary_test", `/offers ${legacyId}`);
    assert.match(calls.find((call) => call.method === "sendMessage")!.payload.text,
      /доступна только @owbixxxx/);
    await command(adminId, "owbixxxx", `/offers ${legacyId}`);
    assert.match(calls.find((call) => call.method === "sendMessage")!.payload.text,
      /История отправленных офферов/);
    calls.length = 0;
    await handleUpdate("fake-test-token", {
      update_id: ++updateId,
      callback_query: {
        id: "unauthorized-history", from: { id: ordinaryId, username: "ordinary_test" },
        data: `offers:${legacyId}:0`,
        message: { message_id: 1, chat: { id: ordinaryId, type: "private" } },
      },
    });
    assert.ok(!calls.some((call) => call.method === "editMessageText"));
    assert.match(calls[0]!.payload.text, /только @owbixxxx/);

    reportErrors = true;
    businessFailure = "Bad Request: PEER_FLOOD";
    const before = await pool.query(
      "SELECT count(*) FROM telegram_offers WHERE sender_user_id = $1", [memberId]);
    await offer(memberId, "renamed_user", "");
    assert.ok(!calls.some((call) => call.method === "deleteBusinessMessages"));
    const notices = calls.filter((call) =>
      call.method === "sendMessage" && !call.payload.business_connection_id);
    assert.ok(notices.some((call) => call.payload.chat_id === memberId &&
      call.payload.text.includes("PEER_FLOOD")));
    assert.ok(notices.some((call) => call.payload.chat_id === adminId &&
      call.payload.text.includes("@SpamBot")));
    const after = await pool.query(
      "SELECT count(*) FROM telegram_offers WHERE sender_user_id = $1", [memberId]);
    assert.equal(after.rows[0].count, before.rows[0].count);
    await offer(memberId, "renamed_user", "");
    assert.ok(!calls.some((call) =>
      call.method === "sendMessage" && !call.payload.business_connection_id),
    "suppress repeated identical error alerts");

    businessFailure = "Too Many Requests";
    businessFailureStatus = 429;
    await offer(memberId, "renamed_user", "");
    assert.ok(calls.some((call) => call.method === "sendMessage" &&
      !call.payload.business_connection_id && call.payload.text.includes("17 сек")));

    businessFailure = "unexpected-private-detail-do-not-forward";
    businessFailureStatus = 400;
    await offer(memberId, "renamed_user", "");
    assert.ok(!calls.some((call) => call.method === "sendMessage" &&
      !call.payload.business_connection_id &&
      call.payload.text.includes("unexpected-private-detail-do-not-forward")));

    businessFailure = undefined;
    await offer(memberId, "renamed_user", "");
    assert.ok(calls.some((call) => call.method === "deleteBusinessMessages"),
      "normal offers must work again once Telegram accepts sends");
  } finally {
    globalThis.fetch = originalFetch;
    await pool.query("DELETE FROM telegram_balance_transactions WHERE user_id = ANY($1::bigint[])", [[memberId]]);
    await pool.query("DELETE FROM telegram_balances WHERE user_id = ANY($1::bigint[])", [[memberId]]);
    await pool.query("DELETE FROM telegram_offers WHERE business_connection_id = ANY($1::text[])", [businessIds]);
    await pool.query("DELETE FROM telegram_recipient_permissions WHERE granted_by_user_id = $1", [adminId]);
    await pool.query("DELETE FROM telegram_access_users WHERE user_id = ANY($1::bigint[])", [[adminId, memberId, ordinaryId, legacyId]]);
    await pool.query("DELETE FROM telegram_activity_admins WHERE user_id = $1", [adminId]);
    await pool.end();
  }
});

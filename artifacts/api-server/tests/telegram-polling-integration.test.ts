import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomInt } from "node:crypto";
import test from "node:test";
import { pool } from "@workspace/db";
import { pollTelegram } from "../src/telegram-bot";
import { runTelegramPolling } from "../src/telegram-polling-runtime";

test("real poller aborts getUpdates on session loss and resumes at the acknowledged offset", async () => {
  assert.notEqual(process.env.NODE_ENV, "production");
  const userId = 8_100_000_000_000 + randomInt(1_000_000);
  const stop = new AbortController();
  const originalFetch = globalThis.fetch;
  const events: string[] = [];
  const clients = Array.from({ length: 2 }, () => Object.assign(new EventEmitter(), {
    released: false,
    async query() { return { rows: [{ acquired: true }] }; },
    release(destroy: boolean) {
      assert.equal(destroy, true);
      this.released = true;
      this.emit("end");
    },
  }));
  let connects = 0;
  let gets = 0;
  let activeRequests = 0;
  let activationReplies = 0;
  globalThis.fetch = async (input, init) => {
    const method = String(input).split("/").at(-1);
    const payload = JSON.parse(String(init?.body));
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
    if (method === "getMe") return ok({ id: 1, username: "test_bot" });
    if (method === "sendMessage") {
      activationReplies++;
      return ok({ message_id: 1 });
    }
    assert.equal(method, "getUpdates");
    assert.equal(activeRequests, 0, "no overlapping getUpdates requests");
    if (++gets === 1) {
      return ok([{
        update_id: 77,
        message: {
          chat: { id: userId, type: "private" },
          from: { id: userId, username: "synthetic_test" },
          text: "/offerteam",
        },
      }]);
    }
    assert.equal(payload.offset, 78);
    if (gets === 2) {
      activeRequests++;
      const signal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          activeRequests--;
          reject(signal.reason);
        }, { once: true });
        queueMicrotask(() => clients[0]!.emit("error",
          Object.assign(new Error("test session termination"), { code: "57P01" })));
      });
    }
    assert.equal(gets, 3);
    stop.abort();
    return ok([]);
  };
  try {
    assert.doesNotThrow(() => pool.emit("error", new Error("test idle connection error")));
    await runTelegramPolling({
      signal: stop.signal,
      connect: async () => {
        if (connects) {
          assert.equal(activeRequests, 0);
          assert.equal(clients[connects - 1]!.released, true);
        }
        return clients[connects++]!;
      },
      poll: (signal, state, ready) => pollTelegram("fake-test-token", signal, state, ready),
      notify: async (event) => { events.push(event); },
      log: () => {},
      wait: async () => {},
    });
    assert.equal(connects, 2);
    assert.equal(gets, 3);
    assert.equal(activationReplies, 1, "do not replay the completed command on reconnect");
    assert.deepEqual(events, ["paused", "recovered"]);
  } finally {
    globalThis.fetch = originalFetch;
    await pool.query("DELETE FROM telegram_access_users WHERE user_id = $1", [userId]);
    await pool.end();
  }
});

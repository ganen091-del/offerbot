import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  runTelegramPolling,
  telegramRequestSignal,
  type PollingClient,
} from "../src/telegram-polling-runtime";

class FakeClient extends EventEmitter implements PollingClient {
  released = false;
  acquired = true;
  heartbeatFailure = false;
  hungHeartbeat = false;
  async query(text: string) {
    if (text === "SELECT 1") {
      if (this.heartbeatFailure) {
        throw Object.assign(new Error("administrative termination"), { code: "57P01" });
      }
      if (this.hungHeartbeat) return new Promise<{ rows: { acquired: boolean }[] }>(() => {});
    }
    return { rows: [{ acquired: this.acquired }] };
  }
  release(destroy: boolean) {
    assert.equal(destroy, true, "never return a session lock to the idle pool");
    assert.equal(this.released, false, "release once");
    this.released = true;
    this.emit("end");
  }
}

async function untilAborted(signal: AbortSignal): Promise<never> {
  signal.throwIfAborted();
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test("session errors cancel old requests before reacquiring; offsets survive", async () => {
  const stop = new AbortController();
  const clients = [new FakeClient(), new FakeClient()];
  const events: string[] = [];
  let connects = 0;
  let active = 0;
  await runTelegramPolling({
    signal: stop.signal,
    connect: async () => {
      assert.equal(active, 0, "the previous poller must have stopped");
      if (connects) assert.equal(clients[connects - 1]!.released, true);
      return clients[connects++]!;
    },
    poll: async (signal, state, ready) => {
      active++;
      try {
        await ready();
        if (connects === 1) {
          state.offset = 1234;
          const request = telegramRequestSignal(10_000);
          queueMicrotask(() => clients[0]!.emit("error",
            Object.assign(new Error("administrative termination"), { code: "57P01" })));
          await assert.rejects(untilAborted(request), /administrative termination/);
          assert.throws(() => telegramRequestSignal(10_000), /administrative termination/);
          signal.throwIfAborted();
        }
        assert.equal(state.offset, 1234);
        stop.abort();
      } finally {
        active--;
      }
    },
    notify: async (event) => { events.push(event); },
    log: () => {},
    wait: async () => {},
  });
  assert.equal(connects, 2);
  assert.deepEqual(events, ["paused", "recovered"]);
  assert.ok(clients.every((client) => client.released));
  // pg can emit a late socket error even after the lease is disposed.
  clients[0]!.emit("error", new Error("late error"));
});

test("a waiting replacement never polls while another VM owns the lock", async () => {
  const stop = new AbortController();
  const client = new FakeClient();
  client.acquired = false;
  await runTelegramPolling({
    signal: stop.signal,
    connect: async () => client,
    poll: async () => { assert.fail("must not poll without a lease"); },
    notify: async () => { assert.fail("normal lock contention is not an outage"); },
    log: () => { assert.fail("normal shutdown is not an error"); },
    wait: async () => { stop.abort(); },
  });
  assert.equal(client.released, true);
});

test("database retries survive even when an outage notification fails", async () => {
  const stop = new AbortController();
  const client = new FakeClient();
  const events: string[] = [];
  let connects = 0;
  await runTelegramPolling({
    signal: stop.signal,
    connect: async () => {
      if (++connects === 1) throw new Error("database unavailable");
      return client;
    },
    poll: async (_signal, _state, ready) => { await ready(); stop.abort(); },
    notify: async (event) => {
      events.push(event);
      if (event === "paused") throw new Error("Telegram notification unavailable");
    },
    log: () => {},
    wait: async () => {},
  });
  assert.equal(connects, 2);
  assert.deepEqual(events, ["paused", "recovered"]);
});

for (const mode of ["error", "timeout"] as const) {
  test(`heartbeat ${mode} invalidates ownership and reconnects`, async () => {
    const stop = new AbortController();
    const clients = [new FakeClient(), new FakeClient()];
    clients[0]!.heartbeatFailure = mode === "error";
    clients[0]!.hungHeartbeat = mode === "timeout";
    let connects = 0;
    await runTelegramPolling({
      signal: stop.signal,
      heartbeatMs: 1,
      heartbeatTimeoutMs: 10,
      connect: async () => clients[connects++]!,
      poll: async (signal, _state, ready) => {
        await ready();
        if (connects === 1) await untilAborted(signal);
        else stop.abort();
      },
      notify: async () => {},
      log: () => {},
      wait: async () => {},
    });
    assert.equal(connects, 2);
    assert.ok(clients.every((client) => client.released));
  });
}

test("invalid bot token remains actionable rather than retrying forever", async () => {
  const client = new FakeClient();
  let connects = 0;
  await assert.rejects(runTelegramPolling({
    connect: async () => { connects++; return client; },
    poll: async () => { throw Object.assign(new Error("invalid token"), { status: 401 }); },
    notify: async () => {},
    log: () => {},
    wait: async () => {},
  }), /invalid token/);
  assert.equal(connects, 1);
  assert.equal(client.released, true);
});

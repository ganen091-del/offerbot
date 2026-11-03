import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as sleep } from "node:timers/promises";

const requestContext = new AsyncLocalStorage<AbortSignal>();

export function telegramRequestSignal(timeoutMs: number): AbortSignal {
  const ownerSignal = requestContext.getStore();
  ownerSignal?.throwIfAborted();
  const timeout = AbortSignal.timeout(timeoutMs);
  return ownerSignal ? AbortSignal.any([ownerSignal, timeout]) : timeout;
}

export function currentPollingSignal(): AbortSignal | undefined {
  return requestContext.getStore();
}

export interface PollingClient {
  query(text: string, values: number[]): Promise<{ rows: { acquired: boolean }[] }>;
  on(event: string, listener: (error?: Error) => void): unknown;
  release(destroy: boolean): void;
}

export interface PollingState {
  offset?: number;
}

interface RuntimeOptions {
  connect: () => Promise<PollingClient>;
  poll: (signal: AbortSignal, state: PollingState, ready: () => Promise<void>) => Promise<void>;
  notify: (event: "paused" | "recovered", error?: unknown) => Promise<void>;
  log: (error: unknown) => void;
  signal?: AbortSignal;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
}

const wait = async (ms: number, signal?: AbortSignal) => {
  await sleep(ms, undefined, { signal });
};

async function acquireLease(options: RuntimeOptions) {
  options.signal?.throwIfAborted();
  const client = await options.connect();
  const ownership = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, ownership.signal])
    : ownership.signal;
  let disposed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  const lost = (error?: Error) => {
    if (!disposed) ownership.abort(error ?? new Error("Polling database session ended"));
  };
  // Keep these listeners on the destroyed client to consume late socket errors.
  client.on("error", lost);
  client.on("end", () => lost());
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ownership.abort(new Error("Polling lease released"));
    clearInterval(heartbeat);
    clearTimeout(heartbeatTimeout);
    // Session advisory locks must NEVER be returned to an idle pooled connection.
    client.release(true);
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await client.query(
        "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired",
        [0x54474c4b, 1],
      );
      signal.throwIfAborted();
      if (result.rows[0]?.acquired) break;
      await (options.wait ?? wait)(5_000, signal);
    }
    heartbeat = setInterval(() => {
      if (checking || signal.aborted) return;
      checking = true;
      heartbeatTimeout = setTimeout(
        () => lost(new Error("Polling database heartbeat timed out")),
        options.heartbeatTimeoutMs ?? 10_000,
      );
      void client.query("SELECT 1", []).catch(lost).finally(() => {
        clearTimeout(heartbeatTimeout);
        checking = false;
      });
    }, options.heartbeatMs ?? 20_000);
    return { signal, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

export async function runTelegramPolling(options: RuntimeOptions): Promise<void> {
  // Preserve acknowledgements across reconnects; do not replay completed commands.
  const state: PollingState = {};
  let recovering = false;
  let retryMs = 3_000;
  const notify = async (event: "paused" | "recovered", error?: unknown) => {
    try {
      await options.notify(event, error);
    } catch (notificationError) {
      options.log(notificationError);
    }
  };
  while (!options.signal?.aborted) {
    let lease: Awaited<ReturnType<typeof acquireLease>> | undefined;
    try {
      lease = await acquireLease(options);
      const signal = lease.signal;
      await requestContext.run(signal, () => options.poll(signal, state, async () => {
        signal.throwIfAborted();
        retryMs = 3_000;
        if (recovering) {
          recovering = false;
          await notify("recovered");
        }
      }));
      if (!options.signal?.aborted) throw new Error("Telegram poller stopped unexpectedly");
    } catch (error) {
      if (options.signal?.aborted) break;
      // An invalid/revoked token cannot be fixed by repeatedly reconnecting.
      if (typeof error === "object" && error !== null &&
          "status" in error && error.status === 401) throw error;
      options.log(error);
      recovering = true;
      // Outside requestContext: only direct notifications, never getUpdates,
      // may be attempted without the polling lease.
      await notify("paused", error);
    } finally {
      lease?.dispose();
    }
    try {
      await (options.wait ?? wait)(retryMs, options.signal);
    } catch (error) {
      if (!options.signal?.aborted) throw error;
    }
    retryMs = Math.min(retryMs * 2, 30_000);
  }
}

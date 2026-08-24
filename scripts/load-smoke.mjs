import { performance } from "node:perf_hooks";

import { createDefaultRouterConfig } from "../packages/config/dist/index.js";
import { createApp } from "../apps/gateway/dist/index.js";

const { fetch, AbortSignal } = globalThis;

const requestCount = positiveInteger(process.env.VARTMA_LOAD_REQUESTS, 400);
const concurrency = Math.min(
  requestCount,
  positiveInteger(process.env.VARTMA_LOAD_CONCURRENCY, 40),
);
const maximumP95Milliseconds = positiveInteger(process.env.VARTMA_LOAD_MAX_P95_MS, 2_000);

const config = createDefaultRouterConfig();
config.telemetry.logLevel = "fatal";
const server = await listen(createApp({ config }));

try {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Load-smoke gateway did not bind a TCP port.");
  }
  const url = `http://127.0.0.1:${String(address.port)}/v1/chat/completions`;
  const durations = [];
  const failures = [];
  let nextIndex = 0;
  const startedAt = performance.now();

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= requestCount) return;
        const requestStartedAt = performance.now();
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-vartma-session-id": `load-session-${String(index)}`,
            },
            body: JSON.stringify({
              model: "vartma-balanced",
              messages: [{ role: "user", content: `Return load marker ${String(index)}.` }],
              max_tokens: 32,
            }),
            signal: AbortSignal.timeout(10_000),
          });
          const body = await response.json();
          if (
            !response.ok ||
            response.headers.get("x-vartma-model") !== "fake/default" ||
            body?.object !== "chat.completion"
          ) {
            throw new Error(
              `HTTP ${String(response.status)}; route=${response.headers.get("x-vartma-model") ?? "missing"}`,
            );
          }
        } catch (error) {
          failures.push({ index, error: error instanceof Error ? error.message : String(error) });
        } finally {
          durations.push(performance.now() - requestStartedAt);
        }
      }
    }),
  );

  const elapsedMilliseconds = performance.now() - startedAt;
  const p95Milliseconds = percentile(durations, 0.95);
  const requestsPerSecond = requestCount / (elapsedMilliseconds / 1_000);
  if (failures.length > 0) {
    throw new Error(
      `${String(failures.length)} of ${String(requestCount)} load requests failed: ${JSON.stringify(failures.slice(0, 5))}`,
    );
  }
  if (p95Milliseconds > maximumP95Milliseconds) {
    throw new Error(
      `Load p95 ${p95Milliseconds.toFixed(1)}ms exceeded ${String(maximumP95Milliseconds)}ms.`,
    );
  }
  process.stdout.write(
    `Load smoke passed: ${String(requestCount)} requests, concurrency ${String(concurrency)}, ` +
      `${requestsPerSecond.toFixed(1)} req/s, p95 ${p95Milliseconds.toFixed(1)}ms, 0 failures.\n`,
  );
} finally {
  await close(server);
}

function positiveInteger(raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer, received "${raw}".`);
  }
  return value;
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function listen(expressApp) {
  return new Promise((resolveServer, reject) => {
    const listeningServer = expressApp.listen(0, "127.0.0.1", () => resolveServer(listeningServer));
    listeningServer.once("error", reject);
  });
}

function close(listeningServer) {
  return new Promise((resolveClose, reject) => {
    listeningServer.close((error) => (error ? reject(error) : resolveClose()));
  });
}

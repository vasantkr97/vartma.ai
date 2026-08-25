import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { createDefaultRouterConfig } from "../packages/config/dist/index.js";
import {
  checkDatabase,
  createDatabase,
  PrismaAttemptStore,
} from "../packages/database/dist/index.js";
import { createApp } from "../apps/gateway/dist/index.js";

const { fetch, AbortSignal } = globalThis;

const durationMilliseconds = positiveInteger(process.env.VARTMA_SOAK_DURATION_MS, 15 * 60 * 1_000);
const concurrency = positiveInteger(process.env.VARTMA_SOAK_CONCURRENCY, 20);
const targetRequestsPerSecond = positiveInteger(process.env.VARTMA_SOAK_TARGET_RPS, 20);
const minimumThroughputRatio = positiveNumber(process.env.VARTMA_SOAK_MIN_RPS_RATIO, 0.9);
if (minimumThroughputRatio > 1) {
  throw new Error("VARTMA_SOAK_MIN_RPS_RATIO must be at most 1.");
}
const maximumP95Milliseconds = positiveInteger(process.env.VARTMA_SOAK_MAX_P95_MS, 2_000);
const maximumEventLoopP99Milliseconds = positiveInteger(
  process.env.VARTMA_SOAK_MAX_EVENT_LOOP_P99_MS,
  500,
);
const maximumRssMegabytes = positiveInteger(process.env.VARTMA_SOAK_MAX_RSS_MB, 512);
const sessionPoolSize = positiveInteger(process.env.VARTMA_SOAK_SESSION_POOL, 100);
const runId = randomUUID();
const databaseUrl = process.env.DATABASE_URL?.trim();
const allowInMemory = process.env.VARTMA_SOAK_ALLOW_IN_MEMORY === "true";
if (!databaseUrl && !allowInMemory) {
  throw new Error(
    "Production soak requires DATABASE_URL and an applied Vartma schema. " +
      "Set VARTMA_SOAK_ALLOW_IN_MEMORY=true only for a short development calibration.",
  );
}

const config = createDefaultRouterConfig();
config.telemetry.logLevel = "fatal";
if (databaseUrl) {
  config.database.url = databaseUrl;
  config.database.requiredForReadiness = true;
  if (!process.env[config.credentials.masterKeyEnv]) {
    throw new Error(
      `PostgreSQL soak requires ${config.credentials.masterKeyEnv} for encrypted canonical history.`,
    );
  }
}
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
if (database) {
  try {
    await checkDatabase(database);
  } catch (error) {
    await database.$disconnect();
    throw error;
  }
}
let server;
try {
  server = await listen(
    createApp({
      config,
      ...(database ? { database, attemptStore: new PrismaAttemptStore(database) } : {}),
    }),
  );
} catch (error) {
  await database?.$disconnect();
  throw error;
}
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

try {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Soak gateway did not bind a TCP port.");
  }

  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  const requestUrl = `${baseUrl}/v1/chat/completions`;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, index) => {
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vartma-session-id": `soak-warmup-${runId}-${String(index)}`,
        },
        body: JSON.stringify({
          model: "vartma-balanced",
          messages: [{ role: "user", content: `Return warm-up marker ${String(index)}.` }],
          max_tokens: 32,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      await assertResponse(response, false);
    }),
  );
  const startedAt = performance.now();
  const deadline = startedAt + durationMilliseconds;
  const databaseBytesAtStart = database ? await databaseSizeBytes(database) : undefined;
  const rssAtStart = process.memoryUsage().rss;
  let maximumRss = rssAtStart;
  let nextRequestIndex = 0;
  let nextScheduledAt = startedAt;
  let failureCount = 0;
  const durations = [];
  const failures = [];

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const scheduledAt = nextScheduledAt;
        nextScheduledAt += 1_000 / targetRequestsPerSecond;
        if (scheduledAt >= deadline) return;
        await delay(Math.max(0, scheduledAt - performance.now()));
        if (performance.now() >= deadline) return;

        const index = nextRequestIndex++;
        const streaming = index % 5 === 0;
        const requestStartedAt = performance.now();
        try {
          const response = await fetch(requestUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-vartma-session-id": `soak-${runId}-${String(index % sessionPoolSize)}`,
            },
            body: JSON.stringify({
              model: "vartma-balanced",
              messages: [{ role: "user", content: `Return soak marker ${String(index)}.` }],
              max_tokens: 32,
              stream: streaming,
              ...(streaming ? { stream_options: { include_usage: true } } : {}),
            }),
            signal: AbortSignal.timeout(10_000),
          });
          await assertResponse(response, streaming);
        } catch (error) {
          failureCount += 1;
          if (failures.length < 20) {
            failures.push({
              index,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          durations.push(performance.now() - requestStartedAt);
          maximumRss = Math.max(maximumRss, process.memoryUsage().rss);
        }
      }
    }),
  );

  const elapsedMilliseconds = performance.now() - startedAt;
  const ready = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(5_000) });
  if (!ready.ok) {
    throw new Error(`Gateway readiness failed after soak with HTTP ${String(ready.status)}.`);
  }

  const p95Milliseconds = percentile(durations, 0.95);
  const requestsPerSecond = durations.length / (elapsedMilliseconds / 1_000);
  const eventLoopP99Milliseconds = eventLoopDelay.percentile(99) / 1_000_000;
  const maximumRssMegabytesObserved = maximumRss / 1024 / 1024;
  const rssGrowthMegabytes = (maximumRss - rssAtStart) / 1024 / 1024;
  const databaseGrowthMegabytes = database
    ? ((await databaseSizeBytes(database)) - databaseBytesAtStart) / 1024 / 1024
    : undefined;
  if (failureCount > 0) {
    throw new Error(
      `Soak had ${String(failureCount)} failed requests: ${JSON.stringify(failures.slice(0, 5))}`,
    );
  }
  if (p95Milliseconds > maximumP95Milliseconds) {
    throw new Error(
      `Soak p95 ${p95Milliseconds.toFixed(1)}ms exceeded ${String(maximumP95Milliseconds)}ms.`,
    );
  }
  if (requestsPerSecond < targetRequestsPerSecond * minimumThroughputRatio) {
    throw new Error(
      `Soak achieved ${requestsPerSecond.toFixed(1)} req/s, below ` +
        `${(minimumThroughputRatio * 100).toFixed(0)}% of the ${String(targetRequestsPerSecond)} req/s target.`,
    );
  }
  if (eventLoopP99Milliseconds > maximumEventLoopP99Milliseconds) {
    throw new Error(
      `Event-loop p99 ${eventLoopP99Milliseconds.toFixed(1)}ms exceeded ${String(maximumEventLoopP99Milliseconds)}ms.`,
    );
  }
  if (maximumRssMegabytesObserved > maximumRssMegabytes) {
    throw new Error(
      `Peak RSS ${maximumRssMegabytesObserved.toFixed(1)} MiB exceeded ${String(maximumRssMegabytes)} MiB.`,
    );
  }

  process.stdout.write(
    `Soak passed: ${String(durations.length)} requests in ${(elapsedMilliseconds / 1_000).toFixed(1)}s, ` +
      `${requestsPerSecond.toFixed(1)} req/s, ` +
      `p95 ${p95Milliseconds.toFixed(1)}ms, event-loop p99 ${eventLoopP99Milliseconds.toFixed(1)}ms, ` +
      `peak RSS ${maximumRssMegabytesObserved.toFixed(1)} MiB (${rssGrowthMegabytes.toFixed(1)} MiB growth), ` +
      `persistence ${database ? `PostgreSQL (${databaseGrowthMegabytes.toFixed(1)} MiB database growth)` : "in-memory development"}, ` +
      `0 failures.\n`,
  );
} finally {
  eventLoopDelay.disable();
  await close(server);
  await database?.$disconnect();
}

async function assertResponse(response, streaming) {
  if (!response.ok || response.headers.get("x-vartma-model") !== "fake/default") {
    const diagnostic = (await response.text()).slice(0, 500);
    throw new Error(
      `HTTP ${String(response.status)}; route=${response.headers.get("x-vartma-model") ?? "missing"}; ` +
        `body=${diagnostic || "empty"}`,
    );
  }
  if (streaming) {
    const body = await response.text();
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      throw new Error("Streaming response did not use text/event-stream.");
    }
    if (!body.includes('"finish_reason":"stop"') || !body.includes("data: [DONE]")) {
      throw new Error("Streaming response did not contain a terminal chunk and DONE marker.");
    }
    return;
  }
  const body = await response.json();
  if (body?.object !== "chat.completion" || body?.choices?.[0]?.finish_reason !== "stop") {
    throw new Error("Non-streaming response was incomplete.");
  }
}

function positiveInteger(raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer, received "${raw}".`);
  }
  return value;
}

function positiveNumber(raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected a positive number, received "${raw}".`);
  }
  return value;
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

async function databaseSizeBytes(database) {
  const rows = await database.$queryRaw`SELECT pg_database_size(current_database()) AS bytes`;
  const bytes = rows[0]?.bytes;
  const value = Number(bytes);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("PostgreSQL returned an invalid database size.");
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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

import { RequestStatus, type Prisma } from "./generated/prisma/client.js";

import type { RouterDatabase } from "./index.js";

export const USAGE_GROUPINGS = ["provider", "model", "routing_mode", "day"] as const;
export type UsageGrouping = (typeof USAGE_GROUPINGS)[number];

export interface UsageAnalyticsQuery {
  from: Date;
  to: Date;
  provider?: string;
  model?: string;
  routingMode?: string;
  sessionId?: string;
  groupBy: UsageGrouping;
}

export interface UsageAnalyticsReport {
  range: {
    from: string;
    to: string;
  };
  filters: {
    provider?: string;
    model?: string;
    routingMode?: string;
    sessionId?: string;
  };
  currency: "USD";
  totals: {
    requestCount: number;
    completedRequestCount: number;
    failedRequestCount: number;
    cancelledRequestCount: number;
    attemptCount: number;
    comparableRequestCount: number;
    inputTokens: string;
    cachedInputTokens: string;
    outputTokens: string;
    reasoningTokens: string;
    actualAttemptCostUsd: string;
    failedAttemptCostUsd: string;
    baselineCostUsd: string;
    savingsUsd: string;
    savingsPercent: string | null;
  };
  baselines: Array<{
    provider: string;
    model: string;
    priceBookVersion: string;
    requestCount: number;
    estimatedCostUsd: string;
  }>;
  distribution: Array<{
    key: string;
    requestCount: number;
    completedRequestCount: number;
    attemptCount: number;
    inputTokens: string;
    cachedInputTokens: string;
    outputTokens: string;
    reasoningTokens: string;
    actualAttemptCostUsd: string;
    failedAttemptCostUsd: string;
  }>;
}

export interface RequestUsageReport {
  requestId: string;
  sessionId: string | null;
  routingMode: string;
  status: string;
  selectedProvider: string | null;
  selectedModel: string | null;
  startedAt: string;
  completedAt: string | null;
  baseline: {
    provider: string;
    model: string;
    upstreamModel: string;
    inputTokens: number;
    expectedOutputTokens: number;
    estimatedCostUsd: string;
    currency: string;
    priceBookVersion: string;
  } | null;
  attempts: Array<{
    attemptId: string | null;
    sequence: number | null;
    provider: string;
    model: string;
    upstreamModel: string;
    status: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    toolCostUsd: string;
    calculatedCostUsd: string;
    currency: string;
    priceBookVersion: string;
    pricesPerMillion: {
      input: string;
      cachedInput: string;
      output: string;
      reasoning: string;
    };
    pricingSource: string;
    pricingEffectiveFrom: string;
    pricingVerifiedAt: string;
    createdAt: string;
  }>;
  totals: {
    actualAttemptCostUsd: string;
    failedAttemptCostUsd: string;
    baselineCostUsd: string | null;
    savingsUsd: string | null;
    savingsPercent: string | null;
  };
}

export interface UsageAnalyticsStore {
  query(input: UsageAnalyticsQuery): Promise<UsageAnalyticsReport>;
  request(requestId: string): Promise<RequestUsageReport | undefined>;
}

interface MutableTotals {
  requestCount: number;
  completedRequestCount: number;
  failedRequestCount: number;
  cancelledRequestCount: number;
  attemptCount: number;
  comparableRequestCount: number;
  inputTokens: bigint;
  cachedInputTokens: bigint;
  outputTokens: bigint;
  reasoningTokens: bigint;
  actualCost: bigint;
  failedAttemptCost: bigint;
  baselineCost: bigint;
  comparableActualCost: bigint;
}

interface MutableDistribution {
  requestIds: Set<string>;
  completedRequestIds: Set<string>;
  attemptCount: number;
  inputTokens: bigint;
  cachedInputTokens: bigint;
  outputTokens: bigint;
  reasoningTokens: bigint;
  actualCost: bigint;
  failedAttemptCost: bigint;
}

interface MutableBaseline {
  provider: string;
  model: string;
  priceBookVersion: string;
  requestCount: number;
  estimatedCost: bigint;
}

const PAGE_SIZE = 500;
const COST_SCALE = 12;

export class PrismaUsageAnalyticsStore implements UsageAnalyticsStore {
  public constructor(private readonly database: RouterDatabase) {}

  public async query(input: UsageAnalyticsQuery): Promise<UsageAnalyticsReport> {
    const totals = emptyTotals();
    const distribution = new Map<string, MutableDistribution>();
    const baselines = new Map<string, MutableBaseline>();
    let cursor: string | undefined;

    while (true) {
      const requests = await this.database.request.findMany({
        where: requestWhere(input),
        orderBy: [{ startedAt: "asc" }, { id: "asc" }],
        take: PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: {
          costBaseline: true,
          usageEvents: true,
        },
      });
      for (const request of requests) {
        aggregateRequest(totals, distribution, baselines, request, input.groupBy);
      }
      if (requests.length < PAGE_SIZE) {
        break;
      }
      cursor = requests.at(-1)?.id;
      if (!cursor) {
        break;
      }
    }

    const savings = totals.baselineCost - totals.comparableActualCost;
    return {
      range: {
        from: input.from.toISOString(),
        to: input.to.toISOString(),
      },
      filters: {
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.routingMode ? { routingMode: input.routingMode } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      },
      currency: "USD",
      totals: {
        requestCount: totals.requestCount,
        completedRequestCount: totals.completedRequestCount,
        failedRequestCount: totals.failedRequestCount,
        cancelledRequestCount: totals.cancelledRequestCount,
        attemptCount: totals.attemptCount,
        comparableRequestCount: totals.comparableRequestCount,
        inputTokens: totals.inputTokens.toString(),
        cachedInputTokens: totals.cachedInputTokens.toString(),
        outputTokens: totals.outputTokens.toString(),
        reasoningTokens: totals.reasoningTokens.toString(),
        actualAttemptCostUsd: scaledToString(totals.actualCost),
        failedAttemptCostUsd: scaledToString(totals.failedAttemptCost),
        baselineCostUsd: scaledToString(totals.baselineCost),
        savingsUsd: scaledToString(savings),
        savingsPercent: percentage(savings, totals.baselineCost),
      },
      baselines: [...baselines.values()]
        .map((baseline) => ({
          provider: baseline.provider,
          model: baseline.model,
          priceBookVersion: baseline.priceBookVersion,
          requestCount: baseline.requestCount,
          estimatedCostUsd: scaledToString(baseline.estimatedCost),
        }))
        .sort((left, right) =>
          `${left.provider}/${left.model}/${left.priceBookVersion}`.localeCompare(
            `${right.provider}/${right.model}/${right.priceBookVersion}`,
          ),
        ),
      distribution: [...distribution.entries()]
        .map(([key, value]) => ({
          key,
          requestCount: value.requestIds.size,
          completedRequestCount: value.completedRequestIds.size,
          attemptCount: value.attemptCount,
          inputTokens: value.inputTokens.toString(),
          cachedInputTokens: value.cachedInputTokens.toString(),
          outputTokens: value.outputTokens.toString(),
          reasoningTokens: value.reasoningTokens.toString(),
          actualAttemptCostUsd: scaledToString(value.actualCost),
          failedAttemptCostUsd: scaledToString(value.failedAttemptCost),
        }))
        .sort(
          (left, right) =>
            right.requestCount - left.requestCount || left.key.localeCompare(right.key),
        ),
    };
  }

  public async request(requestId: string): Promise<RequestUsageReport | undefined> {
    const request = await this.database.request.findUnique({
      where: { id: requestId },
      include: {
        costBaseline: true,
        usageEvents: {
          orderBy: { createdAt: "asc" },
          include: {
            providerAttempt: {
              select: {
                sequence: true,
              },
            },
          },
        },
      },
    });
    if (!request) {
      return undefined;
    }
    let actual = 0n;
    let failed = 0n;
    const attempts = request.usageEvents.map((usage) => {
      const cost = decimalToScaled(usage.estimatedCost) + decimalToScaled(usage.toolCost);
      actual += cost;
      if (usage.attemptStatus !== "COMPLETED") {
        failed += cost;
      }
      return {
        attemptId: usage.providerAttemptId,
        sequence: usage.providerAttempt?.sequence ?? null,
        provider: usage.provider,
        model: usage.model,
        upstreamModel: usage.upstreamModel,
        status: usage.attemptStatus,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        toolCostUsd: usage.toolCost.toString(),
        calculatedCostUsd: usage.estimatedCost.toString(),
        currency: usage.currency,
        priceBookVersion: usage.priceBookVersion,
        pricesPerMillion: {
          input: usage.inputPricePerMillion.toString(),
          cachedInput: usage.cachedInputPricePerMillion.toString(),
          output: usage.outputPricePerMillion.toString(),
          reasoning: usage.reasoningPricePerMillion.toString(),
        },
        pricingSource: usage.pricingSource,
        pricingEffectiveFrom: dateString(usage.pricingEffectiveFrom),
        pricingVerifiedAt: dateString(usage.pricingVerifiedAt),
        createdAt: usage.createdAt.toISOString(),
      };
    });
    const baselineCost = request.costBaseline
      ? decimalToScaled(request.costBaseline.estimatedCost)
      : undefined;
    const savings = baselineCost === undefined ? undefined : baselineCost - actual;
    return {
      requestId: request.id,
      sessionId: request.sessionId,
      routingMode: request.routingMode,
      status: request.status,
      selectedProvider: request.selectedProvider,
      selectedModel: request.selectedModel,
      startedAt: request.startedAt.toISOString(),
      completedAt: request.completedAt?.toISOString() ?? null,
      baseline: request.costBaseline
        ? {
            provider: request.costBaseline.provider,
            model: request.costBaseline.model,
            upstreamModel: request.costBaseline.upstreamModel,
            inputTokens: request.costBaseline.inputTokens,
            expectedOutputTokens: request.costBaseline.expectedOutputTokens,
            estimatedCostUsd: request.costBaseline.estimatedCost.toString(),
            currency: request.costBaseline.currency,
            priceBookVersion: request.costBaseline.priceBookVersion,
          }
        : null,
      attempts,
      totals: {
        actualAttemptCostUsd: scaledToString(actual),
        failedAttemptCostUsd: scaledToString(failed),
        baselineCostUsd: baselineCost === undefined ? null : scaledToString(baselineCost),
        savingsUsd: savings === undefined ? null : scaledToString(savings),
        savingsPercent:
          savings === undefined || baselineCost === undefined
            ? null
            : percentage(savings, baselineCost),
      },
    };
  }
}

function requestWhere(input: UsageAnalyticsQuery): Prisma.RequestWhereInput {
  return {
    startedAt: {
      gte: input.from,
      lt: input.to,
    },
    status: {
      in: [RequestStatus.COMPLETED, RequestStatus.FAILED, RequestStatus.CANCELLED],
    },
    ...(input.routingMode ? { routingMode: input.routingMode } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.provider || input.model
      ? {
          usageEvents: {
            some: {
              ...(input.provider ? { provider: input.provider } : {}),
              ...(input.model ? { model: input.model } : {}),
            },
          },
        }
      : {}),
  };
}

function aggregateRequest(
  totals: MutableTotals,
  distribution: Map<string, MutableDistribution>,
  baselines: Map<string, MutableBaseline>,
  request: {
    id: string;
    status: string;
    routingMode: string;
    startedAt: Date;
    costBaseline: {
      provider: string;
      model: string;
      priceBookVersion: string;
      estimatedCost: { toString(): string };
    } | null;
    usageEvents: Array<{
      provider: string;
      model: string;
      attemptStatus: string;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      estimatedCost: { toString(): string };
      toolCost: { toString(): string };
    }>;
  },
  groupBy: UsageGrouping,
): void {
  totals.requestCount += 1;
  if (request.status === "COMPLETED") {
    totals.completedRequestCount += 1;
  } else if (request.status === "CANCELLED") {
    totals.cancelledRequestCount += 1;
  } else if (request.status === "FAILED") {
    totals.failedRequestCount += 1;
  }

  let requestActualCost = 0n;
  for (const usage of request.usageEvents) {
    const cost = decimalToScaled(usage.estimatedCost) + decimalToScaled(usage.toolCost);
    requestActualCost += cost;
    totals.attemptCount += 1;
    totals.inputTokens += BigInt(usage.inputTokens);
    totals.cachedInputTokens += BigInt(usage.cachedInputTokens);
    totals.outputTokens += BigInt(usage.outputTokens);
    totals.reasoningTokens += BigInt(usage.reasoningTokens);
    totals.actualCost += cost;
    if (usage.attemptStatus !== "COMPLETED") {
      totals.failedAttemptCost += cost;
    }
    if (groupBy === "provider" || groupBy === "model") {
      addDistributionUsage(
        distribution,
        groupBy === "provider" ? usage.provider : usage.model,
        request,
        usage,
        cost,
      );
    }
  }
  if (groupBy === "routing_mode" || groupBy === "day") {
    addDistributionRequest(
      distribution,
      groupBy === "routing_mode" ? request.routingMode : dateString(request.startedAt),
      request,
      requestActualCost,
    );
  }

  if (request.costBaseline) {
    const baselineCost = decimalToScaled(request.costBaseline.estimatedCost);
    totals.comparableRequestCount += 1;
    totals.baselineCost += baselineCost;
    totals.comparableActualCost += requestActualCost;
    const key = `${request.costBaseline.provider}\u0000${request.costBaseline.model}\u0000${request.costBaseline.priceBookVersion}`;
    const baseline = baselines.get(key) ?? {
      provider: request.costBaseline.provider,
      model: request.costBaseline.model,
      priceBookVersion: request.costBaseline.priceBookVersion,
      requestCount: 0,
      estimatedCost: 0n,
    };
    baseline.requestCount += 1;
    baseline.estimatedCost += baselineCost;
    baselines.set(key, baseline);
  }
}

function addDistributionUsage(
  distribution: Map<string, MutableDistribution>,
  key: string,
  request: { id: string; status: string },
  usage: {
    attemptStatus: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  },
  cost: bigint,
): void {
  const value = distribution.get(key) ?? emptyDistribution();
  value.requestIds.add(request.id);
  if (request.status === "COMPLETED") {
    value.completedRequestIds.add(request.id);
  }
  value.attemptCount += 1;
  value.inputTokens += BigInt(usage.inputTokens);
  value.cachedInputTokens += BigInt(usage.cachedInputTokens);
  value.outputTokens += BigInt(usage.outputTokens);
  value.reasoningTokens += BigInt(usage.reasoningTokens);
  value.actualCost += cost;
  if (usage.attemptStatus !== "COMPLETED") {
    value.failedAttemptCost += cost;
  }
  distribution.set(key, value);
}

function addDistributionRequest(
  distribution: Map<string, MutableDistribution>,
  key: string,
  request: {
    id: string;
    status: string;
    usageEvents: Array<{
      attemptStatus: string;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      estimatedCost: { toString(): string };
      toolCost: { toString(): string };
    }>;
  },
  actualCost: bigint,
): void {
  const value = distribution.get(key) ?? emptyDistribution();
  value.requestIds.add(request.id);
  if (request.status === "COMPLETED") {
    value.completedRequestIds.add(request.id);
  }
  value.attemptCount += request.usageEvents.length;
  value.actualCost += actualCost;
  for (const usage of request.usageEvents) {
    value.inputTokens += BigInt(usage.inputTokens);
    value.cachedInputTokens += BigInt(usage.cachedInputTokens);
    value.outputTokens += BigInt(usage.outputTokens);
    value.reasoningTokens += BigInt(usage.reasoningTokens);
    if (usage.attemptStatus !== "COMPLETED") {
      value.failedAttemptCost +=
        decimalToScaled(usage.estimatedCost) + decimalToScaled(usage.toolCost);
    }
  }
  distribution.set(key, value);
}

function emptyTotals(): MutableTotals {
  return {
    requestCount: 0,
    completedRequestCount: 0,
    failedRequestCount: 0,
    cancelledRequestCount: 0,
    attemptCount: 0,
    comparableRequestCount: 0,
    inputTokens: 0n,
    cachedInputTokens: 0n,
    outputTokens: 0n,
    reasoningTokens: 0n,
    actualCost: 0n,
    failedAttemptCost: 0n,
    baselineCost: 0n,
    comparableActualCost: 0n,
  };
}

function emptyDistribution(): MutableDistribution {
  return {
    requestIds: new Set<string>(),
    completedRequestIds: new Set<string>(),
    attemptCount: 0,
    inputTokens: 0n,
    cachedInputTokens: 0n,
    outputTokens: 0n,
    reasoningTokens: 0n,
    actualCost: 0n,
    failedAttemptCost: 0n,
  };
}

function decimalToScaled(value: {
  toString(): string;
  toFixed?: (places: number) => string;
}): bigint {
  const text = value.toFixed?.(COST_SCALE) ?? value.toString();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(text);
  if (!match) {
    throw new Error("A stored monetary value is not a plain decimal.");
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]!);
  const fraction = (match[3] ?? "").padEnd(COST_SCALE, "0").slice(0, COST_SCALE);
  return sign * (whole * 10n ** BigInt(COST_SCALE) + BigInt(fraction || "0"));
}

function scaledToString(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const scale = 10n ** BigInt(COST_SCALE);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(COST_SCALE, "0").replace(/0+$/u, "");
  return `${sign}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

function percentage(numerator: bigint, denominator: bigint): string | null {
  if (denominator === 0n) {
    return null;
  }
  const basisPoints = (numerator * 1_000_000n) / denominator;
  return (Number(basisPoints) / 10_000).toFixed(4);
}

function dateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

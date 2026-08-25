import type { ModelPricing, TokenEstimate, TokenUsage } from "@vartma/canonical";

import type { Prisma } from "./generated/prisma/client.js";
import type { RouterDatabase } from "./index.js";

export interface PriceSnapshotInput {
  priceBookVersion: string;
  provider: string;
  model: string;
  upstreamModel: string;
  pricing: ModelPricing;
}

export interface RequestCostBaselineInput extends PriceSnapshotInput {
  tokenEstimate: TokenEstimate;
  estimatedCostUsd: number;
}

export interface StoredRouteDecisionInput {
  routerVersion: string;
  taskClass: string;
  selectedProvider: string;
  selectedModel: string;
  explanation: Prisma.InputJsonValue;
  candidates: Prisma.InputJsonValue;
}

export interface StartAttemptInput {
  requestId: string;
  sessionId?: string;
  clientRequestId?: string;
  requestedModel?: string;
  selectedProvider: string;
  selectedModel: string;
  upstreamModel: string;
  routingMode: string;
  metadata: Record<string, string>;
  routeDecision?: StoredRouteDecisionInput;
  costBaseline?: RequestCostBaselineInput;
  initialSwitch?: {
    fromProvider: string;
    fromModel: string;
    toProvider: string;
    toModel: string;
    reason: string;
    trigger: string;
  };
}

export interface CompleteAttemptInput {
  requestId: string;
  attemptId: string;
  provider: string;
  model: string;
  upstreamModel: string;
  usage: TokenUsage;
  estimatedCostUsd: number;
  priceBookVersion: string;
  pricing: ModelPricing;
}

export interface StartFallbackAttemptInput {
  requestId: string;
  fromProvider: string;
  fromModel: string;
  selectedProvider: string;
  selectedModel: string;
  upstreamModel: string;
  reason: string;
  trigger: string;
}

export interface FailAttemptInput {
  requestId: string;
  attemptId: string;
  status: "FAILED" | "CANCELLED";
  errorType: string;
  errorMessage: string;
  provider: string;
  model: string;
  upstreamModel: string;
  usage: TokenUsage;
  estimatedCostUsd: number;
  priceBookVersion: string;
  pricing: ModelPricing;
}

export interface AttemptStore {
  start(input: StartAttemptInput): Promise<{ attemptId: string }>;
  startFallback(input: StartFallbackAttemptInput): Promise<{ attemptId: string }>;
  responseStarted(attemptId: string, providerRequestId: string): Promise<void>;
  firstToken(attemptId: string): Promise<void>;
  complete(input: CompleteAttemptInput): Promise<void>;
  fail(input: FailAttemptInput): Promise<void>;
}

export class PrismaAttemptStore implements AttemptStore {
  public constructor(private readonly database: RouterDatabase) {}

  public async start(input: StartAttemptInput): Promise<{ attemptId: string }> {
    return this.database.$transaction(async (transaction) => {
      if (input.costBaseline) {
        await ensurePriceBookEntry(transaction, input.costBaseline);
      }
      const created = await transaction.request.create({
        data: {
          id: input.requestId,
          ...(input.sessionId
            ? {
                session: {
                  connectOrCreate: {
                    where: { id: input.sessionId },
                    create: {
                      id: input.sessionId,
                      routingMode: input.routingMode,
                    },
                  },
                },
              }
            : {}),
          ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
          ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
          selectedProvider: input.selectedProvider,
          selectedModel: input.selectedModel,
          routingMode: input.routingMode,
          status: "RECEIVED",
          metadata: input.metadata,
          ...(input.routeDecision
            ? {
                routeDecision: {
                  create: input.routeDecision,
                },
              }
            : {}),
          ...(input.costBaseline
            ? {
                costBaseline: {
                  create: {
                    provider: input.costBaseline.provider,
                    model: input.costBaseline.model,
                    upstreamModel: input.costBaseline.upstreamModel,
                    inputTokens: input.costBaseline.tokenEstimate.inputTokens,
                    expectedOutputTokens: input.costBaseline.tokenEstimate.expectedOutputTokens,
                    estimatedCost: input.costBaseline.estimatedCostUsd,
                    currency: input.costBaseline.pricing.currency,
                    priceBookVersion: input.costBaseline.priceBookVersion,
                  },
                },
              }
            : {}),
          ...(input.initialSwitch
            ? {
                routeSwitches: {
                  create: {
                    sequence: 1,
                    ...input.initialSwitch,
                  },
                },
              }
            : {}),
          attempts: {
            create: {
              provider: input.selectedProvider,
              model: input.upstreamModel,
              sequence: 1,
              status: "STARTED",
            },
          },
        },
        select: {
          attempts: {
            select: { id: true },
            where: { sequence: 1 },
            take: 1,
          },
        },
      });
      const attempt = created.attempts[0];
      if (!attempt) {
        throw new Error(`Failed to create provider attempt for request "${input.requestId}".`);
      }
      return { attemptId: attempt.id };
    });
  }

  public async startFallback(input: StartFallbackAttemptInput): Promise<{ attemptId: string }> {
    return this.database.$transaction(async (transaction) => {
      const aggregate = await transaction.providerAttempt.aggregate({
        where: { requestId: input.requestId },
        _max: { sequence: true },
      });
      const sequence = (aggregate._max.sequence ?? 0) + 1;
      const attempt = await transaction.providerAttempt.create({
        data: {
          requestId: input.requestId,
          provider: input.selectedProvider,
          model: input.upstreamModel,
          sequence,
          status: "STARTED",
        },
        select: { id: true },
      });
      await transaction.routeSwitch.create({
        data: {
          requestId: input.requestId,
          sequence,
          fromProvider: input.fromProvider,
          fromModel: input.fromModel,
          toProvider: input.selectedProvider,
          toModel: input.selectedModel,
          reason: input.reason,
          trigger: input.trigger,
        },
      });
      await transaction.request.update({
        where: { id: input.requestId },
        data: {
          selectedProvider: input.selectedProvider,
          selectedModel: input.selectedModel,
          status: "RECEIVED",
          completedAt: null,
          errorType: null,
          errorMessage: null,
        },
      });
      return { attemptId: attempt.id };
    });
  }

  public async responseStarted(attemptId: string, providerRequestId: string): Promise<void> {
    await this.database.providerAttempt.update({
      where: { id: attemptId },
      data: {
        providerRequestId,
        request: {
          update: { status: "STREAMING" },
        },
      },
    });
  }

  public async firstToken(attemptId: string): Promise<void> {
    await this.database.providerAttempt.updateMany({
      where: { id: attemptId, firstTokenAt: null },
      data: { firstTokenAt: new Date() },
    });
  }

  public async complete(input: CompleteAttemptInput): Promise<void> {
    const completedAt = new Date();
    await this.database.$transaction(async (transaction) => {
      await ensurePriceBookEntry(transaction, {
        priceBookVersion: input.priceBookVersion,
        provider: input.provider,
        model: input.model,
        upstreamModel: input.upstreamModel,
        pricing: input.pricing,
      });
      await transaction.providerAttempt.update({
        where: { id: input.attemptId },
        data: { status: "COMPLETED", completedAt },
      });
      await createUsageEvent(transaction, input, "COMPLETED");
      await transaction.request.update({
        where: { id: input.requestId },
        data: { status: "COMPLETED", completedAt },
      });
      await incrementSessionUsage(transaction, input, completedAt);
    });
  }

  public async fail(input: FailAttemptInput): Promise<void> {
    const completedAt = new Date();
    await this.database.$transaction(async (transaction) => {
      await ensurePriceBookEntry(transaction, {
        priceBookVersion: input.priceBookVersion,
        provider: input.provider,
        model: input.model,
        upstreamModel: input.upstreamModel,
        pricing: input.pricing,
      });
      await transaction.providerAttempt.update({
        where: { id: input.attemptId },
        data: {
          status: input.status,
          completedAt,
          errorType: input.errorType,
          errorMessage: input.errorMessage,
        },
      });
      await createUsageEvent(transaction, input, input.status);
      await transaction.request.update({
        where: { id: input.requestId },
        data: {
          status: input.status,
          completedAt,
          errorType: input.errorType,
          errorMessage: input.errorMessage,
        },
      });
      await incrementSessionUsage(transaction, input, completedAt);
    });
  }
}

type UsageWriteInput = CompleteAttemptInput | FailAttemptInput;

async function createUsageEvent(
  transaction: Prisma.TransactionClient,
  input: UsageWriteInput,
  attemptStatus: "COMPLETED" | "FAILED" | "CANCELLED",
): Promise<void> {
  const reasoningPrice = input.pricing.reasoningPerMillion ?? input.pricing.outputPerMillion;
  await transaction.usageEvent.create({
    data: {
      requestId: input.requestId,
      providerAttemptId: input.attemptId,
      provider: input.provider,
      model: input.model,
      upstreamModel: input.upstreamModel,
      attemptStatus,
      inputTokens: input.usage.inputTokens,
      cachedInputTokens: input.usage.cachedInputTokens,
      outputTokens: input.usage.outputTokens,
      reasoningTokens: input.usage.reasoningTokens,
      toolCost: 0,
      estimatedCost: input.estimatedCostUsd,
      currency: input.pricing.currency,
      priceBookVersion: input.priceBookVersion,
      inputPricePerMillion: input.pricing.inputPerMillion,
      cachedInputPricePerMillion: input.pricing.cachedInputPerMillion,
      outputPricePerMillion: input.pricing.outputPerMillion,
      reasoningPricePerMillion: reasoningPrice,
      pricingSource: input.pricing.source,
      pricingEffectiveFrom: dateOnly(input.pricing.effectiveFrom),
      pricingVerifiedAt: dateOnly(input.pricing.verifiedAt),
    },
  });
}

async function incrementSessionUsage(
  transaction: Prisma.TransactionClient,
  input: UsageWriteInput,
  completedAt: Date,
): Promise<void> {
  await transaction.session.updateMany({
    where: { requests: { some: { id: input.requestId } } },
    data: {
      accumulatedCost: { increment: input.estimatedCostUsd },
      inputTokens: { increment: input.usage.inputTokens },
      cachedInputTokens: { increment: input.usage.cachedInputTokens },
      outputTokens: { increment: input.usage.outputTokens },
      reasoningTokens: { increment: input.usage.reasoningTokens },
      lastActivityAt: completedAt,
    },
  });
}

async function ensurePriceBookEntry(
  transaction: Prisma.TransactionClient,
  input: PriceSnapshotInput,
): Promise<void> {
  await transaction.priceBook.createMany({
    data: [
      {
        version: input.priceBookVersion,
        currency: input.pricing.currency,
      },
    ],
    skipDuplicates: true,
  });
  const priceBook = await transaction.priceBook.findUniqueOrThrow({
    where: { version: input.priceBookVersion },
  });
  if (priceBook.currency !== input.pricing.currency) {
    throw new Error(
      `Price book "${input.priceBookVersion}" uses ${priceBook.currency}, not ${input.pricing.currency}. Use a new price-book version for a different currency.`,
    );
  }
  const entryData = {
    priceBookVersion: input.priceBookVersion,
    provider: input.provider,
    model: input.model,
    upstreamModel: input.upstreamModel,
    inputPricePerMillion: input.pricing.inputPerMillion,
    cachedInputPricePerMillion: input.pricing.cachedInputPerMillion,
    outputPricePerMillion: input.pricing.outputPerMillion,
    reasoningPricePerMillion: input.pricing.reasoningPerMillion ?? input.pricing.outputPerMillion,
    effectiveFrom: dateOnly(input.pricing.effectiveFrom),
    verifiedAt: dateOnly(input.pricing.verifiedAt),
    source: input.pricing.source,
  };
  await transaction.priceBookEntry.createMany({
    data: [entryData],
    skipDuplicates: true,
  });
  const entry = await transaction.priceBookEntry.findUniqueOrThrow({
    where: {
      priceBookVersion_provider_model: {
        priceBookVersion: input.priceBookVersion,
        provider: input.provider,
        model: input.model,
      },
    },
  });
  const same =
    entry.upstreamModel === input.upstreamModel &&
    decimalEquals(entry.inputPricePerMillion, input.pricing.inputPerMillion) &&
    decimalEquals(entry.cachedInputPricePerMillion, input.pricing.cachedInputPerMillion) &&
    decimalEquals(entry.outputPricePerMillion, input.pricing.outputPerMillion) &&
    decimalEquals(
      entry.reasoningPricePerMillion,
      input.pricing.reasoningPerMillion ?? input.pricing.outputPerMillion,
    ) &&
    entry.effectiveFrom.toISOString().slice(0, 10) === input.pricing.effectiveFrom &&
    entry.verifiedAt.toISOString().slice(0, 10) === input.pricing.verifiedAt &&
    entry.source === input.pricing.source;
  if (!same) {
    throw new Error(
      `Price book "${input.priceBookVersion}" conflicts with the stored entry for "${input.model}". Use a new price-book version for changed prices.`,
    );
  }
}

function decimalEquals(value: { toString(): string }, expected: number): boolean {
  return Number(value.toString()) === expected;
}

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

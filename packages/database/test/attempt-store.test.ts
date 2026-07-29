import { describe, expect, it, vi } from "vitest";

import { PrismaAttemptStore, type RouterDatabase } from "../src/index.js";

const pricing = {
  currency: "USD" as const,
  effectiveFrom: "2026-07-01",
  verifiedAt: "2026-07-28",
  source: "https://pricing.example/model",
  inputPerMillion: 2,
  cachedInputPerMillion: 0.2,
  outputPerMillion: 8,
  reasoningPerMillion: 10,
};

describe("PrismaAttemptStore usage ledger", () => {
  it("records failed-attempt usage, immutable prices, and session totals", async () => {
    const transaction = transactionMock();
    const database = databaseMock(transaction);
    const store = new PrismaAttemptStore(database);

    await store.fail({
      requestId: "request_1",
      attemptId: "attempt_1",
      status: "FAILED",
      errorType: "rate_limit",
      errorMessage: "retryable failure",
      provider: "openai",
      model: "openai/model",
      upstreamModel: "gpt-test",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningTokens: 2,
      },
      estimatedCostUsd: 0.00028,
      priceBookVersion: "prices-v1",
      pricing,
    });

    expect(transaction.usageEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestId: "request_1",
        providerAttemptId: "attempt_1",
        attemptStatus: "FAILED",
        inputTokens: 100,
        estimatedCost: 0.00028,
        priceBookVersion: "prices-v1",
        inputPricePerMillion: 2,
        reasoningPricePerMillion: 10,
        pricingSource: "https://pricing.example/model",
      }),
    });
    expect(transaction.session.updateMany).toHaveBeenCalledWith({
      where: { requests: { some: { id: "request_1" } } },
      data: expect.objectContaining({
        accumulatedCost: { increment: 0.00028 },
        inputTokens: { increment: 100 },
        cachedInputTokens: { increment: 20 },
        outputTokens: { increment: 10 },
        reasoningTokens: { increment: 2 },
      }),
    });
  });

  it("creates a declared request baseline before the request record", async () => {
    const transaction = transactionMock();
    transaction.request.create.mockResolvedValue({ attempts: [{ id: "attempt_1" }] });
    const store = new PrismaAttemptStore(databaseMock(transaction));

    await expect(
      store.start({
        requestId: "request_1",
        selectedProvider: "cheap",
        selectedModel: "cheap/model",
        upstreamModel: "cheap-upstream",
        routingMode: "balanced",
        metadata: {},
        costBaseline: {
          priceBookVersion: "prices-v1",
          provider: "frontier",
          model: "frontier/baseline",
          upstreamModel: "frontier-upstream",
          pricing,
          tokenEstimate: {
            inputTokens: 500,
            expectedOutputTokens: 100,
          },
          estimatedCostUsd: 0.0018,
        },
      }),
    ).resolves.toEqual({ attemptId: "attempt_1" });

    expect(transaction.request.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: "request_1",
          costBaseline: {
            create: {
              provider: "frontier",
              model: "frontier/baseline",
              upstreamModel: "frontier-upstream",
              inputTokens: 500,
              expectedOutputTokens: 100,
              estimatedCost: 0.0018,
              currency: "USD",
              priceBookVersion: "prices-v1",
            },
          },
        }),
      }),
    );
  });

  it("rejects changed prices under an existing price-book version", async () => {
    const transaction = transactionMock();
    transaction.priceBookEntry.upsert.mockResolvedValue({
      ...priceEntry(),
      outputPricePerMillion: decimal("9"),
    });
    const store = new PrismaAttemptStore(databaseMock(transaction));

    await expect(
      store.complete({
        requestId: "request_1",
        attemptId: "attempt_1",
        provider: "openai",
        model: "openai/model",
        upstreamModel: "gpt-test",
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          reasoningTokens: 0,
        },
        estimatedCostUsd: 0.00001,
        priceBookVersion: "prices-v1",
        pricing,
      }),
    ).rejects.toThrow('Price book "prices-v1" conflicts');
    expect(transaction.usageEvent.create).not.toHaveBeenCalled();
  });
});

function transactionMock() {
  return {
    priceBook: {
      upsert: vi.fn(() => Promise.resolve({ version: "prices-v1", currency: "USD" })),
    },
    priceBookEntry: {
      upsert: vi.fn((input: { create: ReturnType<typeof priceEntry> }) =>
        Promise.resolve({
          ...input.create,
          inputPricePerMillion: decimal(String(input.create.inputPricePerMillion)),
          cachedInputPricePerMillion: decimal(String(input.create.cachedInputPricePerMillion)),
          outputPricePerMillion: decimal(String(input.create.outputPricePerMillion)),
          reasoningPricePerMillion: decimal(String(input.create.reasoningPricePerMillion)),
        }),
      ),
    },
    request: {
      create: vi.fn(),
      update: vi.fn(() => Promise.resolve({})),
    },
    providerAttempt: {
      update: vi.fn(() => Promise.resolve({})),
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
      aggregate: vi.fn(),
      create: vi.fn(),
    },
    usageEvent: {
      create: vi.fn(() => Promise.resolve({})),
    },
    session: {
      updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
    },
    routeSwitch: {
      create: vi.fn(),
    },
  };
}

function databaseMock(transaction: ReturnType<typeof transactionMock>): RouterDatabase {
  return {
    $transaction: vi.fn((operation: (client: typeof transaction) => Promise<unknown>) =>
      operation(transaction),
    ),
  } as unknown as RouterDatabase;
}

function priceEntry() {
  return {
    upstreamModel: "gpt-test",
    inputPricePerMillion: decimal("2"),
    cachedInputPricePerMillion: decimal("0.2"),
    outputPricePerMillion: decimal("8"),
    reasoningPricePerMillion: decimal("10"),
    effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
    verifiedAt: new Date("2026-07-28T00:00:00.000Z"),
    source: "https://pricing.example/model",
  };
}

function decimal(value: string): { toString(): string } {
  return { toString: () => value };
}

import { describe, expect, it, vi } from "vitest";

import { PrismaRouterConfigurationStore, type RouterDatabase } from "../src/index.js";

describe("PrismaRouterConfigurationStore", () => {
  it("atomically activates a stable content-addressed snapshot", async () => {
    const updateMany = vi.fn(() => Promise.resolve({ count: 1 }));
    const upsert = vi.fn((input) => Promise.resolve({ id: "snapshot-1", ...input.create }));
    const transaction = vi.fn((operations: Array<Promise<unknown>>) => Promise.all(operations));
    const database = {
      routerConfigurationSnapshot: { updateMany, upsert },
      $transaction: transaction,
    } as unknown as RouterDatabase;
    const store = new PrismaRouterConfigurationStore(database);

    const first = await store.activate({
      environment: "production",
      routerVersion: "router-v2",
      priceBookVersion: "prices-v2",
      payload: { routing: { mode: "balanced", weight: 0.5 }, providers: ["openai"] },
    });
    const second = await store.activate({
      environment: "production",
      routerVersion: "router-v2",
      priceBookVersion: "prices-v2",
      payload: { providers: ["openai"], routing: { weight: 0.5, mode: "balanced" } },
    });

    expect(first.hash).toBe(second.hash);
    expect(first.id).toBe("snapshot-1");
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true, configurationHash: { not: first.hash } } }),
    );
    expect(JSON.stringify(upsert.mock.calls)).not.toContain("database-password");
  });
});

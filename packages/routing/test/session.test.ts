import { describe, expect, it } from "vitest";

import {
  defaultSessionRoutingPolicy,
  InMemorySessionStateStore,
  SessionCoordinator,
} from "../src/index.js";
import type { RoutingDecision } from "../src/types.js";
import { testModel } from "./helpers.js";

describe("SessionCoordinator", () => {
  it("escalates repeated failures and de-escalates only after cooldown and successes", async () => {
    let now = 1_000;
    const store = new InMemorySessionStateStore();
    const coordinator = new SessionCoordinator(
      store,
      {
        ...defaultSessionRoutingPolicy,
        escalationFailureThreshold: 2,
        successfulOutcomesToDeescalate: 3,
        deescalationCooldownMs: 100,
      },
      () => new Date(now),
    );

    expect(
      (await coordinator.recordOutcome("session-1", "balanced", { kind: "test_failure" })).state
        .escalationLevel,
    ).toBe(0);
    const escalated = await coordinator.recordOutcome("session-1", "balanced", {
      kind: "test_failure",
      source: "test-runner",
    });
    expect(escalated.escalated).toBe(true);
    expect(escalated.state.escalationLevel).toBe(1);

    await coordinator.recordOutcome("session-1", "balanced", { kind: "success" });
    await coordinator.recordOutcome("session-1", "balanced", { kind: "success" });
    const beforeCooldown = await coordinator.recordOutcome("session-1", "balanced", {
      kind: "success",
    });
    expect(beforeCooldown.deescalated).toBe(false);
    expect(beforeCooldown.state.escalationLevel).toBe(1);

    now += 101;
    const deescalated = await coordinator.recordOutcome("session-1", "balanced", {
      kind: "task_completed",
    });
    expect(deescalated.deescalated).toBe(true);
    expect(deescalated.state.escalationLevel).toBe(0);
    expect(store.outcomes()).toHaveLength(6);
  });

  it("supports explicit escalation and stores completed-turn routing state", async () => {
    const store = new InMemorySessionStateStore();
    const coordinator = new SessionCoordinator(store, defaultSessionRoutingPolicy);
    const decision = {
      selectedModel: testModel({
        id: "provider/model",
        qualityTier: 3,
        inputPrice: 1,
      }),
      task: { taskClass: "debugging" },
    } as RoutingDecision;

    const state = await coordinator.recordTurn("session-2", "balanced", decision);
    expect(state).toMatchObject({
      currentProvider: "provider",
      currentModel: "provider/model",
      turnCount: 1,
      lastTaskClass: "debugging",
    });

    const result = await coordinator.recordOutcome("session-2", "balanced", {
      kind: "user_escalation",
    });
    expect(result.escalated).toBe(true);
    expect(result.state.escalationLevel).toBe(1);
  });
});

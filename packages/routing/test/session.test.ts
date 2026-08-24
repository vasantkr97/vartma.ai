import { describe, expect, it } from "vitest";

import {
  defaultSessionRoutingPolicy,
  InMemorySessionStateStore,
  SessionCoordinator,
} from "../src/index.js";
import type { RoutingDecision } from "../src/types.js";
import { testModel } from "./helpers.js";

describe("SessionCoordinator", () => {
  it("automatically escalates unique stuck evidence, deduplicates it, and expires the verdict", async () => {
    let now = 1_000;
    const store = new InMemorySessionStateStore();
    const coordinator = new SessionCoordinator(
      store,
      { ...defaultSessionRoutingPolicy, automaticStuckVerdictTtlMs: 100 },
      () => new Date(now),
    );
    const assessment = {
      status: "stuck" as const,
      confidence: 0.86,
      toolCalls: 2,
      toolErrors: 2,
      testFailures: 2,
      repeatedToolCalls: 2,
      repeatedFailureOutputs: 2,
      reasons: ["the same failure output appeared repeatedly"],
      fingerprint: "a".repeat(64),
    };

    const first = await coordinator.observeProgress("session-auto", "balanced", assessment, "r1");
    expect(first.escalated).toBe(true);
    expect(first.state).toMatchObject({ escalationLevel: 1, automaticEscalationLevel: 1 });
    expect(store.outcomes()).toHaveLength(1);

    const duplicate = await coordinator.observeProgress(
      "session-auto",
      "balanced",
      assessment,
      "r2",
    );
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.state.escalationLevel).toBe(1);
    expect(store.outcomes()).toHaveLength(1);

    now += 101;
    const progressing = await coordinator.observeProgress("session-auto", "balanced", {
      ...assessment,
      status: "progressing",
      reasons: [],
      fingerprint: undefined,
    });
    expect(progressing.expired).toBe(true);
    expect(progressing.state).toMatchObject({ escalationLevel: 0, automaticEscalationLevel: 0 });
    expect(progressing.state.automaticStuckUntil).toBeUndefined();
  });

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

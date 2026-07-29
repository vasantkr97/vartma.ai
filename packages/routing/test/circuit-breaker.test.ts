import { describe, expect, it } from "vitest";

import { CircuitBreakerRegistry } from "../src/index.js";

describe("CircuitBreakerRegistry", () => {
  it("opens, permits one half-open probe, reopens, and closes after successful probes", () => {
    let now = 1_000;
    const circuits = new CircuitBreakerRegistry(
      {
        failureThreshold: 2,
        openDurationMs: 100,
        halfOpenSuccessThreshold: 2,
      },
      () => now,
    );

    circuits.recordFailure("provider/model");
    expect(circuits.canRequest("provider/model")).toBe(true);
    circuits.recordFailure("provider/model");
    expect(circuits.snapshot("provider/model").state).toBe("open");
    expect(circuits.canRequest("provider/model")).toBe(false);

    now += 101;
    expect(circuits.canRequest("provider/model")).toBe(true);
    expect(circuits.canRequest("provider/model")).toBe(false);
    circuits.recordFailure("provider/model");
    expect(circuits.snapshot("provider/model").state).toBe("open");

    now += 101;
    expect(circuits.canRequest("provider/model")).toBe(true);
    circuits.recordSuccess("provider/model");
    expect(circuits.snapshot("provider/model").state).toBe("half_open");
    expect(circuits.canRequest("provider/model")).toBe(true);
    circuits.recordSuccess("provider/model");
    expect(circuits.snapshot("provider/model").state).toBe("closed");
  });

  it("reports open circuits as blocked routing keys", () => {
    const circuits = new CircuitBreakerRegistry({
      failureThreshold: 1,
      openDurationMs: 1_000,
      halfOpenSuccessThreshold: 1,
    });
    circuits.recordFailure("provider/model");
    expect(circuits.blockedKeys()).toEqual(new Set(["provider/model"]));
  });
});

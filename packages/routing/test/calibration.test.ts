import { describe, expect, it } from "vitest";

import { predictModelPerformance, routingCalibrationSchema } from "../src/index.js";
import { testModel } from "./helpers.js";

describe("routing calibration", () => {
  it("shrinks small evaluation samples toward the task-aware quality prior", () => {
    const calibration = routingCalibrationSchema.parse({
      version: "eval-v1",
      priorSampleSize: 20,
      models: {
        "model/a": {
          tasks: {
            debugging: {
              successRate: 1,
              sampleSize: 2,
              observedAt: "2026-08-24T00:00:00.000Z",
              source: "small debug evaluation",
            },
          },
        },
      },
    });
    const prediction = predictModelPerformance(
      calibration,
      testModel({ id: "model/a", qualityTier: 2, inputPrice: 1 }),
      {
        taskClass: "debugging",
        difficulty: 3,
        confidence: 0.9,
        signals: {} as never,
      },
    );

    expect(prediction.source).toBe("task_evaluation");
    expect(prediction.expectedSuccess).toBeGreaterThan(0.58);
    expect(prediction.expectedSuccess).toBeLessThan(1);
  });

  it("rejects impossible or unaudited calibration samples", () => {
    expect(() =>
      routingCalibrationSchema.parse({
        version: "invalid",
        models: {
          "model/a": {
            default: {
              successRate: 1.2,
              sampleSize: 0,
              observedAt: "yesterday",
              source: "",
            },
          },
        },
      }),
    ).toThrow();
  });
});

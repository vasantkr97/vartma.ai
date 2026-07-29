import { describe, expect, it } from "vitest";

import { FakeProvider, runProviderConformance } from "../src/index.js";
import { canonicalRequest } from "./helpers.js";

describe("provider conformance runner", () => {
  it("validates lifecycle, block balance, usage estimation, health, and tool JSON", async () => {
    const request = canonicalRequest();
    request.messages = [{ role: "user", content: [{ type: "text", text: "use a tool" }] }];
    request.tools = [
      {
        name: "echo",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
        },
      },
    ];
    const report = await runProviderConformance(
      new FakeProvider({ name: "fake", model: "fake-default" }),
      "fake-default",
      request,
    );

    expect(report).toMatchObject({
      provider: "fake",
      model: "fake-default",
      passed: true,
      checks: {
        health: true,
        tokenEstimate: true,
        lifecycle: true,
        contentBlocks: true,
        toolJson: true,
      },
    });
    expect(report.eventsObserved).toBeGreaterThan(0);
    expect(report.issues).toEqual([]);
  });
});

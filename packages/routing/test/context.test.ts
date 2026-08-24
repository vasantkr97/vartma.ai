import { describe, expect, it } from "vitest";

import { compressCanonicalContext } from "../src/index.js";
import { testRequest } from "./helpers.js";

describe("loss-controlled context compression", () => {
  it("keeps requirements, decisions, failures, mutations, and the recent tail verbatim", () => {
    const request = testRequest("The requirement is: never remove authentication checks");
    request.messages.unshift({
      role: "system",
      content: [{ type: "text", text: "System policy" }],
    });
    request.messages.push(
      { role: "assistant", content: [{ type: "text", text: `routine ${"x".repeat(300)}` }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Decision: preserve the public API contract" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "edit-1", name: "apply_patch", arguments: { file: "a.ts" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "edit-1", content: "updated a.ts", isError: false },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "test-1",
            content: "FAIL authentication test expected 200 received 500",
            isError: true,
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: `routine ${"y".repeat(300)}` }] },
      { role: "user", content: [{ type: "text", text: "Continue fixing it" }] },
    );

    const result = compressCanonicalContext(request, {
      enabled: true,
      triggerCharacters: 500,
      targetCharacters: 400,
      preserveRecentMessages: 1,
    });
    const serialized = JSON.stringify(result.request);

    expect(result.report).toMatchObject({ applied: true, omittedMessages: 2 });
    expect(serialized).toContain("System policy");
    expect(serialized).toContain("never remove authentication checks");
    expect(serialized).toContain("preserve the public API contract");
    expect(serialized).toContain("apply_patch");
    expect(serialized).toContain("updated a.ts");
    expect(serialized).toContain("FAIL authentication test");
    expect(serialized).toContain("Continue fixing it");
    expect(serialized).toContain("Vartma context compression");
    expect(serialized).not.toContain(`routine ${"x".repeat(300)}`);
  });

  it("returns the original request below the configured trigger", () => {
    const request = testRequest("short request");
    const result = compressCanonicalContext(request, {
      enabled: true,
      triggerCharacters: 10_000,
      targetCharacters: 5_000,
      preserveRecentMessages: 4,
    });

    expect(result.request).toBe(request);
    expect(result.report.applied).toBe(false);
  });
});

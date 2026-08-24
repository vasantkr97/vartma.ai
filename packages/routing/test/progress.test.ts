import { describe, expect, it } from "vitest";

import { analyzeProgress } from "../src/index.js";
import { testRequest } from "./helpers.js";

describe("transcript progress analysis", () => {
  it("detects repeated unchanged failures without exposing transcript content", () => {
    const request = testRequest("Fix the failing authentication test");
    request.messages.push(
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "1", name: "Bash", arguments: { command: "npm test" } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "1",
            content: "FAIL src/auth.test.ts: expected 200 but received 500",
            isError: true,
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "2", name: "Bash", arguments: { command: "npm test" } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "2",
            content: "FAIL src/auth.test.ts: expected 200 but received 500",
            isError: true,
          },
        ],
      },
    );

    const assessment = analyzeProgress(request);

    expect(assessment).toMatchObject({
      status: "stuck",
      toolCalls: 2,
      toolErrors: 2,
      testFailures: 2,
      repeatedToolCalls: 2,
      repeatedFailureOutputs: 2,
    });
    expect(assessment.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(assessment)).not.toContain("auth.test.ts");
    expect(JSON.stringify(assessment)).not.toContain("npm test");
  });

  it("does not label distinct successful tool activity as stuck", () => {
    const request = testRequest("Inspect and update the project");
    request.messages.push(
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "1", name: "Read", arguments: { path: "a.ts" } }],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "1", content: "export const a = 1", isError: false },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "2", name: "Edit", arguments: { path: "a.ts" } }],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "2", content: "updated a.ts", isError: false },
        ],
      },
    );

    expect(analyzeProgress(request)).toMatchObject({
      status: "progressing",
      toolCalls: 2,
      toolErrors: 0,
      repeatedFailureOutputs: 0,
    });
  });

  it("normalizes changing paths and line numbers before comparing failures", () => {
    const request = testRequest("Repair type errors");
    request.messages.push({
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: "1",
          content: "C:\\repo\\src\\a.ts:21 error TS2322: Type mismatch in 40ms",
          isError: true,
        },
        {
          type: "tool_result",
          toolCallId: "2",
          content: "C:\\repo\\src\\a.ts:98 error TS2322: Type mismatch in 55ms",
          isError: true,
        },
      ],
    });

    expect(analyzeProgress(request)).toMatchObject({
      status: "stuck",
      repeatedFailureOutputs: 2,
    });
  });
});

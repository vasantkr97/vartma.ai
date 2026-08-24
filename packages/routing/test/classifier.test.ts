import { describe, expect, it } from "vitest";

import { classifyTask } from "../src/index.js";
import { testRequest } from "./helpers.js";

const estimate = { inputTokens: 500, expectedOutputTokens: 200 };

describe("deterministic task classifier", () => {
  it.each([
    ["Explain how event loops work", "explanation", 1],
    ["Debug this exception and find the root cause", "debugging", 3],
    ["Write tests for the authentication service", "test_generation", 2],
    ["Fix the failing CI tests", "test_repair", 3],
    ["Refactor the payment module", "refactoring", 3],
    ["Update the README documentation", "documentation", 1],
    ["Design the distributed system architecture", "architecture_design", 5],
    ["Perform a security vulnerability audit", "security_review", 4],
    ["Migrate this application from Express 4", "migration", 4],
  ] as const)("classifies %s", (prompt, taskClass, difficulty) => {
    const result = classifyTask(testRequest(prompt), estimate);
    expect(result).toMatchObject({ taskClass, difficulty });
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("promotes multi-file implementation work", () => {
    const request = testRequest("Implement a feature endpoint");
    request.metadata["file_count"] = "4";

    expect(classifyTask(request, estimate)).toMatchObject({
      taskClass: "multi_file_feature",
      difficulty: 4,
    });
  });

  it("promotes large scope to a long autonomous task without storing prompt text", () => {
    const request = testRequest(`Complete product end-to-end ${"details ".repeat(1200)}`);
    const result = classifyTask(request, { inputTokens: 13_000, expectedOutputTokens: 1000 });

    expect(result.taskClass).toBe("long_autonomous_task");
    expect(result.difficulty).toBe(5);
    expect(JSON.stringify(result)).not.toContain("Complete product");
  });

  it("raises difficulty after repeated tool or test failures", () => {
    const request = testRequest("Debug this function");
    request.metadata["previous_tool_errors"] = "2";

    expect(classifyTask(request, estimate).difficulty).toBe(4);
  });

  it("classifies the current turn without letting an older expensive task dominate", () => {
    const request = testRequest("Design the distributed system architecture");
    request.messages.push(
      { role: "assistant", content: [{ type: "text", text: "Architecture completed." }] },
      { role: "user", content: [{ type: "text", text: "Explain this variable" }] },
    );

    const result = classifyTask(request, estimate);
    expect(result).toMatchObject({ taskClass: "explanation", difficulty: 1 });
    expect(result.signals.promptCharacters).toBe("Explain this variable".length);
  });
});

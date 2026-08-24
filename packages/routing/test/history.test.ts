import type { CanonicalMessage, CanonicalRequest } from "@vartma/canonical";
import { describe, expect, it } from "vitest";

import {
  CanonicalHistoryCoordinator,
  InMemoryCanonicalHistoryStore,
  mergeCanonicalMessages,
} from "../src/index.js";

describe("canonical session history", () => {
  it("reconciles full snapshots, retransmissions, and delta-only turns without duplication", () => {
    const system = message("system", "You are a coding agent.");
    const first = message("user", "Inspect the repository.");
    const answer = message("assistant", "I inspected it.");
    const second = message("user", "Now fix the test.");

    expect(mergeCanonicalMessages([system, first], [system, first, answer, second])).toEqual([
      system,
      first,
      answer,
      second,
    ]);
    expect(mergeCanonicalMessages([system, first, answer], [system, first])).toEqual([
      system,
      first,
      answer,
    ]);
    expect(mergeCanonicalMessages([system, first, answer], [second])).toEqual([
      system,
      first,
      answer,
      second,
    ]);
    expect(mergeCanonicalMessages([system, first, answer], [answer, second])).toEqual([
      system,
      first,
      answer,
      second,
    ]);
  });

  it("owns a session transcript and makes prior model output available to a delta-only turn", async () => {
    const store = new InMemoryCanonicalHistoryStore();
    const coordinator = new CanonicalHistoryCoordinator(store);
    const first = await coordinator.prepareRequest(request("session-1", [message("user", "A")]));
    await coordinator.recordAssistant(
      "session-1",
      first.messages,
      message("assistant", "Answer from model one"),
    );
    const second = await coordinator.prepareRequest(
      request("session-1", [message("user", "Continue with model two")]),
    );

    expect(second.messages).toEqual([
      message("user", "A"),
      message("assistant", "Answer from model one"),
      message("user", "Continue with model two"),
    ]);
    expect(second.metadata).toMatchObject({
      canonical_history_owned: "true",
      canonical_history_messages: "3",
      canonical_history_incoming_messages: "1",
    });
  });
});

function message(role: CanonicalMessage["role"], text: string): CanonicalMessage {
  return { role, content: [{ type: "text", text }] };
}

function request(sessionId: string, messages: CanonicalMessage[]): CanonicalRequest {
  return {
    requestId: crypto.randomUUID(),
    sessionId,
    messages,
    tools: [],
    maxOutputTokens: 100,
    routingMode: "balanced",
    constraints: { requiredCapabilities: ["text"] },
    metadata: {},
  };
}

import type { CanonicalEvent, CanonicalRequest } from "@vartma/canonical";
import { describe, expect, it } from "vitest";

import { FakeProvider } from "../src/index.js";

function request(text: string, withTool = false): CanonicalRequest {
  return {
    requestId: "request-1",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    tools: withTool
      ? [
          {
            name: "echo",
            description: "Echo a message",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
            },
          },
        ]
      : [],
    maxOutputTokens: 1024,
    routingMode: "balanced",
    constraints: { requiredCapabilities: [] },
    metadata: {},
  };
}

async function collect(provider: FakeProvider, input: CanonicalRequest) {
  const events: CanonicalEvent[] = [];
  for await (const event of provider.execute("fake-default", input)) {
    events.push(event);
  }
  return events;
}

describe("FakeProvider", () => {
  it("streams a deterministic text response", async () => {
    const events = await collect(new FakeProvider(), request("hello"));

    expect(events[0]?.type).toBe("response.started");
    expect(events.some((event) => event.type === "text.delta")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      finishReason: "end_turn",
    });
  });

  it("emits a tool call when requested", async () => {
    const events = await collect(
      new FakeProvider(),
      request("please use the available tool", true),
    );

    expect(events.some((event) => event.type === "tool_call.started")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      finishReason: "tool_use",
    });
  });

  it("honors cancellation during a stream", async () => {
    const controller = new AbortController();
    const provider = new FakeProvider({ chunkDelayMs: 50 });
    const consume = async () => {
      for await (const event of provider.execute(
        "fake-default",
        request("a response with several chunks"),
        controller.signal,
      )) {
        // Consume until the provider observes cancellation.
        void event;
      }
    };

    setTimeout(() => controller.abort(new Error("cancelled by test")), 5);
    await expect(consume()).rejects.toThrow("cancelled by test");
  });
});

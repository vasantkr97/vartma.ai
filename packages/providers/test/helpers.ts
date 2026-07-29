import type { CanonicalEvent, CanonicalRequest, ModelDefinition } from "@vartma/canonical";

export function model(provider: string, upstreamModel: string): ModelDefinition {
  return {
    id: `${provider}/default`,
    provider,
    upstreamModel,
    enabled: true,
    capabilities: {
      text: true,
      vision: true,
      streaming: true,
      tools: true,
      structuredOutput: true,
      reasoning: true,
    },
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    qualityTier: 3,
    expectedLatencyTier: 3,
    pricing: {
      currency: "USD",
      effectiveFrom: "2026-07-23",
      verifiedAt: "2026-07-23",
      source: "provider test fixture",
      inputPerMillion: 1,
      cachedInputPerMillion: 0.1,
      outputPerMillion: 5,
    },
  };
}

export function canonicalRequest(): CanonicalRequest {
  return {
    requestId: "req-router-1",
    sessionId: "session-1",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    maxOutputTokens: 256,
    routingMode: "balanced",
    constraints: { requiredCapabilities: [] },
    metadata: { tenant: "test" },
  };
}

export function sseResponse(events: unknown[], status = 200, headers?: HeadersInit): Response {
  const body = events
    .map((event) => `event: ${eventType(event)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

export async function collect(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const result: CanonicalEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

export function joinedText(events: CanonicalEvent[]): string {
  return events
    .filter((event) => event.type === "text.delta")
    .map((event) => event.text)
    .join("");
}

function eventType(event: unknown): string {
  if (typeof event === "object" && event !== null && "type" in event) {
    const type = event.type;
    if (typeof type === "string") {
      return type;
    }
  }
  return "message";
}

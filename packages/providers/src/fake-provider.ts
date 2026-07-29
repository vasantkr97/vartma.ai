import { randomUUID } from "node:crypto";

import type {
  CanonicalEvent,
  CanonicalRequest,
  CapabilitySet,
  HealthStatus,
  ModelDefinition,
  TokenEstimate,
  TokenUsage,
} from "@vartma/canonical";

import type { ProviderAdapter } from "./provider.js";

const capabilities: CapabilitySet = {
  text: true,
  vision: false,
  streaming: true,
  tools: true,
  structuredOutput: true,
  reasoning: false,
};

export interface FakeProviderOptions {
  name?: string;
  model?: string;
  chunkDelayMs?: number;
}

export class FakeProvider implements ProviderAdapter {
  public readonly name: string;
  private readonly model: string;
  private readonly chunkDelayMs: number;

  public constructor(options: FakeProviderOptions = {}) {
    this.name = options.name ?? "fake";
    this.model = options.model ?? "fake-default";
    this.chunkDelayMs = options.chunkDelayMs ?? 0;
  }

  public models(): Promise<ModelDefinition[]> {
    return Promise.resolve([
      {
        id: `${this.name}/default`,
        provider: this.name,
        upstreamModel: this.model,
        enabled: true,
        capabilities,
        contextWindow: 100_000,
        maxOutputTokens: 4096,
        qualityTier: 1,
        expectedLatencyTier: 1,
        pricing: {
          currency: "USD",
          effectiveFrom: "2026-07-23",
          verifiedAt: "2026-07-23",
          source: "internal deterministic fake provider",
          inputPerMillion: 0,
          cachedInputPerMillion: 0,
          outputPerMillion: 0,
        },
      },
    ]);
  }

  public capabilities(): CapabilitySet {
    return capabilities;
  }

  public estimateTokens(request: CanonicalRequest): Promise<TokenEstimate> {
    const characters = request.messages.reduce((sum, message) => {
      return (
        sum +
        message.content.reduce((contentSum, block) => {
          if (block.type === "text" || block.type === "reasoning") {
            return contentSum + block.text.length;
          }
          if (block.type === "tool_result" && typeof block.content === "string") {
            return contentSum + block.content.length;
          }
          return contentSum;
        }, 0)
      );
    }, 0);

    return Promise.resolve({
      inputTokens: Math.max(1, Math.ceil(characters / 4)),
      expectedOutputTokens: 32,
    });
  }

  public async *execute(
    model: string,
    request: CanonicalRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CanonicalEvent> {
    const estimate = await this.estimateTokens(request);
    const responseId = `fake_${randomUUID()}`;

    yield {
      type: "response.started",
      responseId,
      provider: this.name,
      model,
      inputTokens: estimate.inputTokens,
    };

    const shouldCallTool =
      request.tools.length > 0 && this.lastUserText(request).toLowerCase().includes("tool");

    if (shouldCallTool) {
      yield* this.emitToolCall(request, estimate.inputTokens, signal);
      return;
    }

    const text = `Fake provider response: ${this.lastUserText(request) || "No user text supplied."}`;
    yield { type: "content.started", index: 0, contentType: "text" };

    let outputTokens = 0;
    for (const chunk of text.match(/\S+\s*/g) ?? [text]) {
      await this.delay(signal);
      outputTokens += 1;
      yield { type: "text.delta", index: 0, text: chunk };
    }

    yield { type: "content.completed", index: 0 };
    const usage = this.usage(estimate.inputTokens, outputTokens);
    yield { type: "usage.updated", usage };
    yield { type: "response.completed", finishReason: "end_turn", usage };
  }

  public health(_model: string, signal?: AbortSignal): Promise<HealthStatus> {
    signal?.throwIfAborted();
    return Promise.resolve({
      healthy: true,
      observedAt: new Date().toISOString(),
      latencyMs: 0,
    });
  }

  private async *emitToolCall(
    request: CanonicalRequest,
    inputTokens: number,
    signal?: AbortSignal,
  ): AsyncIterable<CanonicalEvent> {
    const tool = request.tools[0];
    if (!tool) {
      throw new Error("Fake tool response requested without an available tool.");
    }

    const toolCallId = `tool_${randomUUID()}`;
    yield {
      type: "tool_call.started",
      index: 0,
      toolCallId,
      name: tool.name,
    };
    await this.delay(signal);
    yield {
      type: "tool_call.arguments.delta",
      index: 0,
      toolCallId,
      partialJson: '{"message":"hello from the fake provider"}',
    };
    yield {
      type: "tool_call.completed",
      index: 0,
      toolCallId,
    };

    const usage = this.usage(inputTokens, 12);
    yield { type: "usage.updated", usage };
    yield { type: "response.completed", finishReason: "tool_use", usage };
  }

  private lastUserText(request: CanonicalRequest): string {
    const userMessage = [...request.messages].reverse().find((message) => message.role === "user");

    return (
      userMessage?.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n") ?? ""
    );
  }

  private usage(inputTokens: number, outputTokens: number): TokenUsage {
    return {
      inputTokens,
      cachedInputTokens: 0,
      outputTokens,
      reasoningTokens: 0,
    };
  }

  private async delay(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.chunkDelayMs <= 0) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, this.chunkDelayMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("Aborted", "AbortError"),
          );
        },
        { once: true },
      );
    });
  }
}

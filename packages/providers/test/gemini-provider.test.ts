import type { CanonicalRequest } from "@vartma/canonical";
import { describe, expect, it, vi } from "vitest";

import { GeminiProvider, toGeminiRequest } from "../src/index.js";
import { canonicalRequest, collect, joinedText, model, sseResponse } from "./helpers.js";

describe("GeminiProvider", () => {
  it("streams native Gemini text and maps usage", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        sseResponse([
          {
            responseId: "gemini_response_1",
            modelVersion: "gemini-test-001",
            candidates: [{ content: { role: "model", parts: [{ text: "Hello " }] } }],
            usageMetadata: {
              promptTokenCount: 12,
              cachedContentTokenCount: 2,
              candidatesTokenCount: 1,
            },
          },
          {
            candidates: [
              {
                content: { role: "model", parts: [{ text: "world" }] },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              promptTokenCount: 12,
              cachedContentTokenCount: 2,
              candidatesTokenCount: 2,
              thoughtsTokenCount: 0,
            },
          },
        ]),
      ),
    );
    const provider = new GeminiProvider({
      name: "gemini",
      apiKey: "gemini-secret",
      models: [model("gemini", "gemini-test")],
      maxRetries: 0,
      fetchImplementation: fetchMock,
    });

    const events = await collect(provider.execute("gemini-test", canonicalRequest()));

    expect(joinedText(events)).toBe("Hello world");
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      finishReason: "end_turn",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 2,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const urlString = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    expect(urlString).toContain("/v1beta/models/gemini-test:streamGenerateContent?alt=sse");
    expect(init?.headers).toMatchObject({ "x-goog-api-key": "gemini-secret" });
    expect(typeof init?.body).toBe("string");
    if (typeof init?.body !== "string") {
      throw new Error("Expected serialized Gemini request JSON.");
    }
    expect(init.body).not.toContain("gemini-secret");
  });

  it("preserves thought signatures and function-call IDs", async () => {
    const provider = new GeminiProvider({
      name: "gemini",
      apiKey: "gemini-secret",
      models: [model("gemini", "gemini-test")],
      maxRetries: 0,
      fetchImplementation: () =>
        Promise.resolve(
          sseResponse([
            {
              responseId: "gemini_response_tool",
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      {
                        text: "checking",
                        thought: true,
                        thoughtSignature: "signed-gemini-state",
                      },
                      {
                        functionCall: {
                          id: "gemini_call_1",
                          name: "lookup",
                          args: { query: "router" },
                        },
                      },
                    ],
                  },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: {
                promptTokenCount: 8,
                candidatesTokenCount: 4,
                thoughtsTokenCount: 2,
              },
            },
          ]),
        ),
    });

    const events = await collect(provider.execute("gemini-test", toolRequest()));

    expect(events).toContainEqual({
      type: "reasoning.signature.delta",
      index: 0,
      signature: "signed-gemini-state",
    });
    expect(events).toContainEqual({
      type: "tool_call.started",
      index: 1,
      toolCallId: "gemini_call_1",
      name: "lookup",
    });
    expect(events).toContainEqual({
      type: "tool_call.arguments.delta",
      index: 1,
      toolCallId: "gemini_call_1",
      partialJson: '{"query":"router"}',
    });
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      finishReason: "tool_use",
    });
  });

  it("builds system, image, structured-output, tool-history, and signature fields", () => {
    const request = toolRequest();
    request.messages = [
      { role: "system", content: [{ type: "text", text: "Be precise" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect" },
          {
            type: "image",
            source: { type: "base64", mediaType: "image/png", data: "AAAA" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "",
            providerOpaqueData: '{"type":"thinking","thinking":"","signature":"gemini-signature"}',
          },
          {
            type: "tool_call",
            id: "call_1",
            name: "lookup",
            arguments: { query: "router" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_1",
            content: "found",
            isError: false,
          },
        ],
      },
    ];
    request.responseFormat = {
      type: "json_schema",
      name: "answer",
      schema: { type: "object", properties: { answer: { type: "string" } } },
    };

    expect(toGeminiRequest(request)).toMatchObject({
      systemInstruction: { parts: [{ text: "Be precise" }] },
      contents: [
        {
          role: "user",
          parts: [{ text: "Inspect" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }],
        },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "call_1",
                name: "lookup",
                args: { query: "router" },
              },
              thoughtSignature: "gemini-signature",
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "call_1",
                name: "lookup",
                response: { output: "found", isError: false },
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
        },
      },
    });
  });
});

function toolRequest(): CanonicalRequest {
  const request = canonicalRequest();
  request.tools = [
    {
      name: "lookup",
      description: "Look up a value",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
  ];
  request.toolChoice = { type: "tool", name: "lookup" };
  return request;
}

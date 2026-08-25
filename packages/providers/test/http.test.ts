import { describe, expect, it } from "vitest";

import { parseJsonEvent, parseSse } from "../src/http.js";
import { ProviderError } from "../src/provider.js";

describe("shared SSE parser", () => {
  it("preserves events across deterministic arbitrary UTF-8 fragmentation", async () => {
    const source = [
      ': keep-alive\r\nevent: delta\r\nid: first\r\ndata: {"text":"hello 😀"}\r\ndata: continuation\r\n\r\n',
      'data: {"type":"complete"}\n\n',
      "event: final\rid: last\rdata: [DONE]\r\r",
    ].join("");
    const expected = [
      { event: "delta", id: "first", data: '{"text":"hello 😀"}\ncontinuation' },
      { data: '{"type":"complete"}' },
      { event: "final", id: "last", data: "[DONE]" },
    ];

    for (let seed = 1; seed <= 200; seed += 1) {
      await expect(collect(parseSse(fragmentedStream(source, seed)))).resolves.toEqual(expected);
    }
  });

  it("fails closed when an unterminated event exceeds its size limit", async () => {
    await expect(
      collect(parseSse(fragmentedStream(`data: ${"x".repeat(64)}`, 7), 32)),
    ).rejects.toMatchObject<Partial<ProviderError>>({ code: "protocol", retryable: false });
  });

  it("rejects malformed JSON event objects as protocol errors", () => {
    for (const payload of ["", "null", "[]", "{", '{"ok":NaN}', '"scalar"']) {
      expect(() => parseJsonEvent(payload, "fuzz-provider")).toThrowError(ProviderError);
      try {
        parseJsonEvent(payload, "fuzz-provider");
      } catch (error) {
        expect(error).toMatchObject<Partial<ProviderError>>({ code: "protocol", retryable: false });
      }
    }
  });
});

function fragmentedStream(source: string, initialSeed: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(source);
  let seed = initialSeed >>> 0;
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      const length = 1 + (seed % 23);
      controller.enqueue(bytes.slice(offset, Math.min(bytes.length, offset + length)));
      offset += length;
    },
  });
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const output = [];
  for await (const event of events) output.push(event);
  return output;
}

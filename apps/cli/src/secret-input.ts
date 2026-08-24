import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export async function readHiddenSecret(
  prompt: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const terminal = createInterface({ input, output, terminal: false });
    try {
      return await terminal.question(prompt);
    } finally {
      terminal.close();
    }
  }

  output.write(prompt);
  return await new Promise<string>((resolveSecret, reject) => {
    let value = "";
    const wasPaused = input.isPaused();
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");

    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(false);
      if (wasPaused) input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolveSecret(value);
    };
    const onData = (chunk: string | Buffer) => {
      const text = chunk.toString();
      for (const character of text) {
        if (character === "\u0003") {
          finish(new Error("Credential entry was cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = [...value].slice(0, -1).join("");
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    input.on("data", onData);
  });
}

export type SecretInput = Readable;
export type SecretOutput = Writable;

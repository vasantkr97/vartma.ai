import type { CanonicalMessage, CanonicalRequest } from "@vartma/canonical";

export interface CanonicalHistoryStore {
  get(sessionId: string): Promise<CanonicalMessage[] | undefined>;
  save(sessionId: string, messages: CanonicalMessage[]): Promise<void>;
}

export class InMemoryCanonicalHistoryStore implements CanonicalHistoryStore {
  readonly #sessions = new Map<string, CanonicalMessage[]>();

  public get(sessionId: string): Promise<CanonicalMessage[] | undefined> {
    const messages = this.#sessions.get(sessionId);
    return Promise.resolve(messages ? structuredClone(messages) : undefined);
  }

  public save(sessionId: string, messages: CanonicalMessage[]): Promise<void> {
    this.#sessions.set(sessionId, structuredClone(messages));
    return Promise.resolve();
  }
}

export class CanonicalHistoryCoordinator {
  public constructor(private readonly store: CanonicalHistoryStore) {}

  public async prepareRequest(request: CanonicalRequest): Promise<CanonicalRequest> {
    if (!request.sessionId) return request;
    const stored = (await this.store.get(request.sessionId)) ?? [];
    const messages = mergeCanonicalMessages(stored, request.messages);
    await this.store.save(request.sessionId, messages);
    return {
      ...request,
      messages,
      metadata: {
        ...request.metadata,
        canonical_history_owned: "true",
        canonical_history_messages: String(messages.length),
        canonical_history_incoming_messages: String(request.messages.length),
      },
    };
  }

  public async recordAssistant(
    sessionId: string,
    requestMessages: CanonicalMessage[],
    assistant: CanonicalMessage,
  ): Promise<void> {
    const stored = (await this.store.get(sessionId)) ?? [];
    const requestHistory = mergeCanonicalMessages(stored, requestMessages);
    const messages =
      requestHistory.at(-1) && messagesEqual(requestHistory.at(-1)!, assistant)
        ? requestHistory
        : [...requestHistory, structuredClone(assistant)];
    await this.store.save(sessionId, messages);
  }
}

/**
 * Reconciles both full-history clients and clients that send only the next turn. A full client
 * snapshot is authoritative; delta messages are appended using the longest exact overlap.
 */
export function mergeCanonicalMessages(
  stored: CanonicalMessage[],
  incoming: CanonicalMessage[],
): CanonicalMessage[] {
  if (stored.length === 0) return structuredClone(incoming);
  if (incoming.length === 0) return structuredClone(stored);

  if (isPrefix(stored, incoming)) return structuredClone(incoming);
  if (isPrefix(incoming, stored)) return structuredClone(stored);

  const maximumOverlap = Math.min(stored.length, incoming.length);
  for (let overlap = maximumOverlap; overlap > 0; overlap -= 1) {
    const storedStart = stored.length - overlap;
    if (
      incoming
        .slice(0, overlap)
        .every((message, index) => messagesEqual(stored[storedStart + index]!, message))
    ) {
      return structuredClone([...stored, ...incoming.slice(overlap)]);
    }
  }

  // Multi-message/system-led requests are normal full snapshots whose formatting may have changed.
  // Treat them as authoritative instead of duplicating an entire transcript.
  if (incoming.length > 1 || incoming[0]?.role === "system") {
    return structuredClone(incoming);
  }
  return structuredClone([...stored, ...incoming]);
}

function isPrefix(prefix: CanonicalMessage[], value: CanonicalMessage[]): boolean {
  return (
    prefix.length <= value.length &&
    prefix.every((message, index) => messagesEqual(message, value[index]!))
  );
}

function messagesEqual(left: CanonicalMessage, right: CanonicalMessage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

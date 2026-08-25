export const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export function retryDelay({ attempt, retryAfterMs, random = Math.random }) {
  if (retryAfterMs !== undefined) return Math.min(30000, Math.max(0, retryAfterMs));
  const exponential = Math.min(10000, 250 * 2 ** attempt);
  return Math.round(exponential * (0.8 + random() * 0.4));
}

export function mayRetry({ status, visibleOutput, completedToolCalls, attempt, maxAttempts }) {
  return (
    !visibleOutput && !completedToolCalls && attempt < maxAttempts && RETRYABLE_STATUS.has(status)
  );
}

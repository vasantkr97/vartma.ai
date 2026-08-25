export class SlidingWindowLimiter {
  constructor({ limit, windowMs, clock }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.counts = new Map();
  }
  attempt(key) {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return {
      allowed: count <= this.limit,
      remaining: this.limit - count,
      retryAfterMs: this.windowMs,
    };
  }
}

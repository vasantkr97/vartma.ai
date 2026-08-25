export class SlidingWindowLimiter {
  #events = new Map();

  constructor({ limit, windowMs, clock }) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1)
      throw new RangeError("limit and windowMs must be positive integers");
    if (!clock || typeof clock.now !== "function") throw new TypeError("clock.now is required");
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
  }

  attempt(key) {
    const now = this.clock.now();
    const events = this.#events.get(key) ?? [];
    while (events.length > 0 && events[0] <= now - this.windowMs) events.shift();
    if (events.length >= this.limit) {
      this.#events.set(key, events);
      return { allowed: false, remaining: 0, retryAfterMs: events[0] + this.windowMs - now };
    }
    events.push(now);
    this.#events.set(key, events);
    return { allowed: true, remaining: this.limit - events.length, retryAfterMs: 0 };
  }
}

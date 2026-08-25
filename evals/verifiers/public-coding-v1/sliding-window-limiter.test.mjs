import assert from "node:assert/strict";
import { ManualClock } from "../clock.mjs";
import { SlidingWindowLimiter } from "../limiter.mjs";

const clock = new ManualClock(1000);
const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 100, clock });
assert.deepEqual(limiter.attempt("a"), { allowed: true, remaining: 1, retryAfterMs: 0 });
clock.advance(20);
assert.deepEqual(limiter.attempt("a"), { allowed: true, remaining: 0, retryAfterMs: 0 });
clock.advance(10);
assert.deepEqual(limiter.attempt("a"), { allowed: false, remaining: 0, retryAfterMs: 70 });
assert.deepEqual(limiter.attempt("b"), { allowed: true, remaining: 1, retryAfterMs: 0 });
clock.advance(70);
assert.deepEqual(limiter.attempt("a"), { allowed: true, remaining: 0, retryAfterMs: 0 });
clock.advance(20);
assert.deepEqual(limiter.attempt("a"), { allowed: true, remaining: 0, retryAfterMs: 0 });
assert.throws(() => new SlidingWindowLimiter({ limit: 0, windowMs: 1, clock }), RangeError);
assert.throws(() => new SlidingWindowLimiter({ limit: 1, windowMs: 1, clock: {} }), TypeError);

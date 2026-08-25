# Sliding-window limiter

`new SlidingWindowLimiter({limit, windowMs, clock})` requires positive integers and a clock with
`now()`. `attempt(key)` returns `{allowed, remaining, retryAfterMs}`. Accepted timestamps count only
while strictly newer than `now - windowMs`; an event exactly on the boundary is evicted. Denied
attempts are not recorded. Keys are independent, remaining never goes negative, and retry-after is
zero when allowed or the exact milliseconds until the oldest retained event expires.

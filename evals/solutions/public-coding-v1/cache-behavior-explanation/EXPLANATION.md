# Cache behavior

A key stores its value and `loadedAt` time. An age at or below `ttlMs` is a fresh hit and returns
immediately without invoking the loader. An age above `ttlMs` but at or below `ttlMs + staleMs` is
stale-while-revalidate: the stale value returns immediately while `refresh` starts in the
background. Beyond that window, or on a miss, `get` awaits refresh and exposes its result or error.

The `inFlight` map coalesces concurrent refreshes by key. The first caller installs one Promise and
later callers receive that same Promise; different keys remain independent. Its `finally` handler
removes the Promise after either success or failure. A successful load atomically replaces the
entry and resets `loadedAt`. A failed background refresh is swallowed by the stale caller and keeps
the old value, while a failed hard miss or fully expired lookup rejects because no acceptable stale
value exists.

For example, with `ttlMs = 1000`, `staleMs = 4000`, and `loadedAt = 10,000`: a lookup at 10,900 is
fresh; at 12,000 it returns stale data and starts one background load; and at 15,001 it waits for a
load. Two lookups at 15,001 share the same in-flight request rather than calling the loader twice.

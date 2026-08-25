# LruCache contract

`new LruCache(capacity)` requires a positive integer. `get(key)` returns the value or `undefined`
and promotes a hit. `set(key, value)` inserts or updates and promotes the key, evicting the least
recent key when needed. `has` does not affect recency. `delete` returns whether a key existed,
`size` is read-only, and `entries()` returns a snapshot from most to least recent.

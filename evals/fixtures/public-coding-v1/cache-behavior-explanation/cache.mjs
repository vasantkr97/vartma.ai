export function createCache(loader, { ttlMs, staleMs, now = Date.now }) {
  const entries = new Map();
  const inFlight = new Map();
  const refresh = (key) => {
    if (inFlight.has(key)) return inFlight.get(key);
    const request = Promise.resolve()
      .then(() => loader(key))
      .then((value) => {
        entries.set(key, { value, loadedAt: now() });
        return value;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    return request;
  };
  return {
    async get(key) {
      const entry = entries.get(key);
      const age = entry ? now() - entry.loadedAt : Number.POSITIVE_INFINITY;
      if (entry && age <= ttlMs) return entry.value;
      if (entry && age <= ttlMs + staleMs) {
        void refresh(key).catch(() => undefined);
        return entry.value;
      }
      return refresh(key);
    },
  };
}

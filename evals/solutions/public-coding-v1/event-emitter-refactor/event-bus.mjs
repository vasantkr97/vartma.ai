export class EventBus {
  #listeners = new Map();

  on(event, listener) {
    return this.#add(event, listener, false);
  }

  once(event, listener) {
    return this.#add(event, listener, true);
  }

  off(event, listener) {
    const records = this.#listeners.get(event);
    if (!records) return false;
    const record = [...records].find((candidate) => candidate.listener === listener);
    if (!record) return false;
    records.delete(record);
    if (records.size === 0) this.#listeners.delete(event);
    return true;
  }

  emit(event, ...args) {
    const records = this.#listeners.get(event);
    if (!records) return 0;
    let count = 0;
    for (const record of [...records]) {
      if (!records.has(record)) continue;
      if (record.once) records.delete(record);
      record.listener(...args);
      count += 1;
    }
    if (records.size === 0) this.#listeners.delete(event);
    return count;
  }

  #add(event, listener, once) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const records = this.#listeners.get(event) ?? new Set();
    const record = { listener, once };
    records.add(record);
    this.#listeners.set(event, records);
    return () => {
      const removed = records.delete(record);
      if (records.size === 0) this.#listeners.delete(event);
      return removed;
    };
  }
}

export class LruCache {
  #capacity;
  #values = new Map();

  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("invalid capacity");
    this.#capacity = capacity;
  }

  get(key) {
    if (!this.#values.has(key)) return undefined;
    const value = this.#values.get(key);
    this.#values.delete(key);
    this.#values.set(key, value);
    return value;
  }

  set(key, value) {
    this.#values.delete(key);
    this.#values.set(key, value);
    if (this.#values.size > this.#capacity) this.#values.delete(this.#values.keys().next().value);
    return this;
  }

  has(key) {
    return this.#values.has(key);
  }

  delete(key) {
    return this.#values.delete(key);
  }

  get size() {
    return this.#values.size;
  }

  entries() {
    return [...this.#values.entries()].reverse();
  }
}

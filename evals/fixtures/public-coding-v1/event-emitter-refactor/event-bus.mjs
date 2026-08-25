export class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return () => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    };
  }

  once(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    const wrapped = (...args) => {
      listener(...args);
      const index = listeners.indexOf(wrapped);
      if (index >= 0) listeners.splice(index, 1);
    };
    listeners.push(wrapped);
    this.listeners.set(event, listeners);
    return () => this.off(event, listener);
  }

  off(event) {
    this.listeners.delete(event);
  }

  emit(event, ...args) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

import type { ProviderAdapter } from "./provider.js";

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  public register(adapter: ProviderAdapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Provider adapter "${adapter.name}" is already registered.`);
    }
    this.adapters.set(adapter.name, adapter);
  }

  public get(name: string): ProviderAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`Provider adapter "${name}" is not registered.`);
    }
    return adapter;
  }

  public list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }
}

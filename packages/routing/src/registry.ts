import type { ModelDefinition } from "@vartma/canonical";

export class ModelRegistry {
  private readonly byId = new Map<string, ModelDefinition>();

  public constructor(models: Iterable<ModelDefinition>) {
    for (const model of models) {
      if (this.byId.has(model.id)) {
        throw new Error(`Model "${model.id}" is registered more than once.`);
      }
      this.byId.set(model.id, model);
    }
  }

  public get(id: string): ModelDefinition | undefined {
    return this.byId.get(id);
  }

  public require(id: string): ModelDefinition {
    const model = this.get(id);
    if (!model) {
      throw new RoutingError(`Model "${id}" is not configured.`, "model_not_found");
    }
    return model;
  }

  public list(): ModelDefinition[] {
    return [...this.byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}

export class RoutingError extends Error {
  public constructor(
    message: string,
    public readonly code: "model_not_found" | "fixed_model_required" | "no_eligible_model",
  ) {
    super(message);
    this.name = "RoutingError";
  }
}

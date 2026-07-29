import type { ModelDefinition } from "@vartma/canonical";
import type { RouterConfig } from "@vartma/config";
import {
  AnthropicProvider,
  FakeProvider,
  GeminiProvider,
  OpenAICompatibleProvider,
  OpenAIProvider,
  type ProviderAdapter,
  ProviderRegistry,
} from "@vartma/providers";

export interface Runtime {
  registry: ProviderRegistry;
  models: Map<string, ModelDefinition>;
}

export function createRuntime(config: RouterConfig): Runtime {
  const registry = new ProviderRegistry();
  const models = new Map<string, ModelDefinition>();

  for (const provider of config.providers) {
    if (!provider.enabled) {
      continue;
    }

    const enabledModels = provider.models.filter((model) => model.enabled);
    if (enabledModels.length === 0) {
      continue;
    }
    for (const model of enabledModels) {
      if (model.provider !== provider.id) {
        throw new Error(
          `Model "${model.id}" declares provider "${model.provider}" but is nested under "${provider.id}".`,
        );
      }
    }

    registry.register(createProviderAdapter(provider, enabledModels));

    for (const model of enabledModels) {
      if (models.has(model.id)) {
        throw new Error(`Model ID "${model.id}" is configured more than once.`);
      }
      models.set(model.id, model);
    }
  }

  if (registry.list().length === 0) {
    throw new Error("No implemented and enabled provider adapters are configured.");
  }
  if (!models.has(config.routing.defaultModel)) {
    throw new Error(`Default model "${config.routing.defaultModel}" is not enabled or configured.`);
  }

  return { registry, models };
}

function createProviderAdapter(
  provider: RouterConfig["providers"][number],
  models: ModelDefinition[],
): ProviderAdapter {
  const shared = {
    name: provider.id,
    models,
    requestTimeoutMs: provider.requestTimeoutMs,
    maxRetries: provider.maxRetries,
  };

  switch (provider.type) {
    case "fake": {
      const firstModel = models[0];
      if (!firstModel) {
        throw new Error(`Fake provider "${provider.id}" has no enabled model.`);
      }
      return new FakeProvider({
        name: provider.id,
        model: firstModel.upstreamModel,
      });
    }
    case "anthropic":
      return new AnthropicProvider({
        ...shared,
        apiKey: readProviderApiKey(provider),
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      });
    case "openai":
      return new OpenAIProvider({
        ...shared,
        apiKey: readProviderApiKey(provider),
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      });
    case "openai-compatible":
      return new OpenAICompatibleProvider({
        ...shared,
        apiKey: readProviderApiKey(provider),
        baseUrl: requireBaseUrl(provider),
      });
    case "gemini":
      return new GeminiProvider({
        ...shared,
        apiKey: readProviderApiKey(provider),
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      });
  }
}

function requireBaseUrl(provider: RouterConfig["providers"][number]): string {
  if (!provider.baseUrl) {
    throw new Error(`Provider "${provider.id}" requires a baseUrl.`);
  }
  return provider.baseUrl;
}

function readProviderApiKey(provider: RouterConfig["providers"][number]): string {
  if (!provider.apiKeyEnv) {
    throw new Error(
      `Provider "${provider.id}" requires apiKeyEnv to name its API-key environment variable.`,
    );
  }
  const value = process.env[provider.apiKeyEnv];
  if (!value?.trim()) {
    throw new Error(
      `Provider "${provider.id}" requires environment variable "${provider.apiKeyEnv}".`,
    );
  }
  return value;
}

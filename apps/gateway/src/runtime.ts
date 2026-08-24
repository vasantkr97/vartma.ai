import type { ModelDefinition } from "@vartma/canonical";
import { resolve } from "node:path";

import {
  readEncryptedCredential,
  resolveOpenAICompatibleEndpoint,
  type RouterConfig,
} from "@vartma/config";
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

export interface CreateRuntimeOptions {
  credentialStorePath?: string;
  environment?: NodeJS.ProcessEnv;
}

export function createRuntime(config: RouterConfig, options: CreateRuntimeOptions = {}): Runtime {
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

    registry.register(createProviderAdapter(provider, enabledModels, config, options));

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
  config: RouterConfig,
  runtimeOptions: CreateRuntimeOptions,
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
        apiKey: readProviderApiKey(provider, config, runtimeOptions),
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      });
    case "openai":
      return new OpenAIProvider({
        ...shared,
        apiKey: readProviderApiKey(provider, config, runtimeOptions),
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      });
    case "openai-compatible": {
      const compatible = resolveOpenAICompatibleEndpoint(provider);
      const apiKey =
        compatible.authentication === "none"
          ? undefined
          : readProviderApiKey(provider, config, runtimeOptions);
      return new OpenAICompatibleProvider({
        ...shared,
        ...(apiKey ? { apiKey } : {}),
        authentication: compatible.authentication,
        baseUrl: compatible.baseUrl,
        chatCompletionsPath: compatible.chatCompletionsPath,
        maxOutputTokensField: compatible.maxOutputTokensField,
        sendStreamUsage: compatible.sendStreamUsage,
      });
    }
    case "gemini":
      return new GeminiProvider({
        ...shared,
        apiKey: readProviderApiKey(provider, config, runtimeOptions),
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      });
  }
}

function readProviderApiKey(
  provider: RouterConfig["providers"][number],
  config: RouterConfig,
  options: CreateRuntimeOptions,
): string {
  const environment = options.environment ?? process.env;
  if (provider.credentialRef) {
    const masterKey = environment[config.credentials.masterKeyEnv];
    if (!masterKey) {
      throw new Error(
        `Provider "${provider.id}" uses encrypted credentials and requires master-key environment variable "${config.credentials.masterKeyEnv}".`,
      );
    }
    const credential = readEncryptedCredential({
      path: options.credentialStorePath ?? resolve(config.credentials.storePath),
      masterKey,
      reference: provider.credentialRef,
    });
    if (!credential) {
      throw new Error(
        `Provider "${provider.id}" credential reference "${provider.credentialRef}" was not found in the encrypted store.`,
      );
    }
    return credential;
  }
  if (!provider.apiKeyEnv) {
    throw new Error(`Provider "${provider.id}" requires apiKeyEnv or credentialRef.`);
  }
  const value = environment[provider.apiKeyEnv];
  if (!value?.trim()) {
    throw new Error(
      `Provider "${provider.id}" requires environment variable "${provider.apiKeyEnv}".`,
    );
  }
  return value;
}

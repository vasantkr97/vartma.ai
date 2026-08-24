import type { OpenAICompatibleProfile } from "./schema.js";

export interface OpenAICompatibleEndpointInput {
  id: string;
  profile?: OpenAICompatibleProfile | undefined;
  authentication?: "bearer" | "none" | undefined;
  baseUrl?: string | undefined;
  chatCompletionsPath?: string | undefined;
  modelsPath?: string | undefined;
  maxOutputTokensField?: "max_completion_tokens" | "max_tokens" | undefined;
  sendStreamUsage?: boolean | undefined;
}

export interface ResolvedOpenAICompatibleEndpoint {
  profile: OpenAICompatibleProfile;
  authentication: "bearer" | "none";
  baseUrl: string;
  chatCompletionsPath: string;
  modelsPath: string;
  maxOutputTokensField: "max_completion_tokens" | "max_tokens";
  sendStreamUsage: boolean;
}

export function resolveOpenAICompatibleEndpoint(
  provider: OpenAICompatibleEndpointInput,
): ResolvedOpenAICompatibleEndpoint {
  const profile = provider.profile ?? "generic";
  const defaults = profileDefaults(profile, provider);
  return {
    profile,
    authentication: provider.authentication ?? (profile === "ollama" ? "none" : "bearer"),
    ...defaults,
    ...(provider.baseUrl ? { baseUrl: trimTrailingSlash(provider.baseUrl) } : {}),
    ...(provider.chatCompletionsPath ? { chatCompletionsPath: provider.chatCompletionsPath } : {}),
    ...(provider.modelsPath ? { modelsPath: provider.modelsPath } : {}),
    ...(provider.maxOutputTokensField
      ? { maxOutputTokensField: provider.maxOutputTokensField }
      : {}),
    ...(provider.sendStreamUsage === undefined
      ? {}
      : { sendStreamUsage: provider.sendStreamUsage }),
  };
}

export function providerRequiresCredential(provider: {
  type: string;
  profile?: OpenAICompatibleProfile | undefined;
  authentication?: "bearer" | "none" | undefined;
}): boolean {
  if (provider.type === "fake") return false;
  if (provider.type !== "openai-compatible") return true;
  return (
    resolveOpenAICompatibleEndpoint({
      id: "credential-check",
      ...(provider.profile ? { profile: provider.profile } : {}),
      ...(provider.authentication ? { authentication: provider.authentication } : {}),
      ...(provider.profile === undefined ? { baseUrl: "http://localhost" } : {}),
    }).authentication === "bearer"
  );
}

function profileDefaults(
  profile: OpenAICompatibleProfile,
  provider: OpenAICompatibleEndpointInput,
): Omit<ResolvedOpenAICompatibleEndpoint, "profile" | "authentication"> {
  switch (profile) {
    case "kimi":
      return endpoint(
        "https://api.moonshot.ai",
        "/v1/chat/completions",
        "/v1/models",
        "max_completion_tokens",
        true,
      );
    case "deepseek":
      return endpoint(
        "https://api.deepseek.com",
        "/chat/completions",
        "/models",
        "max_tokens",
        false,
      );
    case "zai":
      return endpoint(
        "https://api.z.ai/api/paas/v4",
        "/chat/completions",
        "/models",
        "max_tokens",
        false,
      );
    case "xai":
      return endpoint(
        "https://api.x.ai",
        "/v1/chat/completions",
        "/v1/models",
        "max_tokens",
        false,
      );
    case "ollama":
      return endpoint(
        "http://127.0.0.1:11434",
        "/v1/chat/completions",
        "/v1/models",
        "max_completion_tokens",
        true,
      );
    case "generic":
      if (!provider.baseUrl) {
        throw new Error(`Provider "${provider.id}" requires a baseUrl.`);
      }
      return endpoint(
        provider.baseUrl,
        "/v1/chat/completions",
        "/v1/models",
        "max_completion_tokens",
        true,
      );
  }
}

function endpoint(
  baseUrl: string,
  chatCompletionsPath: string,
  modelsPath: string,
  maxOutputTokensField: "max_completion_tokens" | "max_tokens",
  sendStreamUsage: boolean,
): Omit<ResolvedOpenAICompatibleEndpoint, "profile" | "authentication"> {
  return {
    baseUrl: trimTrailingSlash(baseUrl),
    chatCompletionsPath,
    modelsPath,
    maxOutputTokensField,
    sendStreamUsage,
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

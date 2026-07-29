import type {
  CanonicalEvent,
  CanonicalRequest,
  CapabilitySet,
  HealthStatus,
  ModelDefinition,
  TokenEstimate,
} from "@vartma/canonical";
import { ProviderRegistry, type ProviderAdapter } from "@vartma/providers";

export interface TestModelOptions {
  id: string;
  provider?: string;
  qualityTier: number;
  inputPrice: number;
  outputPrice?: number;
  latencyTier?: number;
  expectedLatencyMs?: number;
  regions?: string[];
  capabilities?: Partial<CapabilitySet>;
  contextWindow?: number;
  maxOutputTokens?: number;
  enabled?: boolean;
}

export function testModel(options: TestModelOptions): ModelDefinition {
  const provider = options.provider ?? options.id.split("/")[0] ?? "test";
  return {
    id: options.id,
    provider,
    upstreamModel: `${options.id}-upstream`,
    enabled: options.enabled ?? true,
    capabilities: {
      text: true,
      vision: false,
      streaming: true,
      tools: true,
      structuredOutput: true,
      reasoning: false,
      ...options.capabilities,
    },
    contextWindow: options.contextWindow ?? 100_000,
    maxOutputTokens: options.maxOutputTokens ?? 4096,
    qualityTier: options.qualityTier,
    expectedLatencyTier: options.latencyTier ?? 2,
    ...(options.expectedLatencyMs ? { expectedLatencyMs: options.expectedLatencyMs } : {}),
    ...(options.regions ? { regions: options.regions } : {}),
    pricing: {
      currency: "USD",
      effectiveFrom: "2026-07-23",
      verifiedAt: "2026-07-23",
      source: "routing test fixture",
      inputPerMillion: options.inputPrice,
      cachedInputPerMillion: options.inputPrice / 10,
      outputPerMillion: options.outputPrice ?? options.inputPrice * 4,
    },
  };
}

export function testRequest(text = "Implement a function that adds two numbers"): CanonicalRequest {
  return {
    requestId: "routing-request-1",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    tools: [],
    maxOutputTokens: 512,
    routingMode: "balanced",
    constraints: { requiredCapabilities: [] },
    metadata: {},
  };
}

export class TestProvider implements ProviderAdapter {
  public readonly name: string;

  public constructor(
    name: string,
    private readonly definitions: ModelDefinition[],
    private readonly status: HealthStatus = {
      healthy: true,
      observedAt: new Date(0).toISOString(),
      latencyMs: 10,
    },
    private readonly estimate: TokenEstimate = {
      inputTokens: 1000,
      expectedOutputTokens: 500,
    },
  ) {
    this.name = name;
  }

  public models(): Promise<ModelDefinition[]> {
    return Promise.resolve(this.definitions);
  }

  public capabilities(model: string): CapabilitySet {
    const definition = this.definitions.find(
      (candidate) => candidate.upstreamModel === model || candidate.id === model,
    );
    if (!definition) {
      throw new Error(`Unknown test model "${model}".`);
    }
    return definition.capabilities;
  }

  public estimateTokens(): Promise<TokenEstimate> {
    return Promise.resolve(this.estimate);
  }

  public execute(): AsyncIterable<CanonicalEvent> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<CanonicalEvent> {
        return {
          next: () => Promise.resolve({ done: true, value: undefined }),
        };
      },
    };
  }

  public health(): Promise<HealthStatus> {
    return Promise.resolve(this.status);
  }
}

export function providerRegistry(
  models: ModelDefinition[],
  healthByProvider: Record<string, HealthStatus> = {},
  estimate: TokenEstimate = { inputTokens: 1000, expectedOutputTokens: 500 },
): ProviderRegistry {
  const registry = new ProviderRegistry();
  const providers = new Map<string, ModelDefinition[]>();
  for (const model of models) {
    providers.set(model.provider, [...(providers.get(model.provider) ?? []), model]);
  }
  for (const [provider, definitions] of providers) {
    registry.register(
      new TestProvider(
        provider,
        definitions,
        healthByProvider[provider] ?? {
          healthy: true,
          observedAt: new Date(0).toISOString(),
          latencyMs: 10,
        },
        estimate,
      ),
    );
  }
  return registry;
}

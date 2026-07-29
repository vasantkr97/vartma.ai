import { modelDefinitionSchema, routingModeSchema } from "@vartma/canonical";
import {
  circuitBreakerPolicySchema,
  fallbackPolicySchema,
  routingPoliciesSchema,
  sessionRoutingPolicySchema,
} from "@vartma/routing";
import { z } from "zod";

export const providerConfigSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["fake", "anthropic", "openai", "gemini", "openai-compatible"]),
    enabled: z.boolean().default(true),
    baseUrl: z.url().optional(),
    apiKeyEnv: z.string().min(1).optional(),
    requestTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(30 * 60 * 1000)
      .default(120_000),
    maxRetries: z.number().int().min(0).max(5).default(2),
    models: z.array(modelDefinitionSchema).min(1),
  })
  .strict()
  .superRefine((provider, context) => {
    if (provider.type !== "fake" && !provider.apiKeyEnv) {
      context.addIssue({
        code: "custom",
        path: ["apiKeyEnv"],
        message: `Provider type "${provider.type}" requires apiKeyEnv.`,
      });
    }
    if (provider.type === "openai-compatible" && !provider.baseUrl) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: 'Provider type "openai-compatible" requires baseUrl.',
      });
    }
  });

const langSmithSchema = z
  .object({
    enabled: z.boolean().default(false),
    apiKeyEnv: z.string().min(1).default("LANGSMITH_API_KEY"),
    project: z.string().min(1).default("vartma-development"),
    exportContent: z.boolean().default(false),
  })
  .strict()
  .default({
    enabled: false,
    apiKeyEnv: "LANGSMITH_API_KEY",
    project: "vartma-development",
    exportContent: false,
  });

export const routerConfigSchema = z
  .object({
    environment: z.enum(["development", "test", "production"]).default("development"),
    server: z
      .object({
        host: z.string().min(1).default("127.0.0.1"),
        port: z.number().int().min(1).max(65535).default(8080),
        trustProxy: z.boolean().default(false),
        requestBodyLimitBytes: z
          .number()
          .int()
          .positive()
          .default(10 * 1024 * 1024),
      })
      .strict(),
    auth: z
      .object({
        enabled: z.boolean().default(true),
        apiKeys: z.array(z.string().min(8)).default([]),
      })
      .strict(),
    database: z
      .object({
        url: z.string().min(1),
        requiredForReadiness: z.boolean().default(false),
      })
      .strict(),
    routing: z
      .object({
        defaultMode: routingModeSchema.default("balanced"),
        defaultModel: z.string().min(1),
        baselineModel: z.string().min(1).optional(),
        routerVersion: z.string().min(1).default("rules-v0"),
        priceBookVersion: z.string().min(1).default("prices-v1"),
        policies: routingPoliciesSchema,
        session: sessionRoutingPolicySchema,
        fallback: fallbackPolicySchema,
        circuitBreaker: circuitBreakerPolicySchema,
      })
      .strict(),
    providers: z.array(providerConfigSchema).min(1),
    telemetry: z
      .object({
        serviceName: z.string().min(1).default("vartma-gateway"),
        logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
        langSmith: langSmithSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    const providerIds = new Set<string>();
    const modelIds = new Set<string>();
    let defaultModelEnabled = false;
    let baselineModelEnabled = config.routing.baselineModel === undefined;

    for (const [providerIndex, provider] of config.providers.entries()) {
      if (providerIds.has(provider.id)) {
        context.addIssue({
          code: "custom",
          path: ["providers", providerIndex, "id"],
          message: `Duplicate provider id "${provider.id}".`,
        });
      }
      providerIds.add(provider.id);

      for (const [modelIndex, model] of provider.models.entries()) {
        if (model.provider !== provider.id) {
          context.addIssue({
            code: "custom",
            path: ["providers", providerIndex, "models", modelIndex, "provider"],
            message: `Model provider "${model.provider}" must match containing provider "${provider.id}".`,
          });
        }
        if (modelIds.has(model.id)) {
          context.addIssue({
            code: "custom",
            path: ["providers", providerIndex, "models", modelIndex, "id"],
            message: `Duplicate model id "${model.id}".`,
          });
        }
        modelIds.add(model.id);
        if (provider.enabled && model.enabled && model.id === config.routing.defaultModel) {
          defaultModelEnabled = true;
        }
        if (provider.enabled && model.enabled && model.id === config.routing.baselineModel) {
          baselineModelEnabled = true;
        }
      }
    }

    if (!defaultModelEnabled) {
      context.addIssue({
        code: "custom",
        path: ["routing", "defaultModel"],
        message: `Default model "${config.routing.defaultModel}" must identify an enabled model on an enabled provider.`,
      });
    }
    if (!baselineModelEnabled) {
      context.addIssue({
        code: "custom",
        path: ["routing", "baselineModel"],
        message: `Baseline model "${config.routing.baselineModel}" must identify an enabled model on an enabled provider.`,
      });
    }
  });

export type RouterConfig = z.infer<typeof routerConfigSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

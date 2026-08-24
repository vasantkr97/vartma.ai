import { modelDefinitionSchema, routingModeSchema } from "@vartma/canonical";
import {
  circuitBreakerPolicySchema,
  contextCompressionPolicySchema,
  fallbackPolicySchema,
  routingCalibrationSchema,
  routingPoliciesSchema,
  sessionRoutingPolicySchema,
} from "@vartma/routing";
import { z } from "zod";

export const openAICompatibleProfileSchema = z.enum([
  "generic",
  "kimi",
  "deepseek",
  "zai",
  "xai",
  "ollama",
]);
export type OpenAICompatibleProfile = z.infer<typeof openAICompatibleProfileSchema>;

const providerApiPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !value.includes("\\") &&
      !value.includes("..") &&
      !value.includes("?") &&
      !value.includes("#"),
    "Provider API paths must be absolute paths without traversal, query parameters, or fragments.",
  );

export const providerConfigSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["fake", "anthropic", "openai", "gemini", "openai-compatible"]),
    enabled: z.boolean().default(true),
    baseUrl: z.url().optional(),
    apiKeyEnv: z.string().min(1).optional(),
    credentialRef: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u)
      .optional(),
    authentication: z.enum(["bearer", "none"]).optional(),
    profile: openAICompatibleProfileSchema.optional(),
    chatCompletionsPath: providerApiPathSchema.optional(),
    modelsPath: providerApiPathSchema.optional(),
    maxOutputTokensField: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
    sendStreamUsage: z.boolean().optional(),
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
    const credentialRequired =
      provider.type !== "fake" &&
      !(
        provider.type === "openai-compatible" &&
        (provider.authentication === "none" ||
          (provider.authentication === undefined && provider.profile === "ollama"))
      );
    if (credentialRequired && !provider.apiKeyEnv && !provider.credentialRef) {
      context.addIssue({
        code: "custom",
        path: ["apiKeyEnv"],
        message: `Provider type "${provider.type}" requires apiKeyEnv or credentialRef.`,
      });
    }
    if (
      provider.type === "openai-compatible" &&
      !provider.baseUrl &&
      (!provider.profile || provider.profile === "generic")
    ) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message:
          'Provider type "openai-compatible" requires baseUrl unless a named compatibility profile is selected.',
      });
    }
    if (
      provider.type !== "openai-compatible" &&
      (provider.authentication ||
        provider.profile ||
        provider.chatCompletionsPath ||
        provider.modelsPath ||
        provider.maxOutputTokensField ||
        provider.sendStreamUsage !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["authentication"],
        message:
          "Compatibility authentication, profile, and path options are only valid for openai-compatible providers.",
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
    credentials: z
      .object({
        storePath: z.string().min(1).default(".vartma/credentials.enc"),
        masterKeyEnv: z.string().min(1).default("VARTMA_MASTER_KEY"),
      })
      .strict()
      .default({
        storePath: ".vartma/credentials.enc",
        masterKeyEnv: "VARTMA_MASTER_KEY",
      }),
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
        calibration: routingCalibrationSchema,
        context: contextCompressionPolicySchema,
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

    for (const modelId of Object.keys(config.routing.calibration.models)) {
      if (!modelIds.has(modelId)) {
        context.addIssue({
          code: "custom",
          path: ["routing", "calibration", "models", modelId],
          message: `Calibrated model "${modelId}" is not configured.`,
        });
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

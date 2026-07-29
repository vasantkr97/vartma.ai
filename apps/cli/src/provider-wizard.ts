import { providerConfigSchema, type ProviderConfig } from "@vartma/config";

const PROVIDER_TYPES = ["anthropic", "openai", "gemini", "openai-compatible", "fake"] as const;

type ProviderType = (typeof PROVIDER_TYPES)[number];

export interface ProviderWizardOptions {
  ask: (prompt: string) => Promise<string>;
  write?: (message: string) => void;
  now?: () => Date;
  existingProviderIds?: Iterable<string>;
  existingModelIds?: Iterable<string>;
}

export async function buildProviderInteractively(
  options: ProviderWizardOptions,
): Promise<ProviderConfig> {
  const write = options.write ?? (() => undefined);
  write(
    "Provider secrets are not collected. Enter only the environment-variable name that will contain the API key.\n",
  );

  const providerIds = new Set(options.existingProviderIds ?? []);
  const modelIds = new Set(options.existingModelIds ?? []);
  const id = await askUniqueMatching(
    options,
    "Provider ID",
    undefined,
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u,
    "Use letters, numbers, dot, underscore, or hyphen.",
    providerIds,
  );
  const type = await askChoice(options, "Provider type", PROVIDER_TYPES);
  const enabled = await askBoolean(options, "Enable this provider immediately", false);
  const baseUrl = await providerBaseUrl(options, type);
  const apiKeyEnv =
    type === "fake"
      ? undefined
      : await askMatching(
          options,
          "API-key environment variable",
          defaultCredentialEnvironment(type),
          /^[A-Za-z_][A-Za-z0-9_]*$/u,
          "Use a portable environment-variable name such as PROVIDER_API_KEY.",
        );
  const requestTimeoutMs = await askInteger(
    options,
    "Request timeout in milliseconds",
    120_000,
    1,
    30 * 60 * 1_000,
  );
  const maxRetries = await askInteger(options, "Maximum retries", 2, 0, 5);
  const models = [];

  do {
    const upstreamModel = await askRequired(options, "Upstream model name");
    const modelId = await askUniqueRequired(
      options,
      "Router model ID",
      `${id}/${upstreamModel}`,
      modelIds,
    );
    modelIds.add(modelId);
    const text = await askBoolean(options, "Supports text", true);
    const vision = await askBoolean(options, "Supports image input", false);
    const streaming = await askBoolean(options, "Supports streaming", true);
    const tools = await askBoolean(options, "Supports tool calling", true);
    const structuredOutput = await askBoolean(options, "Supports structured output", false);
    const reasoning = await askBoolean(options, "Supports reasoning output", false);
    const contextWindow = await askInteger(
      options,
      "Context window in tokens",
      undefined,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const maxOutputTokens = await askInteger(
      options,
      "Maximum output tokens",
      undefined,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const qualityTier = await askInteger(options, "Quality tier (1-5)", undefined, 1, 5);
    const expectedLatencyTier = await askInteger(
      options,
      "Expected latency tier (1=fastest, 5=slowest)",
      undefined,
      1,
      5,
    );
    const expectedLatencyMs = await askOptionalInteger(
      options,
      "Measured expected latency in milliseconds (optional)",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const regions = commaSeparated(
      await askOptional(options, "Allowed regions, comma-separated (optional)"),
    );
    const date = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
    const effectiveFrom = await askDate(options, "Price effective date", date);
    const verifiedAt = await askDate(options, "Price verification date", date);
    const source = await askRequired(
      options,
      "Pricing source URL or operator-supplied cost description",
    );
    const inputPerMillion = await askNumber(options, "Input price per million tokens (USD)", 0);
    const cachedInputPerMillion = await askNumber(
      options,
      "Cached-input price per million tokens (USD)",
      0,
    );
    const outputPerMillion = await askNumber(options, "Output price per million tokens (USD)", 0);
    const reasoningPerMillion = await askOptionalNumber(
      options,
      "Reasoning-token price per million tokens (USD, optional)",
      0,
    );

    models.push({
      id: modelId,
      provider: id,
      upstreamModel,
      enabled: true,
      capabilities: {
        text,
        vision,
        streaming,
        tools,
        structuredOutput,
        reasoning,
      },
      contextWindow,
      maxOutputTokens,
      qualityTier,
      expectedLatencyTier,
      ...(expectedLatencyMs === undefined ? {} : { expectedLatencyMs }),
      ...(regions.length ? { regions } : {}),
      pricing: {
        currency: "USD" as const,
        effectiveFrom,
        verifiedAt,
        source,
        inputPerMillion,
        cachedInputPerMillion,
        outputPerMillion,
        ...(reasoningPerMillion === undefined ? {} : { reasoningPerMillion }),
      },
    });
  } while (await askBoolean(options, "Add another model to this provider", false));

  return providerConfigSchema.parse({
    id,
    type,
    enabled,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    requestTimeoutMs,
    maxRetries,
    models,
  });
}

async function providerBaseUrl(
  options: ProviderWizardOptions,
  type: ProviderType,
): Promise<string | undefined> {
  const required = type === "openai-compatible";
  while (true) {
    const value = required
      ? await askRequired(options, "Provider base URL")
      : await askOptional(options, "Custom provider base URL (optional)");
    if (!value) {
      return undefined;
    }
    try {
      const url = new URL(value);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      ) {
        return value.replace(/\/+$/u, "");
      }
    } catch {
      // The retry message below is intentionally secret-free.
    }
    options.write?.(
      "Enter an HTTP(S) base URL without credentials, query parameters, or a fragment.\n",
    );
  }
}

async function askChoice<const T extends readonly string[]>(
  options: ProviderWizardOptions,
  label: string,
  choices: T,
): Promise<T[number]> {
  while (true) {
    const value = await askRequired(options, `${label} (${choices.join(", ")})`);
    if (choices.includes(value)) {
      return value;
    }
    options.write?.(`Choose one of: ${choices.join(", ")}.\n`);
  }
}

async function askBoolean(
  options: ProviderWizardOptions,
  label: string,
  defaultValue: boolean,
): Promise<boolean> {
  while (true) {
    const suffix = defaultValue ? "Y/n" : "y/N";
    const value = (await options.ask(`${label} [${suffix}]: `)).trim().toLowerCase();
    if (!value) {
      return defaultValue;
    }
    if (value === "y" || value === "yes") {
      return true;
    }
    if (value === "n" || value === "no") {
      return false;
    }
    options.write?.('Enter "yes" or "no".\n');
  }
}

async function askRequired(
  options: ProviderWizardOptions,
  label: string,
  defaultValue?: string,
): Promise<string> {
  while (true) {
    const suffix = defaultValue === undefined ? "" : ` [${defaultValue}]`;
    const value = (await options.ask(`${label}${suffix}: `)).trim();
    if (value) {
      return value;
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    options.write?.(`${label} is required.\n`);
  }
}

async function askOptional(options: ProviderWizardOptions, label: string): Promise<string> {
  return (await options.ask(`${label}: `)).trim();
}

async function askMatching(
  options: ProviderWizardOptions,
  label: string,
  defaultValue: string | undefined,
  pattern: RegExp,
  errorMessage: string,
): Promise<string> {
  while (true) {
    const value = await askRequired(options, label, defaultValue);
    if (pattern.test(value)) {
      return value;
    }
    options.write?.(`${errorMessage}\n`);
  }
}

async function askUniqueMatching(
  options: ProviderWizardOptions,
  label: string,
  defaultValue: string | undefined,
  pattern: RegExp,
  errorMessage: string,
  existing: ReadonlySet<string>,
): Promise<string> {
  while (true) {
    const value = await askMatching(options, label, defaultValue, pattern, errorMessage);
    if (!existing.has(value)) {
      return value;
    }
    options.write?.(`${label} "${value}" already exists. Choose another value.\n`);
  }
}

async function askUniqueRequired(
  options: ProviderWizardOptions,
  label: string,
  defaultValue: string,
  existing: ReadonlySet<string>,
): Promise<string> {
  while (true) {
    const value = await askRequired(options, label, defaultValue);
    if (!existing.has(value)) {
      return value;
    }
    options.write?.(`${label} "${value}" already exists. Choose another value.\n`);
  }
}

async function askInteger(
  options: ProviderWizardOptions,
  label: string,
  defaultValue: number | undefined,
  minimum: number,
  maximum: number,
): Promise<number> {
  while (true) {
    const value = await askRequired(
      options,
      label,
      defaultValue === undefined ? undefined : String(defaultValue),
    );
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum) {
      return parsed;
    }
    options.write?.(`Enter an integer from ${String(minimum)} to ${String(maximum)}.\n`);
  }
}

async function askOptionalInteger(
  options: ProviderWizardOptions,
  label: string,
  minimum: number,
  maximum: number,
): Promise<number | undefined> {
  while (true) {
    const value = await askOptional(options, label);
    if (!value) {
      return undefined;
    }
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum) {
      return parsed;
    }
    options.write?.(`Enter an integer from ${String(minimum)} to ${String(maximum)}, or blank.\n`);
  }
}

async function askNumber(
  options: ProviderWizardOptions,
  label: string,
  minimum: number,
): Promise<number> {
  while (true) {
    const value = await askRequired(options, label);
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= minimum) {
      return parsed;
    }
    options.write?.(`Enter a number greater than or equal to ${String(minimum)}.\n`);
  }
}

async function askOptionalNumber(
  options: ProviderWizardOptions,
  label: string,
  minimum: number,
): Promise<number | undefined> {
  while (true) {
    const value = await askOptional(options, label);
    if (!value) {
      return undefined;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= minimum) {
      return parsed;
    }
    options.write?.(`Enter a number greater than or equal to ${String(minimum)}, or blank.\n`);
  }
}

async function askDate(
  options: ProviderWizardOptions,
  label: string,
  defaultValue: string,
): Promise<string> {
  while (true) {
    const value = await askRequired(options, label, defaultValue);
    if (isCalendarDate(value)) {
      return value;
    }
    options.write?.("Enter a valid date in YYYY-MM-DD format.\n");
  }
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function commaSeparated(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function defaultCredentialEnvironment(type: Exclude<ProviderType, "fake">): string {
  switch (type) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    case "openai-compatible":
      return "COMPATIBLE_API_KEY";
  }
}

import { resolve } from "node:path";

import {
  providerRequiresCredential,
  readEncryptedCredential,
  resolveOpenAICompatibleEndpoint,
  type RouterConfig,
} from "@vartma/config";
import { checkDatabase, createDatabase } from "@vartma/database";

export type DoctorCheckStatus = "pass" | "fail" | "skip";
export type DoctorCheckCategory =
  "configuration" | "credential" | "provider" | "gateway" | "database";

export interface DoctorCheck {
  id: string;
  category: DoctorCheckCategory;
  status: DoctorCheckStatus;
  message: string;
  durationMs: number;
}

export interface DoctorReport {
  ok: boolean;
  generatedAt: string;
  checks: DoctorCheck[];
}

export interface DoctorDependencies {
  environment?: NodeJS.ProcessEnv;
  fetchImplementation?: typeof fetch;
  databaseCheck?: (connectionString: string) => Promise<void>;
  now?: () => Date;
}

export async function runDoctor(
  config: RouterConfig,
  options: { timeoutMs: number; credentialStorePath?: string },
  dependencies: DoctorDependencies = {},
): Promise<DoctorReport> {
  const environment = dependencies.environment ?? process.env;
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const checks: DoctorCheck[] = [
    {
      id: "configuration",
      category: "configuration",
      status: "pass",
      message: `${String(config.providers.length)} providers parsed; default model is ${config.routing.defaultModel}.`,
      durationMs: 0,
    },
  ];
  checks.push(
    ...(await runProviderDiagnostics(
      config,
      {
        timeoutMs: options.timeoutMs,
        ...(options.credentialStorePath
          ? { credentialStorePath: options.credentialStorePath }
          : {}),
      },
      { environment, fetchImplementation },
    )),
  );

  checks.push(
    await checkGateway(config, fetchImplementation, options.timeoutMs),
    await checkConfiguredDatabase(config.database.url, dependencies.databaseCheck),
  );

  return {
    ok: checks.every((check) => check.status !== "fail"),
    generatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    checks,
  };
}

export async function runProviderDiagnostics(
  config: RouterConfig,
  options: { timeoutMs: number; providerId?: string; credentialStorePath?: string },
  dependencies: Pick<DoctorDependencies, "environment" | "fetchImplementation"> = {},
): Promise<DoctorCheck[]> {
  const environment = dependencies.environment ?? process.env;
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const providers = config.providers.filter(
    (provider) => provider.enabled && (!options.providerId || provider.id === options.providerId),
  );
  const credentials = new Map(
    providers.map((provider) => [
      provider.id,
      resolveProviderCredential(
        provider,
        config,
        environment,
        options.credentialStorePath ?? resolve(config.credentials.storePath),
      ),
    ]),
  );
  const credentialChecks = credentialDiagnostics(providers, credentials);
  const missingCredentials = new Set(
    credentialChecks
      .filter((check) => check.status === "fail")
      .map((check) => check.id.replace(/^credential:/, "")),
  );
  const providerChecks = await Promise.all(
    providers.flatMap((provider) =>
      provider.models
        .filter((model) => model.enabled)
        .map((model) =>
          missingCredentials.has(provider.id)
            ? Promise.resolve<DoctorCheck>({
                id: `provider:${provider.id}:${model.upstreamModel}`,
                category: "provider",
                status: "skip",
                message: "Connectivity skipped because the provider credential is missing.",
                durationMs: 0,
              })
            : checkProviderModel(
                provider,
                model.upstreamModel,
                credentials.get(provider.id)?.value,
                fetchImplementation,
                options.timeoutMs,
              ),
        ),
    ),
  );
  return [...credentialChecks, ...providerChecks];
}

export function formatDoctorReport(report: DoctorReport): string {
  return formatDiagnosticReport(report, "Doctor");
}

export function formatDiagnosticReport(report: DoctorReport, label: string): string {
  return `${report.checks
    .map(
      (check) =>
        `${doctorStatusLabel(check.status)} ${check.category}/${check.id} ${check.message} (${String(check.durationMs)}ms)`,
    )
    .join("\n")}\n\n${label} result: ${report.ok ? "PASS" : "FAIL"}\n`;
}

function credentialDiagnostics(
  providers: RouterConfig["providers"],
  credentials: Map<string, ResolvedCredential>,
): DoctorCheck[] {
  return providers
    .filter((provider) => provider.enabled && provider.type !== "fake")
    .map((provider) => {
      if (!providerRequiresCredential(provider)) {
        return {
          id: `credential:${provider.id}`,
          category: "credential" as const,
          status: "pass" as const,
          message: "Provider is configured for unauthenticated access.",
          durationMs: 0,
        };
      }
      const credential = credentials.get(provider.id) ?? {
        message: "Provider credential configuration is invalid.",
      };
      const present = Boolean(credential.value);
      return {
        id: `credential:${provider.id}`,
        category: "credential" as const,
        status: present ? ("pass" as const) : ("fail" as const),
        message: credential.message,
        durationMs: 0,
      };
    });
}

async function checkProviderModel(
  provider: RouterConfig["providers"][number],
  upstreamModel: string,
  apiKey: string | undefined,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
): Promise<DoctorCheck> {
  const startedAt = performance.now();
  if (provider.type === "fake") {
    return {
      id: `provider:${provider.id}:${upstreamModel}`,
      category: "provider",
      status: "pass",
      message: "Deterministic in-process provider is available.",
      durationMs: elapsed(startedAt),
    };
  }
  if (providerRequiresCredential(provider) && !apiKey) {
    return {
      id: `provider:${provider.id}:${upstreamModel}`,
      category: "provider",
      status: "skip",
      message: "Connectivity skipped because the provider credential is missing.",
      durationMs: elapsed(startedAt),
    };
  }
  try {
    const probe = providerProbe(provider, upstreamModel, apiKey);
    const response = await fetchImplementation(probe.url, {
      method: "GET",
      headers: probe.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok && probe.modelList) {
      const modelAvailable = await openAiCompatibleModelAvailable(response, upstreamModel);
      return {
        id: `provider:${provider.id}:${upstreamModel}`,
        category: "provider",
        status: modelAvailable ? "pass" : "fail",
        message: modelAvailable
          ? `Model ${upstreamModel} is present in the HTTP ${String(response.status)} model list.`
          : `Model list responded with HTTP ${String(response.status)}, but ${upstreamModel} was not present.`,
        durationMs: elapsed(startedAt),
      };
    }
    return {
      id: `provider:${provider.id}:${upstreamModel}`,
      category: "provider",
      status: response.ok ? "pass" : "fail",
      message: response.ok
        ? `Model endpoint responded with HTTP ${String(response.status)}.`
        : `Model endpoint responded with HTTP ${String(response.status)} ${response.statusText || "error"}.`,
      durationMs: elapsed(startedAt),
    };
  } catch (error) {
    return {
      id: `provider:${provider.id}:${upstreamModel}`,
      category: "provider",
      status: "fail",
      message: `Connectivity failed: ${safeErrorMessage(error)}.`,
      durationMs: elapsed(startedAt),
    };
  }
}

interface ResolvedCredential {
  value?: string;
  message: string;
}

function resolveProviderCredential(
  provider: RouterConfig["providers"][number],
  config: RouterConfig,
  environment: NodeJS.ProcessEnv,
  credentialStorePath: string,
): ResolvedCredential {
  if (provider.type === "fake") {
    return { value: "not-required", message: "Provider does not require a credential." };
  }
  if (provider.credentialRef) {
    const masterKey = environment[config.credentials.masterKeyEnv];
    if (!masterKey) {
      return {
        message: `Missing credential master-key environment variable ${config.credentials.masterKeyEnv}.`,
      };
    }
    try {
      const value = readEncryptedCredential({
        path: credentialStorePath,
        masterKey,
        reference: provider.credentialRef,
      });
      return value
        ? {
            value,
            message: `Encrypted credential reference ${provider.credentialRef} is present.`,
          }
        : {
            message: `Encrypted credential reference ${provider.credentialRef} is missing.`,
          };
    } catch {
      return { message: "Encrypted credential authentication failed." };
    }
  }
  const environmentName = provider.apiKeyEnv;
  const value = environmentName ? environment[environmentName]?.trim() : undefined;
  return value
    ? { value, message: `Credential environment variable ${environmentName} is set.` }
    : {
        message: environmentName
          ? `Missing credential environment variable ${environmentName}.`
          : "Provider has no credential source configured.",
      };
}

function providerProbe(
  provider: RouterConfig["providers"][number],
  upstreamModel: string,
  apiKey: string | undefined,
): { url: string; headers: Record<string, string>; modelList?: boolean } {
  switch (provider.type) {
    case "anthropic":
      return {
        url: `${trimTrailingSlash(provider.baseUrl ?? "https://api.anthropic.com")}/v1/models/${encodeURIComponent(upstreamModel)}`,
        headers: {
          "x-api-key": apiKey!,
          "anthropic-version": "2023-06-01",
        },
      };
    case "openai":
      return {
        url: `${trimTrailingSlash(provider.baseUrl ?? "https://api.openai.com")}/v1/models/${encodeURIComponent(upstreamModel)}`,
        headers: { authorization: `Bearer ${apiKey!}` },
      };
    case "openai-compatible": {
      const compatible = resolveOpenAICompatibleEndpoint(provider);
      return {
        url: `${compatible.baseUrl}${compatible.modelsPath}`,
        headers:
          compatible.authentication === "bearer" ? { authorization: `Bearer ${apiKey!}` } : {},
        modelList: true,
      };
    }
    case "gemini":
      return {
        url: `${trimTrailingSlash(provider.baseUrl ?? "https://generativelanguage.googleapis.com")}/v1beta/models/${encodeURIComponent(upstreamModel)}`,
        headers: { "x-goog-api-key": apiKey! },
      };
    case "fake":
      throw new Error("The fake provider does not require an HTTP probe.");
  }
}

async function checkGateway(
  config: RouterConfig,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
): Promise<DoctorCheck> {
  const startedAt = performance.now();
  const configuredHost =
    config.server.host === "0.0.0.0" || config.server.host === "::"
      ? "127.0.0.1"
      : config.server.host;
  const host = configuredHost.includes(":") ? `[${configuredHost}]` : configuredHost;
  const url = `http://${host}:${String(config.server.port)}/readyz`;
  try {
    const response = await fetchImplementation(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      id: "gateway",
      category: "gateway",
      status: response.ok ? "pass" : "fail",
      message: response.ok
        ? `Readiness endpoint responded with HTTP ${String(response.status)}.`
        : `Readiness endpoint responded with HTTP ${String(response.status)} ${response.statusText || "not ready"}.`,
      durationMs: elapsed(startedAt),
    };
  } catch (error) {
    return {
      id: "gateway",
      category: "gateway",
      status: "fail",
      message: `Readiness request failed: ${safeErrorMessage(error)}.`,
      durationMs: elapsed(startedAt),
    };
  }
}

async function checkConfiguredDatabase(
  connectionString: string,
  injectedCheck?: (connectionString: string) => Promise<void>,
): Promise<DoctorCheck> {
  const startedAt = performance.now();
  try {
    if (injectedCheck) {
      await injectedCheck(connectionString);
    } else {
      const database = createDatabase(connectionString);
      try {
        await checkDatabase(database);
      } finally {
        await database.$disconnect();
      }
    }
    return {
      id: "database",
      category: "database",
      status: "pass",
      message: "PostgreSQL query completed.",
      durationMs: elapsed(startedAt),
    };
  } catch (error) {
    return {
      id: "database",
      category: "database",
      status: "fail",
      message: `PostgreSQL check failed: ${safeErrorMessage(error)}.`,
      durationMs: elapsed(startedAt),
    };
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function doctorStatusLabel(status: DoctorCheckStatus): string {
  switch (status) {
    case "pass":
      return "PASS";
    case "fail":
      return "FAIL";
    case "skip":
      return "SKIP";
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return message
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/\b(api[-_ ]?key|token|password|secret)\b(\s*[:=]\s*|\s+)\S+/giu, "$1$2[REDACTED]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9._-]{8,}\b/gu, "[REDACTED]");
}

async function openAiCompatibleModelAvailable(
  response: Response,
  upstreamModel: string,
): Promise<boolean> {
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("data" in payload)) {
    return false;
  }
  const data = (payload as { data?: unknown }).data;
  return (
    Array.isArray(data) &&
    data.some(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        "id" in candidate &&
        (candidate as { id?: unknown }).id === upstreamModel,
    )
  );
}

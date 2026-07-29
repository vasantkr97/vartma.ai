import { resolve } from "node:path";

import { loadConfig, type RouterConfig } from "@vartma/config";

import {
  claudeCodeStatus,
  resolveClaudeSettingsPath,
  type ClaudeCodeStatus,
  type ClaudeSettingsLocationOptions,
} from "./claude-code-settings.js";

export interface OperatorStatusDependencies {
  environment?: NodeJS.ProcessEnv;
  fetchImplementation?: typeof fetch;
  loadConfigImplementation?: typeof loadConfig;
  claudeStatusImplementation?: typeof claudeCodeStatus;
  now?: () => Date;
}

export interface OperatorStatusReport {
  ok: boolean;
  generatedAt: string;
  configuration:
    | {
        state: "valid";
        path: string;
        environment: RouterConfig["environment"];
        defaultMode: RouterConfig["routing"]["defaultMode"];
        defaultModel: string;
        baselineModel?: string;
        routerVersion: string;
        priceBookVersion: string;
        authenticationEnabled: boolean;
        configuredGatewayKeyCount: number;
        databaseRequiredForReadiness: boolean;
        providers: Array<{
          id: string;
          type: RouterConfig["providers"][number]["type"];
          enabled: boolean;
          enabledModelCount: number;
          credentialEnvironment?: string;
          credentialPresent: boolean;
        }>;
      }
    | {
        state: "missing" | "invalid";
        path: string;
      };
  gateway:
    | {
        state: "ready" | "not_ready" | "unreachable";
        url: string;
        statusCode?: number;
        durationMs: number;
      }
    | {
        state: "skipped";
        reason: "offline_requested" | "configuration_unavailable";
      };
  claudeCode: {
    configured: boolean;
    state: ClaudeCodeStatus["state"];
    settingsPath: string;
    gatewayUrl?: string;
    mode?: string;
  };
}

export async function runOperatorStatus(
  options: {
    configPath: string;
    claudeLocation: ClaudeSettingsLocationOptions;
    timeoutMs: number;
    offline: boolean;
  },
  dependencies: OperatorStatusDependencies = {},
): Promise<OperatorStatusReport> {
  const configPath = resolve(options.configPath);
  const now = dependencies.now?.() ?? new Date();
  const [configuration, claude] = await Promise.all([
    loadStatusConfiguration(
      configPath,
      dependencies.loadConfigImplementation ?? loadConfig,
      dependencies.environment ?? process.env,
    ),
    safeClaudeStatus(
      dependencies.claudeStatusImplementation ?? claudeCodeStatus,
      options.claudeLocation,
    ),
  ]);
  const claudeSummary = summarizeClaudeStatus(claude);

  if (configuration.state !== "valid") {
    return {
      ok: false,
      generatedAt: now.toISOString(),
      configuration,
      gateway: { state: "skipped", reason: "configuration_unavailable" },
      claudeCode: claudeSummary,
    };
  }

  const gateway = options.offline
    ? ({ state: "skipped", reason: "offline_requested" } as const)
    : await gatewayStatus(
        configuration.config,
        dependencies.fetchImplementation ?? fetch,
        options.timeoutMs,
      );
  const reportConfiguration = summarizeConfiguration(
    configPath,
    configuration.config,
    dependencies.environment ?? process.env,
  );
  return {
    ok:
      gateway.state !== "not_ready" &&
      gateway.state !== "unreachable" &&
      claudeSummary.state !== "drifted",
    generatedAt: now.toISOString(),
    configuration: reportConfiguration,
    gateway,
    claudeCode: claudeSummary,
  };
}

export function formatOperatorStatus(report: OperatorStatusReport): string {
  const configuration =
    report.configuration.state === "valid"
      ? `Configuration: valid (${report.configuration.path})\n` +
        `Route: ${report.configuration.defaultMode} / ${report.configuration.defaultModel}\n` +
        `Cost baseline: ${report.configuration.baselineModel ?? "not configured"}\n` +
        `Providers: ${String(report.configuration.providers.filter((provider) => provider.enabled).length)} enabled, ` +
        `${String(report.configuration.providers.reduce((total, provider) => total + provider.enabledModelCount, 0))} enabled models\n`
      : `Configuration: ${report.configuration.state} (${report.configuration.path})\n`;
  const gateway =
    report.gateway.state === "skipped"
      ? `Gateway: skipped (${report.gateway.reason})\n`
      : `Gateway: ${report.gateway.state} (${report.gateway.url}${
          report.gateway.statusCode === undefined
            ? ""
            : `, HTTP ${String(report.gateway.statusCode)}`
        }, ${String(report.gateway.durationMs)}ms)\n`;
  const claude =
    `Claude Code: ${report.claudeCode.state}\n` +
    `Claude settings: ${report.claudeCode.settingsPath}\n` +
    (report.claudeCode.gatewayUrl
      ? `Claude gateway: ${report.claudeCode.gatewayUrl}\nClaude mode: ${report.claudeCode.mode ?? "unknown"}\n`
      : "");
  return `${configuration}${gateway}${claude}Status result: ${report.ok ? "PASS" : "FAIL"}\n`;
}

async function loadStatusConfiguration(
  path: string,
  implementation: typeof loadConfig,
  environment: NodeJS.ProcessEnv,
): Promise<
  { state: "valid"; config: RouterConfig } | { state: "missing" | "invalid"; path: string }
> {
  try {
    return {
      state: "valid",
      config: await implementation({ path, env: environment }),
    };
  } catch (error) {
    return {
      state: isMissingFileError(error) ? "missing" : "invalid",
      path,
    };
  }
}

function summarizeConfiguration(
  path: string,
  config: RouterConfig,
  environment: NodeJS.ProcessEnv,
): Extract<OperatorStatusReport["configuration"], { state: "valid" }> {
  return {
    state: "valid",
    path,
    environment: config.environment,
    defaultMode: config.routing.defaultMode,
    defaultModel: config.routing.defaultModel,
    ...(config.routing.baselineModel ? { baselineModel: config.routing.baselineModel } : {}),
    routerVersion: config.routing.routerVersion,
    priceBookVersion: config.routing.priceBookVersion,
    authenticationEnabled: config.auth.enabled,
    configuredGatewayKeyCount: config.auth.apiKeys.length,
    databaseRequiredForReadiness: config.database.requiredForReadiness,
    providers: config.providers.map((provider) => ({
      id: provider.id,
      type: provider.type,
      enabled: provider.enabled,
      enabledModelCount: provider.enabled
        ? provider.models.filter((model) => model.enabled).length
        : 0,
      ...(provider.apiKeyEnv ? { credentialEnvironment: provider.apiKeyEnv } : {}),
      credentialPresent:
        provider.type === "fake" ||
        Boolean(provider.apiKeyEnv && environment[provider.apiKeyEnv]?.trim()),
    })),
  };
}

function summarizeClaudeStatus(status: ClaudeCodeStatus): OperatorStatusReport["claudeCode"] {
  return {
    configured: status.configured,
    state: status.state,
    settingsPath: status.settingsPath,
    ...(status.gatewayUrl ? { gatewayUrl: status.gatewayUrl } : {}),
    ...(status.mode ? { mode: status.mode } : {}),
  };
}

async function safeClaudeStatus(
  implementation: typeof claudeCodeStatus,
  location: ClaudeSettingsLocationOptions,
): Promise<ClaudeCodeStatus> {
  try {
    return await implementation(location);
  } catch {
    return {
      configured: true,
      state: "drifted",
      settingsPath: resolveClaudeSettingsPath(location),
      statePath: "",
    };
  }
}

async function gatewayStatus(
  config: RouterConfig,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
): Promise<Extract<OperatorStatusReport["gateway"], { state: string }>> {
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
      state: response.ok ? "ready" : "not_ready",
      url,
      statusCode: response.status,
      durationMs: elapsed(startedAt),
    };
  } catch {
    return {
      state: "unreachable",
      url,
      durationMs: elapsed(startedAt),
    };
  }
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

#!/usr/bin/env node

import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  initializeRouterConfig,
  loadConfig,
  mutateRouterConfig,
  readProviderDefinition,
  undoRouterConfigMutation,
  type ConfigurableRoutingMode,
} from "@vartma/config";
import { createDatabase, PrismaInspectionStore, type RouterDatabase } from "@vartma/database";
import { startServer } from "@vartma/gateway";
import { Command } from "commander";

import {
  CLAUDE_ROUTING_MODES,
  configureClaudeCode,
  setClaudeCodeBypass,
  undoClaudeCodeConfiguration,
  type ClaudeRoutingMode,
  type ClaudeSettingsLocationOptions,
  type ClaudeSettingsScope,
} from "./claude-code-settings.js";
import {
  formatDiagnosticReport,
  formatDoctorReport,
  runDoctor,
  runProviderDiagnostics,
  type DoctorReport,
} from "./doctor.js";
import {
  formatSessionInspection,
  formatSessionList,
  formatTraceInspection,
} from "./operator-inspection.js";
import { formatOperatorStatus, runOperatorStatus } from "./operator-status.js";
import { buildProviderInteractively } from "./provider-wizard.js";

const program = new Command();

program
  .name("vartma")
  .description("Configure, run, and inspect the Vartma.ai model router.")
  .version("0.1.0");

program
  .command("init")
  .description("Create a safe local router configuration without overwriting an existing file.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .action(async (options: { config: string }) => {
    const result = await initializeRouterConfig({ path: resolve(options.config) });
    process.stdout.write(
      `Router configuration created: ${result.configPath}\n` +
        `Default mode: ${result.config.routing.defaultMode}\n` +
        `Default model: ${result.config.routing.defaultModel}\n` +
        `Authentication: disabled for localhost initialization\n` +
        `Undo: vartma config undo --config "${result.configPath}"\n`,
    );
  });

program
  .command("serve")
  .description("Start the Vartma.ai gateway.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .action(async (options: { config: string }) => {
    const config = await loadConfig({ path: resolve(options.config) });
    const server = await startServer(config);
    const address = server.address();
    process.stdout.write(
      `Gateway listening on ${
        typeof address === "object" && address
          ? `${address.address}:${address.port}`
          : String(address)
      }\n`,
    );
  });

const config = program.command("config").description("Inspect or restore router configuration.");
config
  .command("validate")
  .description("Validate a router YAML configuration file.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .action(async (options: { config: string }) => {
    const path = resolve(options.config);
    const loaded = await loadConfig({ path });
    process.stdout.write(
      `Configuration is valid: ${path}\n` +
        `Providers: ${loaded.providers.length}\n` +
        `Default model: ${loaded.routing.defaultModel}\n`,
    );
  });
config
  .command("undo")
  .description("Undo the most recent vartma configuration change if the file has not drifted.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .action(async (options: { config: string }) => {
    const result = await undoRouterConfigMutation({ path: resolve(options.config) });
    process.stdout.write(
      result.recoveredIncompleteMutation
        ? `Recovered incomplete configuration operation: ${result.operation}\nConfiguration: ${result.configPath}\n`
        : result.removedInitializedFile
          ? `Undid ${result.operation}; initialized configuration removed.\nConfiguration: ${result.configPath}\n`
          : `Undid ${result.operation}.\nConfiguration: ${result.configPath}\nRestored from: ${result.restoredFrom ?? "recorded backup"}\n`,
    );
  });

program
  .command("models")
  .description("List enabled router models and their declared capabilities.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .option("--json", "Print machine-readable JSON")
  .action(async (options: { config: string; json?: boolean }) => {
    const loaded = await loadConfig({ path: resolve(options.config) });
    const models = loaded.providers
      .filter((provider) => provider.enabled)
      .flatMap((provider) =>
        provider.models
          .filter((model) => model.enabled)
          .map((model) => ({
            id: model.id,
            provider: provider.id,
            providerType: provider.type,
            upstreamModel: model.upstreamModel,
            capabilities: model.capabilities,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxOutputTokens,
            qualityTier: model.qualityTier,
            expectedLatencyTier: model.expectedLatencyTier,
          })),
      );
    process.stdout.write(
      options.json
        ? `${JSON.stringify(models, null, 2)}\n`
        : `${models
            .map(
              (model) =>
                `${model.id} provider=${model.provider} upstream=${model.upstreamModel} ` +
                `context=${String(model.contextWindow)} output=${String(model.maxOutputTokens)} ` +
                `capabilities=${enabledCapabilities(model.capabilities).join(",")}`,
            )
            .join("\n")}\n`,
    );
  });

const provider = program.command("provider").description("Configure, inspect, and test providers.");
provider
  .command("add [definition-path]")
  .description("Interactively add a provider or load a validated YAML/JSON definition.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .action(async (definitionPath: string | undefined, options: { config: string }) => {
    const configPath = resolve(options.config);
    const definition = definitionPath
      ? await readProviderDefinition(resolve(definitionPath))
      : await interactiveProviderDefinition(configPath);
    const result = await mutateRouterConfig({
      path: configPath,
      mutation: { kind: "add-provider", provider: definition },
    });
    writeConfigMutationResult(result);
  });
provider
  .command("remove <provider-id>")
  .description("Remove a configured provider, with backup and undo support.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .action(async (providerId: string, options: { config: string }) => {
    const result = await mutateRouterConfig({
      path: resolve(options.config),
      mutation: { kind: "remove-provider", providerId },
    });
    writeConfigMutationResult(result);
  });
for (const enabled of [true, false]) {
  provider
    .command(`${enabled ? "enable" : "disable"} <provider-id>`)
    .description(`${enabled ? "Enable" : "Disable"} a configured provider, with undo support.`)
    .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
    .action(async (providerId: string, options: { config: string }) => {
      const result = await mutateRouterConfig({
        path: resolve(options.config),
        mutation: { kind: "set-provider-enabled", providerId, enabled },
      });
      writeConfigMutationResult(result);
    });
}
provider
  .command("test [provider-id]")
  .description("Test configured model endpoints with bounded, secret-safe probes.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .option("--timeout <milliseconds>", "Timeout for each provider check", "5000")
  .option("--json", "Print a machine-readable report")
  .action(
    async (
      providerId: string | undefined,
      options: { config: string; timeout: string; json?: boolean },
    ) => {
      const loaded = await loadConfig({ path: resolve(options.config) });
      if (
        providerId &&
        !loaded.providers.some((candidate) => candidate.enabled && candidate.id === providerId)
      ) {
        throw new Error(`Enabled provider "${providerId}" was not found.`);
      }
      const timeoutMs = parseNetworkTimeout(options.timeout);
      const checks = await runProviderDiagnostics(loaded, {
        timeoutMs,
        ...(providerId ? { providerId } : {}),
      });
      const report = diagnosticReport(checks);
      process.stdout.write(
        options.json
          ? `${JSON.stringify(report, null, 2)}\n`
          : formatDiagnosticReport(report, "Provider"),
      );
      if (!report.ok) {
        process.exitCode = 1;
      }
    },
  );

program
  .command("mode <mode>")
  .description("Persist the default routing mode: quality, balanced, or eco.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .action(async (mode: string, options: { config: string }) => {
    const result = await mutateRouterConfig({
      path: resolve(options.config),
      mutation: { kind: "set-mode", mode: configurableMode(mode) },
    });
    writeConfigMutationResult(result);
  });

program
  .command("use <model-id>")
  .description("Persist a fixed enabled model as the default route.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .action(async (modelId: string, options: { config: string }) => {
    const result = await mutateRouterConfig({
      path: resolve(options.config),
      mutation: { kind: "use-model", modelId },
    });
    writeConfigMutationResult(result);
  });

program
  .command("baseline <model-id>")
  .description("Persist the fixed model used for cost and savings comparisons.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .action(async (modelId: string, options: { config: string }) => {
    const result = await mutateRouterConfig({
      path: resolve(options.config),
      mutation: { kind: "set-baseline", modelId },
    });
    writeConfigMutationResult(result);
  });

program
  .command("doctor")
  .description("Check configuration, credentials, providers, gateway, and PostgreSQL.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .option("--timeout <milliseconds>", "Timeout for each network check", "5000")
  .option("--json", "Print a machine-readable report")
  .action(async (options: { config: string; timeout: string; json?: boolean }) => {
    const loaded = await loadConfig({ path: resolve(options.config) });
    const timeoutMs = parseNetworkTimeout(options.timeout);
    const report = await runDoctor(loaded, { timeoutMs });
    process.stdout.write(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report),
    );
    if (!report.ok) {
      process.exitCode = 1;
    }
  });

const configure = program.command("configure").description("Configure supported agent clients.");
configure
  .command("claude-code")
  .description("Route Claude Code through this gateway with backup and undo support.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .option("--gateway-url <url>", "Gateway root URL")
  .option("--mode <mode>", "Initial routing mode: quality, balanced, or eco", "balanced")
  .option("--scope <scope>", "Claude settings scope: user or project", "project")
  .option("--settings-path <path>", "Explicit Claude settings path (advanced)")
  .option("--undo", "Restore router-managed settings to their pre-router values")
  .action(
    async (options: {
      config: string;
      gatewayUrl?: string;
      mode: string;
      scope: string;
      settingsPath?: string;
      undo?: boolean;
    }) => {
      const location = claudeLocation(options);
      if (options.undo) {
        const result = await undoClaudeCodeConfiguration(location);
        process.stdout.write(
          `Claude Code router configuration removed.\n` +
            `Settings: ${result.settingsPath}\n` +
            `Baseline backup retained: ${result.restoredFrom}\n`,
        );
        return;
      }
      const loaded = await loadConfig({ path: resolve(options.config) });
      const apiKey =
        process.env["VARTMA_API_KEY"] ??
        loaded.auth.apiKeys[0] ??
        (loaded.auth.enabled ? undefined : "router-auth-disabled");
      if (!apiKey) {
        throw new Error(
          "No static router API key is configured. Add auth.apiKeys or set VARTMA_API_KEY.",
        );
      }
      const result = await configureClaudeCode({
        ...location,
        gatewayUrl:
          options.gatewayUrl ?? `http://${clientHost(loaded.server.host)}:${loaded.server.port}`,
        apiKey,
        mode: claudeMode(options.mode),
      });
      process.stdout.write(
        `Claude Code now routes through ${result.gatewayUrl} in ${result.mode} mode.\n` +
          `Settings: ${result.settingsPath}\n` +
          `Baseline backup: ${result.baselineBackupPath}\n` +
          `Undo: vartma configure claude-code --undo${scopeSuffix(options)}\n` +
          `Bypass: vartma bypass on${scopeSuffix(options)}\n`,
      );
    },
  );

program
  .command("bypass <state>")
  .description("Temporarily bypass or re-enable the router for Claude Code.")
  .option("--scope <scope>", "Claude settings scope: user or project", "project")
  .option("--settings-path <path>", "Explicit Claude settings path (advanced)")
  .action(async (state: string, options: { scope: string; settingsPath?: string }) => {
    if (state !== "on" && state !== "off") {
      throw new Error('Bypass state must be "on" or "off".');
    }
    const result = await setClaudeCodeBypass(state === "on", claudeLocation(options));
    process.stdout.write(
      state === "on"
        ? `Router bypass enabled. Claude Code baseline settings are active.\nSettings: ${result.settingsPath}\n`
        : `Router bypass disabled. Claude Code routes through ${result.gatewayUrl ?? "the configured gateway"}.\nSettings: ${result.settingsPath}\n`,
    );
  });

program
  .command("status")
  .description("Show router, gateway, and Claude Code status without printing secrets.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .option("--timeout <milliseconds>", "Gateway readiness timeout", "1000")
  .option("--offline", "Skip the gateway readiness request")
  .option("--json", "Print machine-readable JSON")
  .option("--scope <scope>", "Claude settings scope: user or project", "project")
  .option("--settings-path <path>", "Explicit Claude settings path (advanced)")
  .action(
    async (options: {
      config: string;
      timeout: string;
      offline?: boolean;
      json?: boolean;
      scope: string;
      settingsPath?: string;
    }) => {
      const report = await runOperatorStatus({
        configPath: resolve(options.config),
        claudeLocation: claudeLocation(options),
        timeoutMs: parseNetworkTimeout(options.timeout),
        offline: options.offline ?? false,
      });
      process.stdout.write(
        options.json ? `${JSON.stringify(report, null, 2)}\n` : formatOperatorStatus(report),
      );
      if (!report.ok) {
        process.exitCode = 1;
      }
    },
  );

program
  .command("trace <request-id>")
  .description("Inspect a persisted request trace without prompt content or secrets.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .option("--json", "Print machine-readable JSON")
  .action(async (requestId: string, options: { config: string; json?: boolean }) => {
    const loaded = await loadConfig({ path: resolve(options.config) });
    const trace = await withInspectionStore(loaded.database.url, (store) => store.trace(requestId));
    if (!trace) {
      throw new Error(`Trace "${requestId}" was not found.`);
    }
    process.stdout.write(
      options.json ? `${JSON.stringify(trace, null, 2)}\n` : formatTraceInspection(trace),
    );
  });

program
  .command("sessions [session-id]")
  .description("List recent sessions or inspect one persisted session.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .option("--limit <count>", "Number of recent records to return", "20")
  .option("--json", "Print machine-readable JSON")
  .action(
    async (
      sessionId: string | undefined,
      options: { config: string; limit: string; json?: boolean },
    ) => {
      const limit = parseInspectionLimit(options.limit);
      const loaded = await loadConfig({ path: resolve(options.config) });
      if (sessionId) {
        const session = await withInspectionStore(loaded.database.url, (store) =>
          store.session(sessionId, limit),
        );
        if (!session) {
          throw new Error(`Session "${sessionId}" was not found.`);
        }
        process.stdout.write(
          options.json ? `${JSON.stringify(session, null, 2)}\n` : formatSessionInspection(session),
        );
        return;
      }
      const sessions = await withInspectionStore(loaded.database.url, (store) =>
        store.sessions(limit),
      );
      process.stdout.write(
        options.json ? `${JSON.stringify(sessions, null, 2)}\n` : formatSessionList(sessions),
      );
    },
  );

await program.parseAsync(process.argv);

function defaultConfigPath(): string {
  return process.env["VARTMA_CONFIG_PATH"] ?? "./vartma.yaml";
}

function claudeLocation(options: {
  scope: string;
  settingsPath?: string;
}): ClaudeSettingsLocationOptions {
  const scope = claudeScope(options.scope);
  return {
    scope,
    ...(options.settingsPath ? { settingsPath: resolve(options.settingsPath) } : {}),
  };
}

function claudeScope(value: string): ClaudeSettingsScope {
  if (value === "user" || value === "project") {
    return value;
  }
  throw new Error('Claude Code settings scope must be "user" or "project".');
}

function claudeMode(value: string): ClaudeRoutingMode {
  if ((CLAUDE_ROUTING_MODES as readonly string[]).includes(value)) {
    return value as ClaudeRoutingMode;
  }
  throw new Error(`Claude Code routing mode must be one of: ${CLAUDE_ROUTING_MODES.join(", ")}.`);
}

function scopeSuffix(options: { scope: string; settingsPath?: string }): string {
  if (options.settingsPath) {
    return ` --settings-path "${resolve(options.settingsPath)}"`;
  }
  return options.scope === "project" ? " --scope project" : "";
}

function clientHost(host: string): string {
  const configuredHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return configuredHost.includes(":") ? `[${configuredHost}]` : configuredHost;
}

function parseInspectionLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("Inspection limit must be an integer between 1 and 100.");
  }
  return parsed;
}

function parseNetworkTimeout(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 120_000) {
    throw new Error("Network timeout must be an integer between 100 and 120000 milliseconds.");
  }
  return parsed;
}

function diagnosticReport(checks: DoctorReport["checks"]): DoctorReport {
  return {
    ok: checks.every((check) => check.status !== "fail"),
    generatedAt: new Date().toISOString(),
    checks,
  };
}

function enabledCapabilities(capabilities: Record<string, boolean>): string[] {
  return Object.entries(capabilities)
    .filter(([, enabled]) => enabled)
    .map(([capability]) => capability)
    .sort();
}

function configurableMode(value: string): ConfigurableRoutingMode {
  if (value === "quality" || value === "balanced" || value === "eco") {
    return value;
  }
  throw new Error(
    'Routing mode must be "quality", "balanced", or "eco". Use `use` for fixed mode.',
  );
}

function writeConfigMutationResult(result: {
  configPath: string;
  operation: string;
  backupPath: string;
}): void {
  process.stdout.write(
    `Applied ${result.operation}.\n` +
      `Configuration: ${result.configPath}\n` +
      `Backup: ${result.backupPath}\n` +
      `Undo: vartma config undo --config "${result.configPath}"\n`,
  );
}

async function interactiveProviderDefinition(configPath: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Interactive provider setup requires a terminal. Supply a YAML or JSON definition path for non-interactive use.",
    );
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const config = await loadConfig({ path: configPath });
    return await buildProviderInteractively({
      ask: (question) => prompt.question(question),
      write: (message) => process.stdout.write(message),
      existingProviderIds: config.providers.map((provider) => provider.id),
      existingModelIds: config.providers.flatMap((provider) =>
        provider.models.map((model) => model.id),
      ),
    });
  } finally {
    prompt.close();
  }
}

async function withInspectionStore<T>(
  connectionString: string,
  operation: (store: PrismaInspectionStore) => Promise<T>,
): Promise<T> {
  let database: RouterDatabase | undefined;
  try {
    database = createDatabase(connectionString);
    return await operation(new PrismaInspectionStore(database));
  } catch {
    throw new Error(
      "Database inspection failed. Run `vartma doctor` to check PostgreSQL connectivity.",
    );
  } finally {
    try {
      await database?.$disconnect();
    } catch {
      // Inspection already finished or failed; never expose connection details from disconnect errors.
    }
  }
}

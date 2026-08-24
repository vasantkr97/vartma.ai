#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  initializeRouterConfig,
  listEncryptedCredentialReferences,
  loadConfig,
  mutateRouterConfig,
  readProviderDefinition,
  resolveCredentialStorePath,
  setEncryptedCredential,
  undoRouterConfigMutation,
  type ConfigurableRoutingMode,
} from "@vartma/config";
import {
  createDatabase,
  PrismaEvaluationStore,
  PrismaInspectionStore,
  type RouterDatabase,
} from "@vartma/database";
import {
  buildCalibrationFromFixedResults,
  evaluationTargetSchema,
  loadEvaluationSuite,
  parseEvaluationJsonLines,
  runEvaluationSuite,
  summarizeEvaluation,
  type EvaluationReport,
  type EvaluationResult,
} from "@vartma/evals";
import { createRuntime, startServer } from "@vartma/gateway";
import { ProviderError, runProviderConformance } from "@vartma/providers";
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
import { configureOpenAIClient, undoOpenAIClientConfiguration } from "./openai-client-settings.js";
import { buildProviderInteractively } from "./provider-wizard.js";
import { startManagedGateway, stopManagedGateway } from "./process-manager.js";
import { readHiddenSecret } from "./secret-input.js";
import { uninstallVartma } from "./uninstall.js";

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
    const configPath = resolve(options.config);
    const config = await loadConfig({ path: configPath });
    const server = await startServer(config, {
      runtime: createRuntime(config, {
        credentialStorePath: resolveCredentialStorePath(configPath, config.credentials.storePath),
      }),
    });
    const address = server.address();
    process.stdout.write(
      `Gateway listening on ${
        typeof address === "object" && address
          ? `${address.address}:${address.port}`
          : String(address)
      }\n`,
    );
  });

program
  .command("login <provider-id>")
  .description("Encrypt and store a provider API key for BYOK operation.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .option("--from-env <name>", "Read the provider API key from an environment variable")
  .action(async (providerId: string, options: { config: string; fromEnv?: string }) => {
    const configPath = resolve(options.config);
    const loaded = await loadConfig({ path: configPath });
    const provider = loaded.providers.find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw new Error(`Provider "${providerId}" was not found.`);
    }
    if (provider.type === "fake") {
      throw new Error("The fake provider does not accept credentials.");
    }
    const masterKey = process.env[loaded.credentials.masterKeyEnv];
    if (!masterKey) {
      throw new Error(
        `Set ${loaded.credentials.masterKeyEnv} to a master passphrase of at least 20 characters before running login.`,
      );
    }
    const secret = options.fromEnv
      ? process.env[options.fromEnv]
      : await readHiddenSecret(`API key for ${providerId}: `);
    if (!secret?.trim()) {
      throw new Error(
        options.fromEnv
          ? `Environment variable "${options.fromEnv}" is missing or empty.`
          : "The provider API key cannot be empty.",
      );
    }
    const credentialRef = provider.credentialRef ?? provider.id;
    const storePath = resolveCredentialStorePath(configPath, loaded.credentials.storePath);
    await setEncryptedCredential({
      path: storePath,
      masterKey,
      reference: credentialRef,
      value: secret,
    });
    if (provider.credentialRef !== credentialRef) {
      await mutateRouterConfig({
        path: configPath,
        mutation: { kind: "set-provider-credential", providerId, credentialRef },
      });
    }
    const references = listEncryptedCredentialReferences({ path: storePath, masterKey });
    if (!references.includes(credentialRef)) {
      throw new Error("The encrypted credential failed its post-write verification.");
    }
    process.stdout.write(
      `Stored encrypted credential for provider "${providerId}".\n` +
        `Reference: ${credentialRef}\n` +
        `Store: ${storePath}\n` +
        `The API key and master key were not written to the router configuration.\n`,
    );
  });

program
  .command("start")
  .description("Start the Vartma.ai gateway as a managed background process.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .option("--timeout <milliseconds>", "Startup readiness timeout", "10000")
  .action(async (options: { config: string; timeout: string }) => {
    const result = await startManagedGateway({
      configPath: resolve(options.config),
      startupTimeoutMs: parseLifecycleTimeout(options.timeout),
    });
    process.stdout.write(
      result.alreadyRunning
        ? `Gateway is already running (PID ${String(result.pid)}).\nHealth: ${result.healthUrl}\n`
        : `Gateway started (PID ${String(result.pid)}).\nHealth: ${result.healthUrl}\nState: ${result.statePath}\n`,
    );
  });

program
  .command("stop")
  .description("Safely stop the managed Vartma.ai gateway.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .option("--timeout <milliseconds>", "Shutdown timeout", "10000")
  .action(async (options: { config: string; timeout: string }) => {
    const result = await stopManagedGateway({
      configPath: resolve(options.config),
      shutdownTimeoutMs: parseLifecycleTimeout(options.timeout),
    });
    process.stdout.write(
      !result
        ? "No managed gateway state exists.\n"
        : result.stopped
          ? `Gateway stopped (PID ${String(result.pid)}).\n`
          : `Removed stale gateway state for PID ${String(result.pid)}.\n`,
    );
  });

program
  .command("uninstall")
  .description("Stop Vartma and restore coding-agent settings changed by Vartma.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .option("--timeout <milliseconds>", "Shutdown timeout", "10000")
  .option("--scope <scope>", "Claude settings scope: user or project", "project")
  .option("--settings-path <path>", "Explicit Claude settings path (advanced)")
  .option("--openai-env-path <path>", "OpenAI-compatible client dotenv path", ".env")
  .action(
    async (options: {
      config: string;
      timeout: string;
      scope: string;
      settingsPath?: string;
      openaiEnvPath: string;
    }) => {
      const result = await uninstallVartma({
        configPath: resolve(options.config),
        claudeLocation: claudeLocation(options),
        openAIEnvPath: options.openaiEnvPath,
        shutdownTimeoutMs: parseLifecycleTimeout(options.timeout),
      });
      process.stdout.write(
        `Managed gateway: ${result.gateway}.\n` +
          `Claude Code: ${result.claudeCode}.\n` +
          `OpenAI-compatible client: ${result.openAIClient}.\n` +
          (result.restoredSettingsPath
            ? `Restored settings: ${result.restoredSettingsPath}\n`
            : "") +
          (result.retainedBackupPath
            ? `Baseline backup retained: ${result.retainedBackupPath}\n`
            : "") +
          (result.restoredOpenAIEnvPath
            ? `Restored dotenv: ${result.restoredOpenAIEnvPath}\n`
            : "") +
          (result.retainedOpenAIBackupPath
            ? `OpenAI baseline backup retained: ${result.retainedOpenAIBackupPath}\n`
            : "") +
          `Router configuration and encrypted credentials were preserved.\n` +
          `Remove the global package with: npm uninstall --global @vartma/cli\n`,
      );
    },
  );

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
      const configPath = resolve(options.config);
      const checks = await runProviderDiagnostics(loaded, {
        timeoutMs,
        ...(providerId ? { providerId } : {}),
        credentialStorePath: resolveCredentialStorePath(configPath, loaded.credentials.storePath),
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
provider
  .command("conformance [provider-id]")
  .description("Make deliberate model calls and verify streaming/tool protocol invariants.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .option("--timeout <milliseconds>", "Timeout for each real model call", "120000")
  .option("--json", "Print a machine-readable report")
  .action(
    async (
      providerId: string | undefined,
      options: { config: string; timeout: string; json?: boolean },
    ) => {
      const configPath = resolve(options.config);
      const loaded = await loadConfig({ path: configPath });
      const selectedProviders = loaded.providers.filter(
        (candidate) => candidate.enabled && (!providerId || candidate.id === providerId),
      );
      if (!selectedProviders.length) {
        throw new Error(
          providerId
            ? `Enabled provider "${providerId}" was not found.`
            : "No enabled providers were found.",
        );
      }
      const selectedModel = selectedProviders.flatMap((candidate) =>
        candidate.models.filter((model) => model.enabled),
      )[0];
      if (!selectedModel) throw new Error("The selected providers have no enabled models.");
      const scopedConfig = {
        ...loaded,
        routing: { ...loaded.routing, defaultModel: selectedModel.id },
        providers: loaded.providers.map((candidate) => ({
          ...candidate,
          enabled: selectedProviders.some((selected) => selected.id === candidate.id),
        })),
      };
      const runtime = createRuntime(scopedConfig, {
        credentialStorePath: resolveCredentialStorePath(
          configPath,
          scopedConfig.credentials.storePath,
        ),
      });
      const timeoutMs = parseConformanceTimeout(options.timeout);
      const reports = [];
      for (const model of runtime.models.values()) {
        const adapter = runtime.registry.get(model.provider);
        try {
          reports.push({
            configuredModel: model.id,
            ...(await runProviderConformance(
              adapter,
              model.upstreamModel,
              {
                requestId: `conformance-${Date.now().toString(36)}`,
                messages: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "text",
                        text: "Respond with exactly VARTMA_PROVIDER_OK.",
                      },
                    ],
                  },
                ],
                tools: [],
                maxOutputTokens: 32,
                routingMode: "fixed",
                constraints: { requiredCapabilities: ["text", "streaming"] },
                metadata: { purpose: "provider_conformance" },
              },
              AbortSignal.timeout(timeoutMs),
            )),
          });
        } catch (error) {
          reports.push({
            configuredModel: model.id,
            provider: model.provider,
            model: model.upstreamModel,
            passed: false,
            issues: [
              `Conformance call failed (${error instanceof ProviderError ? error.code : "unexpected"}).`,
            ],
            eventsObserved: 0,
          });
        }
      }
      const passed = reports.every((report) => report.passed);
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ passed, reports }, null, 2)}\n`
          : `${reports
              .map(
                (report) =>
                  `${report.passed ? "PASS" : "FAIL"} ${report.configuredModel} ` +
                  `events=${String(report.eventsObserved)}${
                    report.issues.length ? ` issues=${report.issues.join("; ")}` : ""
                  }`,
              )
              .join("\n")}\n`,
      );
      if (!passed) process.exitCode = 1;
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

const evaluation = program
  .command("eval")
  .description("Run, summarize, and calibrate reproducible coding evaluations.");
evaluation
  .command("run <suite-path>")
  .description("Run a LangGraph coding-agent suite through fixed or routed targets.")
  .requiredOption("--target <target>", "fixed:<model-id> or router:<balanced|eco|quality>")
  .requiredOption("-o, --output <path>", "Output JSONL result path")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .option("--gateway-url <url>", "Gateway root URL")
  .option("--append", "Append to an existing JSONL result file")
  .option("--no-persist", "Do not persist the run in configured PostgreSQL")
  .option("--keep-workspaces", "Retain disposable task workspaces for inspection")
  .action(
    async (
      suitePath: string,
      options: {
        target: string;
        output: string;
        config: string;
        gatewayUrl?: string;
        append?: boolean;
        persist: boolean;
        keepWorkspaces?: boolean;
      },
    ) => {
      const configPath = resolve(options.config);
      const config = await loadConfig({ path: configPath });
      const apiKey =
        process.env["VARTMA_API_KEY"] ??
        config.auth.apiKeys[0] ??
        (config.auth.enabled ? undefined : "router-auth-disabled");
      if (!apiKey) {
        throw new Error(
          "Evaluation requires VARTMA_API_KEY or a static auth.apiKeys entry for the gateway.",
        );
      }
      const loadedSuite = await loadEvaluationSuite(resolve(suitePath));
      const target = parseEvaluationTarget(options.target);
      const runs = await runEvaluationSuite({
        suite: loadedSuite.suite,
        suiteDirectory: loadedSuite.directory,
        target,
        gatewayUrl:
          options.gatewayUrl ??
          `http://${clientHost(config.server.host)}:${String(config.server.port)}`,
        apiKey,
        keepWorkspaces: options.keepWorkspaces ?? false,
      });
      const outputPath = resolve(options.output);
      await writeFile(outputPath, `${runs.map((run) => JSON.stringify(run.result)).join("\n")}\n`, {
        encoding: "utf8",
        flag: options.append ? "a" : "wx",
      });
      if (options.persist) {
        await persistEvaluationResults(
          config.database.url,
          runs.map((run) => run.result),
        );
      }
      for (const run of runs) {
        process.stdout.write(
          `${run.result.success ? "PASS" : "FAIL"} ${run.result.taskId} ` +
            `model=${run.result.selectedModel} cost=$${run.result.actualCostUsd} ` +
            `latency=${String(run.result.latencyMs)}ms\n` +
            (run.workspacePath ? `Workspace retained: ${run.workspacePath}\n` : ""),
        );
      }
      process.stdout.write(
        `Evaluation results written: ${outputPath}\n` +
          (options.persist
            ? `Evaluation run persisted: ${runs[0]?.result.runId ?? "unknown"}\n`
            : ""),
      );
      if (runs.some((run) => !run.result.success)) process.exitCode = 2;
    },
  );
evaluation
  .command("summarize <results-path>")
  .description("Compare fixed-model and router JSONL results with fairness checks.")
  .option("--json", "Print machine-readable JSON")
  .action(async (resultsPath: string, options: { json?: boolean }) => {
    const results = parseEvaluationJsonLines(await readFile(resolve(resultsPath), "utf8"));
    const report = summarizeEvaluation(results);
    process.stdout.write(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : formatEvaluationReport(report),
    );
    if (!report.comparable) {
      process.exitCode = 2;
    }
  });
evaluation
  .command("calibrate <results-path>")
  .description("Build task/model success profiles from fixed-model JSONL results.")
  .requiredOption("--calibration-version <version>", "Immutable calibration version")
  .requiredOption("-o, --output <path>", "Output calibration JSON path")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .option("--apply", "Safely apply the calibration to the router configuration")
  .option("--prior-sample-size <count>", "Bayesian prior sample strength", "20")
  .option("--force", "Replace an existing output file")
  .action(
    async (
      resultsPath: string,
      options: {
        calibrationVersion: string;
        output: string;
        config: string;
        priorSampleSize: string;
        force?: boolean;
        apply?: boolean;
      },
    ) => {
      const results = parseEvaluationJsonLines(await readFile(resolve(resultsPath), "utf8"));
      const calibration = buildCalibrationFromFixedResults(
        results,
        options.calibrationVersion,
        parseCalibrationPrior(options.priorSampleSize),
      );
      const outputPath = resolve(options.output);
      await writeFile(outputPath, `${JSON.stringify(calibration, null, 2)}\n`, {
        encoding: "utf8",
        flag: options.force ? "w" : "wx",
      });
      process.stdout.write(
        `Calibration written: ${outputPath}\n` +
          `Version: ${calibration.version}\n` +
          `Models: ${String(Object.keys(calibration.models).length)}\n`,
      );
      if (options.apply) {
        const result = await mutateRouterConfig({
          path: resolve(options.config),
          mutation: { kind: "set-calibration", calibration },
        });
        writeConfigMutationResult(result);
      }
    },
  );

program
  .command("doctor")
  .description("Check configuration, credentials, providers, gateway, and PostgreSQL.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .option("--timeout <milliseconds>", "Timeout for each network check", "5000")
  .option("--json", "Print a machine-readable report")
  .action(async (options: { config: string; timeout: string; json?: boolean }) => {
    const configPath = resolve(options.config);
    const loaded = await loadConfig({ path: configPath });
    const timeoutMs = parseNetworkTimeout(options.timeout);
    const report = await runDoctor(loaded, {
      timeoutMs,
      credentialStorePath: resolveCredentialStorePath(configPath, loaded.credentials.storePath),
    });
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

configure
  .command("openai")
  .description("Configure an OpenAI-compatible client dotenv file with backup and undo support.")
  .option("-c, --config <path>", "Router configuration file", defaultConfigPath())
  .option("--env-path <path>", "Client dotenv path", ".env")
  .option("--gateway-url <url>", "Gateway root URL")
  .option("--mode <mode>", "Routing mode: quality, balanced, or eco", "balanced")
  .option("--model <model>", "Explicit router model alias")
  .option("--undo", "Restore Vartma-managed dotenv values")
  .action(
    async (options: {
      config: string;
      envPath: string;
      gatewayUrl?: string;
      mode: string;
      model?: string;
      undo?: boolean;
    }) => {
      if (options.undo) {
        const restored = await undoOpenAIClientConfiguration({ envPath: options.envPath });
        process.stdout.write(
          `OpenAI-compatible client configuration removed.\n` +
            `Dotenv: ${restored.envPath}\n` +
            `Baseline backup retained: ${restored.restoredFrom}\n`,
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
      const mode = claudeMode(options.mode);
      const configured = await configureOpenAIClient({
        envPath: options.envPath,
        gatewayUrl:
          options.gatewayUrl ??
          `http://${clientHost(loaded.server.host)}:${String(loaded.server.port)}`,
        apiKey,
        model: options.model ?? `vartma-${mode}`,
      });
      process.stdout.write(
        `OpenAI-compatible clients can now route through ${configured.gatewayUrl}.\n` +
          `Dotenv: ${configured.envPath}\n` +
          `Model: ${configured.model}\n` +
          `Baseline backup: ${configured.baselineBackupPath}\n` +
          `Undo: vartma configure openai --undo --env-path "${configured.envPath}"\n`,
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
  .option("--openai-env-path <path>", "OpenAI-compatible client dotenv path", ".env")
  .action(
    async (options: {
      config: string;
      timeout: string;
      offline?: boolean;
      json?: boolean;
      scope: string;
      settingsPath?: string;
      openaiEnvPath: string;
    }) => {
      const report = await runOperatorStatus({
        configPath: resolve(options.config),
        claudeLocation: claudeLocation(options),
        openAIEnvPath: options.openaiEnvPath,
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

function parseEvaluationTarget(value: string) {
  if (value.startsWith("fixed:")) {
    return evaluationTargetSchema.parse({ kind: "fixed", model: value.slice("fixed:".length) });
  }
  if (value.startsWith("router:")) {
    return evaluationTargetSchema.parse({ kind: "router", mode: value.slice("router:".length) });
  }
  throw new Error('Evaluation target must be "fixed:<model-id>" or "router:<mode>".');
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

function parseConformanceTimeout(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 600_000) {
    throw new Error("Conformance timeout must be an integer between 100 and 600000 milliseconds.");
  }
  return parsed;
}

function parseLifecycleTimeout(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new Error("Lifecycle timeout must be an integer between 1000 and 120000 milliseconds.");
  }
  return parsed;
}

function parseCalibrationPrior(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new Error("Calibration prior sample size must be an integer between 0 and 10000.");
  }
  return parsed;
}

function formatEvaluationReport(report: EvaluationReport): string {
  const lines = [
    `Comparable: ${report.comparable ? "yes" : "no"}`,
    ...report.comparabilityIssues.map((issue) => `Comparability issue: ${issue}`),
  ];
  for (const target of report.targets) {
    lines.push(
      `${target.target} solved=${String(target.solved)}/${String(target.tasks)} ` +
        `pass=${(target.passRate * 100).toFixed(1)}% cost=$${target.actualCostUsd} ` +
        `cost/solved=${target.costPerSolvedTaskUsd ? `$${target.costPerSolvedTaskUsd}` : "n/a"} ` +
        `p50=${String(target.p50LatencyMs)}ms p95=${String(target.p95LatencyMs)}ms`,
    );
    lines.push(`  distribution=${JSON.stringify(target.routingDistribution)}`);
  }
  return `${lines.join("\n")}\n`;
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

async function persistEvaluationResults(
  connectionString: string,
  results: EvaluationResult[],
): Promise<void> {
  let database: RouterDatabase | undefined;
  try {
    database = createDatabase(connectionString);
    await new PrismaEvaluationStore(database).persist(results);
  } catch {
    throw new Error(
      "Evaluation persistence failed. Run `vartma doctor` to check PostgreSQL connectivity, or rerun deliberately with --no-persist.",
    );
  } finally {
    try {
      await database?.$disconnect();
    } catch {
      // The persistence operation already finished or failed; do not expose connection details.
    }
  }
}

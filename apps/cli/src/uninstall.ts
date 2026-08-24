import {
  claudeCodeStatus,
  undoClaudeCodeConfiguration,
  type ClaudeSettingsLocationOptions,
} from "./claude-code-settings.js";
import { stopManagedGateway } from "./process-manager.js";
import { openAIClientStatus, undoOpenAIClientConfiguration } from "./openai-client-settings.js";

export interface UninstallResult {
  gateway: "stopped" | "not_running" | "stale_state_removed";
  claudeCode: "restored" | "not_configured";
  openAIClient: "restored" | "not_configured";
  restoredSettingsPath?: string;
  retainedBackupPath?: string;
  restoredOpenAIEnvPath?: string;
  retainedOpenAIBackupPath?: string;
}

export interface UninstallDependencies {
  stopGateway?: typeof stopManagedGateway;
  inspectClaude?: typeof claudeCodeStatus;
  restoreClaude?: typeof undoClaudeCodeConfiguration;
  inspectOpenAI?: typeof openAIClientStatus;
  restoreOpenAI?: typeof undoOpenAIClientConfiguration;
}

export async function uninstallVartma(
  options: {
    configPath: string;
    claudeLocation: ClaudeSettingsLocationOptions;
    openAIEnvPath: string;
    shutdownTimeoutMs: number;
  },
  dependencies: UninstallDependencies = {},
): Promise<UninstallResult> {
  const stopped = await (dependencies.stopGateway ?? stopManagedGateway)({
    configPath: options.configPath,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
  });
  const [claudeStatus, openAIStatus] = await Promise.all([
    (dependencies.inspectClaude ?? claudeCodeStatus)(options.claudeLocation),
    (dependencies.inspectOpenAI ?? openAIClientStatus)({ envPath: options.openAIEnvPath }),
  ]);
  const restored = claudeStatus.configured
    ? await (dependencies.restoreClaude ?? undoClaudeCodeConfiguration)(options.claudeLocation)
    : undefined;
  const restoredOpenAI = openAIStatus.configured
    ? await (dependencies.restoreOpenAI ?? undoOpenAIClientConfiguration)({
        envPath: options.openAIEnvPath,
      })
    : undefined;
  return {
    gateway: !stopped ? "not_running" : stopped.stopped ? "stopped" : "stale_state_removed",
    claudeCode: restored ? "restored" : "not_configured",
    openAIClient: restoredOpenAI ? "restored" : "not_configured",
    ...(restored
      ? {
          restoredSettingsPath: restored.settingsPath,
          retainedBackupPath: restored.restoredFrom,
        }
      : {}),
    ...(restoredOpenAI
      ? {
          restoredOpenAIEnvPath: restoredOpenAI.envPath,
          retainedOpenAIBackupPath: restoredOpenAI.restoredFrom,
        }
      : {}),
  };
}

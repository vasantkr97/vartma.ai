import type {
  CanonicalRequest,
  HealthStatus,
  ModelDefinition,
  RoutingMode,
  TokenEstimate,
} from "@vartma/canonical";

import type { ProgressAssessment } from "./progress.js";

export const TASK_CLASSES = [
  "explanation",
  "code_generation",
  "small_edit",
  "multi_file_feature",
  "debugging",
  "refactoring",
  "test_generation",
  "test_repair",
  "documentation",
  "repository_exploration",
  "architecture_design",
  "security_review",
  "migration",
  "long_autonomous_task",
  "simple_tool_operation",
] as const;

export type TaskClass = (typeof TASK_CLASSES)[number];

export interface TaskSignals {
  promptCharacters: number;
  messageCount: number;
  estimatedInputTokens: number;
  toolCount: number;
  hasImages: boolean;
  fileCount: number;
  turnCount: number;
  previousToolErrors: number;
  previousTestFailures: number;
  progress: ProgressAssessment;
  matchedRules: string[];
}

export interface TaskClassification {
  taskClass: TaskClass;
  difficulty: 1 | 2 | 3 | 4 | 5;
  confidence: number;
  signals: TaskSignals;
}

export interface RoutingModePolicy {
  minimumQualityTier: number;
  difficultyTierAdjustment: number;
  qualityWeight: number;
  costWeight: number;
  latencyWeight: number;
  failureWeight: number;
}

export type RoutingPolicies = Record<RoutingMode, RoutingModePolicy>;

export type CandidateFilterCode =
  | "disabled"
  | "forced_provider"
  | "forced_model"
  | "provider_not_allowed"
  | "provider_denied"
  | "model_not_allowed"
  | "model_denied"
  | "missing_capability"
  | "context_window"
  | "max_output_tokens"
  | "region"
  | "latency"
  | "quality_floor"
  | "unhealthy"
  | "circuit_open"
  | "previous_attempt_failed"
  | "token_estimation_failed"
  | "cost_limit";

export interface CandidateFilterReason {
  code: CandidateFilterCode;
  message: string;
}

export interface CandidateScore {
  expectedSuccess: number;
  expectedAttempts: number;
  expectedTotalCostUsd: number;
  switchColdInputCostUsd: number;
  calibrationSource: "task_evaluation" | "model_evaluation" | "quality_prior";
  calibrationSampleSize: number;
  normalizedCost: number;
  normalizedLatency: number;
  failureRisk: number;
  sessionSwitchPenalty: number;
  total: number;
}

export interface RoutingCandidate {
  model: ModelDefinition;
  eligible: boolean;
  filterReasons: CandidateFilterReason[];
  tokenEstimate?: TokenEstimate;
  estimatedCostUsd?: number;
  health?: HealthStatus;
  score?: CandidateScore;
}

export interface RoutingExplanation {
  summary: string;
  selectedReasons: string[];
  rejected: Array<{ model: string; reasons: string[] }>;
}

export interface RoutingDecision {
  decisionId: string;
  requestId: string;
  routerVersion: string;
  mode: RoutingMode;
  task: TaskClassification;
  selectedModel: ModelDefinition;
  candidates: RoutingCandidate[];
  explanation: RoutingExplanation;
  baseline?: {
    model: ModelDefinition;
    tokenEstimate: TokenEstimate;
    estimatedCostUsd: number;
  };
  session?: {
    previousProvider?: string;
    previousModel?: string;
    escalationLevel: number;
    stickySelection: boolean;
    switchReason?: string;
  };
}

export interface RoutingEngineInput {
  request: CanonicalRequest;
  signal?: AbortSignal;
}

import type { CanonicalContent, CanonicalRequest, TokenEstimate } from "@vartma/canonical";

import type { TaskClass, TaskClassification, TaskSignals } from "./types.js";
import { analyzeProgress } from "./progress.js";

interface Rule {
  taskClass: TaskClass;
  difficulty: 1 | 2 | 3 | 4 | 5;
  pattern: RegExp;
  label: string;
}

const rules: Rule[] = [
  {
    taskClass: "security_review",
    difficulty: 4,
    pattern: /\b(security|vulnerabilit\w*|threat model|penetration|cve|audit)\b/i,
    label: "security intent",
  },
  {
    taskClass: "architecture_design",
    difficulty: 5,
    pattern: /\b(architecture|system design|design from scratch|scalab\w*|distributed system)\b/i,
    label: "architecture intent",
  },
  {
    taskClass: "migration",
    difficulty: 4,
    pattern: /\b(migrat\w*|upgrade framework|port from|convert from|modernize)\b/i,
    label: "migration intent",
  },
  {
    taskClass: "test_repair",
    difficulty: 3,
    pattern: /\b(fix|repair|debug).{0,30}\b(test|spec|ci|build)\b|\bfailing tests?\b/i,
    label: "test repair intent",
  },
  {
    taskClass: "test_generation",
    difficulty: 2,
    pattern: /\b(add|write|generate|create).{0,30}\b(test|tests|specs)\b/i,
    label: "test generation intent",
  },
  {
    taskClass: "debugging",
    difficulty: 3,
    pattern: /\b(debug|fix bug|root cause|exception|stack trace|not working|broken)\b/i,
    label: "debugging intent",
  },
  {
    taskClass: "refactoring",
    difficulty: 3,
    pattern: /\b(refactor|restructure|clean up|simplify|technical debt)\b/i,
    label: "refactoring intent",
  },
  {
    taskClass: "documentation",
    difficulty: 1,
    pattern: /\b(document|readme|jsdoc|api docs|documentation)\b/i,
    label: "documentation intent",
  },
  {
    taskClass: "repository_exploration",
    difficulty: 3,
    pattern: /\b(explore|inspect|understand|analy[sz]e).{0,30}\b(repo|repository|codebase)\b/i,
    label: "repository exploration intent",
  },
  {
    taskClass: "small_edit",
    difficulty: 2,
    pattern: /\b(rename|small edit|one file|single file|change text|update copy)\b/i,
    label: "small edit intent",
  },
  {
    taskClass: "code_generation",
    difficulty: 2,
    pattern:
      /\b(implement|build|create|write|generate|add).{0,40}\b(code|function|class|endpoint|component|feature)\b/i,
    label: "code generation intent",
  },
  {
    taskClass: "explanation",
    difficulty: 1,
    pattern: /\b(explain|what is|how does|why does|teach me|summarize)\b/i,
    label: "explanation intent",
  },
];

export function classifyTask(
  request: CanonicalRequest,
  estimate: TokenEstimate,
): TaskClassification {
  const latestUserIndex = request.messages.findLastIndex((message) => message.role === "user");
  const currentTurnMessages = request.messages.slice(Math.max(0, latestUserIndex));
  const prompt = currentTurnMessages
    .flatMap((message) => message.content)
    .flatMap(classificationText)
    .join("\n");
  const fileCount = metadataInteger(request, "file_count");
  const turnCount = metadataInteger(request, "turn_count");
  const previousToolErrors = metadataInteger(request, "previous_tool_errors");
  const previousTestFailures = metadataInteger(request, "previous_test_failures");
  const progress = analyzeProgress(request);
  const hasImages = request.messages.some((message) =>
    message.content.some((content) => content.type === "image"),
  );
  const matchedRules: string[] = [];

  let taskClass: TaskClass =
    request.tools.length > 0 && prompt.length < 300 ? "simple_tool_operation" : "explanation";
  let difficulty: 1 | 2 | 3 | 4 | 5 = taskClass === "simple_tool_operation" ? 1 : 2;
  let confidence = 0.55;

  const rule = rules.find((candidate) => candidate.pattern.test(prompt));
  if (rule) {
    taskClass = rule.taskClass;
    difficulty = rule.difficulty;
    confidence = 0.82;
    matchedRules.push(rule.label);
  }

  if (fileCount >= 3 && isImplementationTask(taskClass)) {
    taskClass = "multi_file_feature";
    difficulty = Math.max(difficulty, 4) as 4 | 5;
    confidence = Math.max(confidence, 0.88);
    matchedRules.push("multiple files");
  }
  if (
    prompt.length >= 8_000 ||
    estimate.inputTokens >= 12_000 ||
    fileCount >= 12 ||
    /\b(end[- ]to[- ]end|autonomous|do not stop|complete product)\b/i.test(prompt)
  ) {
    taskClass = "long_autonomous_task";
    difficulty = 5;
    confidence = 0.9;
    matchedRules.push("large autonomous scope");
  }
  if (
    previousToolErrors >= 2 ||
    previousTestFailures >= 2 ||
    progress.toolErrors >= 2 ||
    progress.testFailures >= 2
  ) {
    difficulty = Math.min(5, difficulty + 1) as 1 | 2 | 3 | 4 | 5;
    matchedRules.push("prior failures");
  }
  if (progress.status === "stuck") {
    difficulty = Math.min(5, difficulty + 1) as 1 | 2 | 3 | 4 | 5;
    matchedRules.push("transcript progress stalled");
  }

  const signals: TaskSignals = {
    promptCharacters: prompt.length,
    messageCount: request.messages.length,
    estimatedInputTokens: estimate.inputTokens,
    toolCount: request.tools.length,
    hasImages,
    fileCount,
    turnCount,
    previousToolErrors,
    previousTestFailures,
    progress,
    matchedRules,
  };
  return { taskClass, difficulty, confidence, signals };
}

function classificationText(content: CanonicalContent): string[] {
  switch (content.type) {
    case "text":
      return [content.text];
    case "tool_result":
      return typeof content.content === "string"
        ? [content.content]
        : content.content.flatMap(classificationText);
    case "tool_call":
      return [content.name];
    case "image":
    case "reasoning":
      return [];
  }
}

function metadataInteger(request: CanonicalRequest, key: string): number {
  const value = Number(request.metadata[key] ?? 0);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function isImplementationTask(taskClass: TaskClass): boolean {
  return (
    taskClass === "code_generation" ||
    taskClass === "small_edit" ||
    taskClass === "debugging" ||
    taskClass === "refactoring" ||
    taskClass === "test_generation" ||
    taskClass === "test_repair"
  );
}

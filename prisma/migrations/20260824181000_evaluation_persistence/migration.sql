CREATE TABLE "EvaluationRun" (
    "id" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "datasetVersion" TEXT NOT NULL,
    "harnessVersion" TEXT NOT NULL,
    "promptTemplateVersion" TEXT NOT NULL,
    "timeoutMs" INTEGER NOT NULL,
    "maxAttempts" INTEGER NOT NULL,
    "cacheEnabled" BOOLEAN NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetValue" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvaluationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EvaluationTaskResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "taskClass" TEXT NOT NULL,
    "selectedModel" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "attempts" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "actualCost" DECIMAL(24,12) NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "cachedInputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "reasoningTokens" INTEGER NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvaluationTaskResult_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EvaluationRun_dataset_datasetVersion_startedAt_idx"
ON "EvaluationRun"("dataset", "datasetVersion", "startedAt");

CREATE INDEX "EvaluationRun_targetKind_targetValue_startedAt_idx"
ON "EvaluationRun"("targetKind", "targetValue", "startedAt");

CREATE UNIQUE INDEX "EvaluationTaskResult_runId_taskId_key"
ON "EvaluationTaskResult"("runId", "taskId");

CREATE INDEX "EvaluationTaskResult_selectedModel_taskClass_completedAt_idx"
ON "EvaluationTaskResult"("selectedModel", "taskClass", "completedAt");

CREATE INDEX "EvaluationTaskResult_success_completedAt_idx"
ON "EvaluationTaskResult"("success", "completedAt");

ALTER TABLE "EvaluationTaskResult"
ADD CONSTRAINT "EvaluationTaskResult_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "EvaluationRun"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "RequestStatus" AS ENUM (
  'RECEIVED',
  'STREAMING',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

CREATE TYPE "AttemptStatus" AS ENUM (
  'STARTED',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

CREATE TABLE "Session" (
  "id" TEXT NOT NULL,
  "clientType" TEXT,
  "routingMode" TEXT NOT NULL,
  "currentProvider" TEXT,
  "currentModel" TEXT,
  "escalationLevel" INTEGER NOT NULL DEFAULT 0,
  "turnCount" INTEGER NOT NULL DEFAULT 0,
  "accumulatedCost" DECIMAL(20, 10) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Request" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT,
  "clientRequestId" TEXT,
  "requestedModel" TEXT,
  "selectedProvider" TEXT,
  "selectedModel" TEXT,
  "routingMode" TEXT NOT NULL,
  "status" "RequestStatus" NOT NULL DEFAULT 'RECEIVED',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "errorType" TEXT,
  "errorMessage" TEXT,
  "traceLevel" TEXT NOT NULL DEFAULT 'metadata_only',
  "metadata" JSONB,
  CONSTRAINT "Request_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RouteDecision" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "routerVersion" TEXT NOT NULL,
  "taskClass" TEXT NOT NULL,
  "selectedProvider" TEXT NOT NULL,
  "selectedModel" TEXT NOT NULL,
  "explanation" JSONB NOT NULL,
  "candidates" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RouteDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderAttempt" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "providerRequestId" TEXT,
  "status" "AttemptStatus" NOT NULL DEFAULT 'STARTED',
  "sequence" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "firstTokenAt" TIMESTAMP(3),
  "errorType" TEXT,
  "errorMessage" TEXT,
  CONSTRAINT "ProviderAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsageEvent" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "providerAttemptId" TEXT,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
  "estimatedCost" DECIMAL(20, 10) NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "priceBookVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ModelHealthSample" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "healthy" BOOLEAN NOT NULL,
  "latencyMs" INTEGER,
  "errorType" TEXT,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModelHealthSample_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RouteDecision_requestId_key"
  ON "RouteDecision"("requestId");

CREATE UNIQUE INDEX "ProviderAttempt_requestId_sequence_key"
  ON "ProviderAttempt"("requestId", "sequence");

CREATE INDEX "Session_lastActivityAt_idx"
  ON "Session"("lastActivityAt");

CREATE INDEX "Request_sessionId_startedAt_idx"
  ON "Request"("sessionId", "startedAt");

CREATE INDEX "Request_status_startedAt_idx"
  ON "Request"("status", "startedAt");

CREATE INDEX "ProviderAttempt_provider_model_startedAt_idx"
  ON "ProviderAttempt"("provider", "model", "startedAt");

CREATE INDEX "UsageEvent_requestId_createdAt_idx"
  ON "UsageEvent"("requestId", "createdAt");

CREATE INDEX "UsageEvent_provider_model_createdAt_idx"
  ON "UsageEvent"("provider", "model", "createdAt");

CREATE INDEX "ModelHealthSample_provider_model_observedAt_idx"
  ON "ModelHealthSample"("provider", "model", "observedAt");

ALTER TABLE "Request"
  ADD CONSTRAINT "Request_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "Session"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RouteDecision"
  ADD CONSTRAINT "RouteDecision_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "Request"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProviderAttempt"
  ADD CONSTRAINT "ProviderAttempt_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "Request"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "Request"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_providerAttemptId_fkey"
  FOREIGN KEY ("providerAttemptId") REFERENCES "ProviderAttempt"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Session"
ADD COLUMN "lastTaskClass" TEXT,
ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "successfulOutcomes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastEscalatedAt" TIMESTAMP(3),
ADD COLUMN "cooldownUntil" TIMESTAMP(3),
ADD COLUMN "inputTokens" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "cachedInputTokens" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "outputTokens" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "reasoningTokens" BIGINT NOT NULL DEFAULT 0;

CREATE TABLE "RouteSwitch" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "fromProvider" TEXT NOT NULL,
    "fromModel" TEXT NOT NULL,
    "toProvider" TEXT NOT NULL,
    "toModel" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RouteSwitch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SessionOutcome" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "requestId" TEXT,
    "kind" TEXT NOT NULL,
    "source" TEXT,
    "metadata" JSONB,
    "escalationLevelBefore" INTEGER NOT NULL,
    "escalationLevelAfter" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionOutcome_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RouteSwitch_requestId_sequence_key"
ON "RouteSwitch"("requestId", "sequence");

CREATE INDEX "RouteSwitch_requestId_createdAt_idx"
ON "RouteSwitch"("requestId", "createdAt");

CREATE INDEX "SessionOutcome_sessionId_createdAt_idx"
ON "SessionOutcome"("sessionId", "createdAt");

CREATE INDEX "SessionOutcome_kind_createdAt_idx"
ON "SessionOutcome"("kind", "createdAt");

ALTER TABLE "RouteSwitch"
ADD CONSTRAINT "RouteSwitch_requestId_fkey"
FOREIGN KEY ("requestId") REFERENCES "Request"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SessionOutcome"
ADD CONSTRAINT "SessionOutcome_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "Session"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

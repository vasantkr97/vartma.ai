CREATE TABLE "PriceBook" (
    "version" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceBook_pkey" PRIMARY KEY ("version")
);

CREATE TABLE "PriceBookEntry" (
    "id" TEXT NOT NULL,
    "priceBookVersion" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "upstreamModel" TEXT NOT NULL,
    "inputPricePerMillion" DECIMAL(24,12) NOT NULL,
    "cachedInputPricePerMillion" DECIMAL(24,12) NOT NULL,
    "outputPricePerMillion" DECIMAL(24,12) NOT NULL,
    "reasoningPricePerMillion" DECIMAL(24,12) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "verifiedAt" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceBookEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RequestCostBaseline" (
    "requestId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "upstreamModel" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "expectedOutputTokens" INTEGER NOT NULL,
    "estimatedCost" DECIMAL(24,12) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "priceBookVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestCostBaseline_pkey" PRIMARY KEY ("requestId")
);

INSERT INTO "PriceBook" ("version", "currency")
SELECT DISTINCT "priceBookVersion", "currency"
FROM "UsageEvent"
ON CONFLICT ("version") DO NOTHING;

ALTER TABLE "UsageEvent"
ADD COLUMN "upstreamModel" TEXT NOT NULL DEFAULT 'legacy-unknown',
ADD COLUMN "attemptStatus" "AttemptStatus" NOT NULL DEFAULT 'COMPLETED',
ADD COLUMN "toolCost" DECIMAL(24,12) NOT NULL DEFAULT 0,
ADD COLUMN "inputPricePerMillion" DECIMAL(24,12) NOT NULL DEFAULT 0,
ADD COLUMN "cachedInputPricePerMillion" DECIMAL(24,12) NOT NULL DEFAULT 0,
ADD COLUMN "outputPricePerMillion" DECIMAL(24,12) NOT NULL DEFAULT 0,
ADD COLUMN "reasoningPricePerMillion" DECIMAL(24,12) NOT NULL DEFAULT 0,
ADD COLUMN "pricingSource" TEXT NOT NULL DEFAULT 'legacy event; rate snapshot unavailable',
ADD COLUMN "pricingEffectiveFrom" DATE NOT NULL DEFAULT DATE '1970-01-01',
ADD COLUMN "pricingVerifiedAt" DATE NOT NULL DEFAULT DATE '1970-01-01';

ALTER TABLE "UsageEvent"
ALTER COLUMN "estimatedCost" TYPE DECIMAL(24,12);

CREATE UNIQUE INDEX "UsageEvent_providerAttemptId_key"
ON "UsageEvent"("providerAttemptId");

CREATE INDEX "UsageEvent_priceBookVersion_createdAt_idx"
ON "UsageEvent"("priceBookVersion", "createdAt");

CREATE UNIQUE INDEX "PriceBookEntry_priceBookVersion_provider_model_key"
ON "PriceBookEntry"("priceBookVersion", "provider", "model");

CREATE INDEX "PriceBookEntry_provider_model_priceBookVersion_idx"
ON "PriceBookEntry"("provider", "model", "priceBookVersion");

CREATE INDEX "RequestCostBaseline_priceBookVersion_createdAt_idx"
ON "RequestCostBaseline"("priceBookVersion", "createdAt");

CREATE INDEX "RequestCostBaseline_provider_model_createdAt_idx"
ON "RequestCostBaseline"("provider", "model", "createdAt");

ALTER TABLE "UsageEvent"
ADD CONSTRAINT "UsageEvent_priceBookVersion_fkey"
FOREIGN KEY ("priceBookVersion") REFERENCES "PriceBook"("version")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PriceBookEntry"
ADD CONSTRAINT "PriceBookEntry_priceBookVersion_fkey"
FOREIGN KEY ("priceBookVersion") REFERENCES "PriceBook"("version")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RequestCostBaseline"
ADD CONSTRAINT "RequestCostBaseline_requestId_fkey"
FOREIGN KEY ("requestId") REFERENCES "Request"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RequestCostBaseline"
ADD CONSTRAINT "RequestCostBaseline_priceBookVersion_fkey"
FOREIGN KEY ("priceBookVersion") REFERENCES "PriceBook"("version")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "UsageEvent"
ALTER COLUMN "upstreamModel" DROP DEFAULT,
ALTER COLUMN "attemptStatus" DROP DEFAULT,
ALTER COLUMN "pricingSource" DROP DEFAULT,
ALTER COLUMN "pricingEffectiveFrom" DROP DEFAULT,
ALTER COLUMN "pricingVerifiedAt" DROP DEFAULT;

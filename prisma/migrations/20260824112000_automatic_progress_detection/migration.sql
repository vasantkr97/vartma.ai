ALTER TABLE "Session"
ADD COLUMN "lastProgressFingerprint" TEXT,
ADD COLUMN "automaticStuckUntil" TIMESTAMP(3),
ADD COLUMN "automaticEscalationLevel" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Session_automaticStuckUntil_idx" ON "Session"("automaticStuckUntil");

CREATE TABLE "CanonicalTranscript" (
    "sessionId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "messageCount" INTEGER NOT NULL,
    "encryptionVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CanonicalTranscript_pkey" PRIMARY KEY ("sessionId")
);

CREATE INDEX "CanonicalTranscript_updatedAt_idx" ON "CanonicalTranscript"("updatedAt");

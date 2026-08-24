CREATE TABLE "RouterConfigurationSnapshot" (
    "id" TEXT NOT NULL,
    "configurationHash" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "routerVersion" TEXT NOT NULL,
    "priceBookVersion" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RouterConfigurationSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RouterConfigurationSnapshot_configurationHash_key"
ON "RouterConfigurationSnapshot"("configurationHash");

CREATE INDEX "RouterConfigurationSnapshot_active_activatedAt_idx"
ON "RouterConfigurationSnapshot"("active", "activatedAt");

CREATE INDEX "RouterConfigurationSnapshot_routerVersion_createdAt_idx"
ON "RouterConfigurationSnapshot"("routerVersion", "createdAt");

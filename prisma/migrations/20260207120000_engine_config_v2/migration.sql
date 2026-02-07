-- CreateTable
CREATE TABLE "EngineConfig" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "activeMarketId" TEXT NOT NULL DEFAULT 'BTC',
    "regimeOverride" TEXT DEFAULT 'AUTO',
    "intensity" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngineConfig_pkey" PRIMARY KEY ("id")
);

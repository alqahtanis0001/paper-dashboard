-- Bootstrap baseline schema so migrate deploy works on clean databases and existing deployments.

CREATE SCHEMA IF NOT EXISTS "public";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'DealStatus'
  ) THEN
    CREATE TYPE "public"."DealStatus" AS ENUM ('SCHEDULED', 'RUNNING', 'FINISHED');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'WithdrawalStatus'
  ) THEN
    CREATE TYPE "public"."WithdrawalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'TradeSide'
  ) THEN
    CREATE TYPE "public"."TradeSide" AS ENUM ('BUY', 'SELL');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'Role'
  ) THEN
    CREATE TYPE "public"."Role" AS ENUM ('USER', 'ADMIN');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'LoginAttemptRole'
  ) THEN
    CREATE TYPE "public"."LoginAttemptRole" AS ENUM ('USER', 'ADMIN');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "public"."AuthSession" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "sessionToken" TEXT NOT NULL,
  "role" "public"."Role" NOT NULL DEFAULT 'USER',
  "isAdmin" BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."LoginAttempt" (
  "id" TEXT NOT NULL,
  "ipHash" TEXT NOT NULL,
  "roleAttempted" "public"."LoginAttemptRole" NOT NULL,
  "success" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."AuditLog" (
  "id" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "actorRole" "public"."Role" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB NOT NULL,

  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."ChartPreference" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "selectedSymbol" TEXT,
  "timeframe" TEXT,
  "zoomLogical" DOUBLE PRECISION,
  "collapsedJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ChartPreference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."Wallet" (
  "id" TEXT NOT NULL,
  "cashBalance" DOUBLE PRECISION NOT NULL DEFAULT 10000,
  "equity" DOUBLE PRECISION NOT NULL DEFAULT 10000,
  "pnlTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."Position" (
  "id" TEXT NOT NULL,
  "isOpen" BOOLEAN NOT NULL DEFAULT false,
  "symbol" TEXT NOT NULL,
  "entryPrice" DOUBLE PRECISION,
  "entryTime" TIMESTAMP(3),
  "sizeUsd" DOUBLE PRECISION,
  "walletId" TEXT,
  "metaDealId" TEXT,

  CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."Trade" (
  "id" TEXT NOT NULL,
  "time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "symbol" TEXT NOT NULL,
  "side" "public"."TradeSide" NOT NULL,
  "price" DOUBLE PRECISION NOT NULL,
  "sizeUsd" DOUBLE PRECISION NOT NULL,
  "pnl" DOUBLE PRECISION,
  "walletId" TEXT,
  "dealId" TEXT,
  "fillPrice" DOUBLE PRECISION NOT NULL,
  "feeUsd" DOUBLE PRECISION NOT NULL,
  "slippageUsd" DOUBLE PRECISION NOT NULL,
  "latencyMs" INTEGER NOT NULL,

  CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."Deal" (
  "id" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "chainName" TEXT NOT NULL,
  "basePrice" DOUBLE PRECISION NOT NULL,
  "startTimeUtc" TIMESTAMP(3) NOT NULL,
  "totalDurationSec" INTEGER NOT NULL,
  "dropDelaySec" INTEGER NOT NULL,
  "dropMagnitudePct" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" "public"."DealStatus" NOT NULL DEFAULT 'SCHEDULED',

  CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."DealJump" (
  "id" TEXT NOT NULL,
  "dealId" TEXT NOT NULL,
  "riseDelaySec" INTEGER NOT NULL,
  "riseMagnitudePct" DOUBLE PRECISION NOT NULL,
  "holdSec" INTEGER NOT NULL,
  "orderIndex" INTEGER NOT NULL,

  CONSTRAINT "DealJump_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."WithdrawalRequest" (
  "id" TEXT NOT NULL,
  "time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "amount" DOUBLE PRECISION NOT NULL,
  "status" "public"."WithdrawalStatus" NOT NULL DEFAULT 'PENDING',

  CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."AiSignalLog" (
  "id" TEXT NOT NULL,
  "time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dealId" TEXT,
  "signalsJson" JSONB NOT NULL,
  "metaDecisionJson" JSONB NOT NULL,
  "horizonSec" INTEGER NOT NULL DEFAULT 60,
  "resolvedAt" TIMESTAMP(3),
  "outcomePct" DOUBLE PRECISION,
  "metaCorrect" BOOLEAN,
  "hitRatesJson" JSONB,

  CONSTRAINT "AiSignalLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AuthSession_sessionToken_key" ON "public"."AuthSession"("sessionToken");
CREATE INDEX IF NOT EXISTS "LoginAttempt_ipHash_roleAttempted_createdAt_idx" ON "public"."LoginAttempt"("ipHash", "roleAttempted", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "public"."AuditLog"("createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "ChartPreference_sessionId_key" ON "public"."ChartPreference"("sessionId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public' AND c.conname = 'ChartPreference_sessionId_fkey'
  ) THEN
    ALTER TABLE "public"."ChartPreference"
      ADD CONSTRAINT "ChartPreference_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "public"."AuthSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public' AND c.conname = 'Position_walletId_fkey'
  ) THEN
    ALTER TABLE "public"."Position"
      ADD CONSTRAINT "Position_walletId_fkey"
      FOREIGN KEY ("walletId") REFERENCES "public"."Wallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public' AND c.conname = 'Position_metaDealId_fkey'
  ) THEN
    ALTER TABLE "public"."Position"
      ADD CONSTRAINT "Position_metaDealId_fkey"
      FOREIGN KEY ("metaDealId") REFERENCES "public"."Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public' AND c.conname = 'Trade_walletId_fkey'
  ) THEN
    ALTER TABLE "public"."Trade"
      ADD CONSTRAINT "Trade_walletId_fkey"
      FOREIGN KEY ("walletId") REFERENCES "public"."Wallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public' AND c.conname = 'Trade_dealId_fkey'
  ) THEN
    ALTER TABLE "public"."Trade"
      ADD CONSTRAINT "Trade_dealId_fkey"
      FOREIGN KEY ("dealId") REFERENCES "public"."Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public' AND c.conname = 'DealJump_dealId_fkey'
  ) THEN
    ALTER TABLE "public"."DealJump"
      ADD CONSTRAINT "DealJump_dealId_fkey"
      FOREIGN KEY ("dealId") REFERENCES "public"."Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public' AND c.conname = 'AiSignalLog_dealId_fkey'
  ) THEN
    ALTER TABLE "public"."AiSignalLog"
      ADD CONSTRAINT "AiSignalLog_dealId_fkey"
      FOREIGN KEY ("dealId") REFERENCES "public"."Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

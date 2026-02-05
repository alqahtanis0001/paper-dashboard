-- Alter AuthSession
ALTER TABLE "AuthSession" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "AuthSession" ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3);
ALTER TABLE "AuthSession" ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'USER';

-- Login attempt table
CREATE TABLE IF NOT EXISTS "LoginAttempt" (
  "id" TEXT PRIMARY KEY,
  "ipHash" TEXT NOT NULL,
  "roleAttempted" TEXT NOT NULL,
  "success" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "LoginAttempt_ipHash_roleAttempted_createdAt_idx" ON "LoginAttempt"("ipHash", "roleAttempted", "createdAt");

-- Audit log table
CREATE TABLE IF NOT EXISTS "AuditLog" (
  "id" TEXT PRIMARY KEY,
  "eventType" TEXT NOT NULL,
  "actorRole" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- Chart preference per session
CREATE TABLE IF NOT EXISTS "ChartPreference" (
  "id" TEXT PRIMARY KEY,
  "sessionId" TEXT NOT NULL UNIQUE,
  "selectedSymbol" TEXT,
  "timeframe" TEXT,
  "zoomLogical" DOUBLE PRECISION,
  "collapsedJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'ChartPreference_sessionId_fkey'
  ) THEN
    ALTER TABLE "ChartPreference"
    ADD CONSTRAINT "ChartPreference_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "AuthSession"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- AI signal log outcome fields
ALTER TABLE "AiSignalLog" ADD COLUMN IF NOT EXISTS "horizonSec" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "AiSignalLog" ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(3);
ALTER TABLE "AiSignalLog" ADD COLUMN IF NOT EXISTS "outcomePct" DOUBLE PRECISION;
ALTER TABLE "AiSignalLog" ADD COLUMN IF NOT EXISTS "metaCorrect" BOOLEAN;
ALTER TABLE "AiSignalLog" ADD COLUMN IF NOT EXISTS "hitRatesJson" JSONB;

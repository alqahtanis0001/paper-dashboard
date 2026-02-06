-- Withdrawal request enrichment for tax and processing trace
ALTER TABLE "WithdrawalRequest" ADD COLUMN IF NOT EXISTS "taxPercent" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "WithdrawalRequest" ADD COLUMN IF NOT EXISTS "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "WithdrawalRequest" ADD COLUMN IF NOT EXISTS "netAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "WithdrawalRequest" ADD COLUMN IF NOT EXISTS "processedAt" TIMESTAMP(3);

-- Backfill existing rows with a safe default model (0% tax)
UPDATE "WithdrawalRequest"
SET
  "taxAmount" = COALESCE("taxAmount", 0),
  "netAmount" = CASE
    WHEN "netAmount" = 0 THEN "amount"
    ELSE "netAmount"
  END
WHERE "taxPercent" = 0;

CREATE INDEX IF NOT EXISTS "WithdrawalRequest_time_idx" ON "WithdrawalRequest"("time");
CREATE INDEX IF NOT EXISTS "WithdrawalRequest_status_time_idx" ON "WithdrawalRequest"("status", "time");

-- Singleton withdrawal configuration for admin-defined tax
CREATE TABLE IF NOT EXISTS "WithdrawConfig" (
  "id" TEXT PRIMARY KEY,
  "taxPercent" DOUBLE PRECISION NOT NULL DEFAULT 5,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "WithdrawConfig" ("id", "taxPercent")
VALUES ('global', 5)
ON CONFLICT ("id") DO NOTHING;

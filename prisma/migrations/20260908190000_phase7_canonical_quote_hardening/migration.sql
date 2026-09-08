-- AlterTable: Add canonical quote fields to quotes table and update orders destination_amount precision
ALTER TABLE "quotes"
  ALTER COLUMN "destination_amount" TYPE DECIMAL(18, 7),
  ADD COLUMN "gross_usdc_amount" DECIMAL(18, 7),
  ADD COLUMN "network_fee_usdc" DECIMAL(18, 7),
  ADD COLUMN "spread" DECIMAL(18, 6),
  ADD COLUMN "base_fx_rate" DECIMAL(18, 6),
  ADD COLUMN "rate_timestamp" TIMESTAMP(3),
  ADD COLUMN "liquidity_available" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "orders"
  ALTER COLUMN "destination_amount" TYPE DECIMAL(18, 7);

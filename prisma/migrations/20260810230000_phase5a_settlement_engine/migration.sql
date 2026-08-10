-- AlterEnum
BEGIN;
CREATE TYPE "SettlementStatus_new" AS ENUM ('PENDING', 'SUBMITTING', 'SUBMITTED', 'CONFIRMING', 'COMPLETED', 'FAILED', 'REQUIRES_RECONCILIATION');
ALTER TABLE "public"."settlements" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "settlements" ALTER COLUMN "status" TYPE "SettlementStatus_new" USING ("status"::text::"SettlementStatus_new");
ALTER TYPE "SettlementStatus" RENAME TO "SettlementStatus_old";
ALTER TYPE "SettlementStatus_new" RENAME TO "SettlementStatus";
DROP TYPE "public"."SettlementStatus_old";
ALTER TABLE "settlements" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- AlterTable
ALTER TABLE "settlements" DROP COLUMN "asset_code",
DROP COLUMN "stellar_tx_hash",
ADD COLUMN     "asset" TEXT NOT NULL,
ADD COLUMN     "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "confirmed_at" TIMESTAMP(3),
ADD COLUMN     "contract_address" TEXT,
ADD COLUMN     "destination" TEXT,
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "settlement_id" TEXT NOT NULL,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "stellar_ledger" INTEGER,
ADD COLUMN     "stellar_transaction_hash" TEXT,
ADD COLUMN     "submitted_at" TIMESTAMP(3),
ADD COLUMN     "user_id" TEXT NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- CreateIndex
CREATE UNIQUE INDEX "settlements_settlement_id_key" ON "settlements"("settlement_id");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_order_id_key" ON "settlements"("order_id");

-- CreateIndex
CREATE INDEX "settlements_user_id_idx" ON "settlements"("user_id");

-- CreateIndex
CREATE INDEX "settlements_status_idx" ON "settlements"("status");

-- CreateIndex
CREATE INDEX "settlements_created_at_idx" ON "settlements"("created_at");

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

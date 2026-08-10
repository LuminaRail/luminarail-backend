-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('DEPOSIT', 'PAYMENT', 'PAYOUT', 'REFUND');

-- AlterEnum
CREATE TYPE "PaymentStatus_new" AS ENUM ('CREATED', 'PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED');
ALTER TABLE "public"."payments" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "public"."payouts" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "payments" ALTER COLUMN "status" TYPE "PaymentStatus_new" USING ("status"::text::"PaymentStatus_new");
ALTER TABLE "payouts" ALTER COLUMN "status" TYPE "PaymentStatus_new" USING ("status"::text::"PaymentStatus_new");
ALTER TYPE "PaymentStatus" RENAME TO "PaymentStatus_old";
ALTER TYPE "PaymentStatus_new" RENAME TO "PaymentStatus";
DROP TYPE "public"."PaymentStatus_old";
ALTER TABLE "payments" ALTER COLUMN "status" SET DEFAULT 'CREATED';
ALTER TABLE "payouts" ALTER COLUMN "status" SET DEFAULT 'CREATED';

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_provider_id_fkey";

-- DropForeignKey
ALTER TABLE "provider_transactions" DROP CONSTRAINT "provider_transactions_provider_id_fkey";

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "gross_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "metadata" TEXT,
ADD COLUMN     "net_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "platform_fee" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'MOCK',
ADD COLUMN     "provider_fee" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "provider_payment_id" TEXT,
ADD COLUMN     "type" "PaymentType" NOT NULL DEFAULT 'DEPOSIT',
ADD COLUMN     "user_id" TEXT NOT NULL,
ALTER COLUMN "provider_id" DROP NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'CREATED';

-- AlterTable
ALTER TABLE "payouts" ALTER COLUMN "status" SET DEFAULT 'CREATED';

-- AlterTable
ALTER TABLE "provider_transactions" DROP COLUMN "external_reference",
ADD COLUMN     "amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'NGN',
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'MOCK',
ADD COLUMN     "provider_transaction_id" TEXT NOT NULL,
ADD COLUMN     "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
ALTER COLUMN "provider_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "signature_verified" BOOLEAN NOT NULL DEFAULT false,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "payload" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_event_id_key" ON "webhook_events"("provider", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_transactions" ADD CONSTRAINT "provider_transactions_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

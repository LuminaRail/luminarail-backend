-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

-- CreateEnum
CREATE TYPE "LiquidityReservationStatus" AS ENUM ('RESERVED', 'CONFIRMED', 'CONSUMED', 'EXPIRED_RELEASED', 'CANCELLED_RELEASED');

-- CreateEnum
CREATE TYPE "TreasuryTransactionType" AS ENUM ('REPLENISHMENT', 'SETTLEMENT_PAYOUT', 'MANUAL_ADJUSTMENT', 'FEE_COLLECTION');

-- CreateTable
CREATE TABLE "liquidity_pools" (
    "id" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "total_balance" DECIMAL(18,7) NOT NULL,
    "reserved_balance" DECIMAL(18,7) NOT NULL,
    "available_balance" DECIMAL(18,7) NOT NULL,
    "min_threshold" DECIMAL(18,7) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "liquidity_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liquidity_reservations" (
    "id" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "amount" DECIMAL(18,7) NOT NULL,
    "status" "LiquidityReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "liquidity_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_transactions" (
    "id" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "type" "TreasuryTransactionType" NOT NULL,
    "amount" DECIMAL(18,7) NOT NULL,
    "stellar_tx_hash" TEXT,
    "external_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treasury_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "liquidity_pools_asset_key" ON "liquidity_pools"("asset");

-- CreateIndex
CREATE UNIQUE INDEX "liquidity_reservations_order_id_key" ON "liquidity_reservations"("order_id");

-- CreateIndex
CREATE INDEX "liquidity_reservations_status_expires_at_idx" ON "liquidity_reservations"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "liquidity_reservations" ADD CONSTRAINT "liquidity_reservations_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "liquidity_pools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidity_reservations" ADD CONSTRAINT "liquidity_reservations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_transactions" ADD CONSTRAINT "treasury_transactions_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "liquidity_pools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

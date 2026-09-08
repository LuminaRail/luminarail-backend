import {
  LiquidityPool,
  LiquidityReservation,
  LiquidityReservationStatus,
  Prisma,
  TreasuryTransactionType,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, NotFoundError } from '../../errors/index.js';

export interface ReserveLiquidityParams {
  poolId: string;
  orderId: string;
  amount: Prisma.Decimal | number | string;
  expiryMinutes?: number;
}

export class LiquidityService {
  /**
   * Retrieves or initializes a LiquidityPool by asset & network.
   */
  static async getPool(asset: string, network = 'testnet'): Promise<LiquidityPool> {
    const existing = await prisma.liquidityPool.findFirst({
      where: { asset, network },
    });

    if (existing) {
      return existing;
    }

    // Default pool creation with 10,000 USDC initial capacity for testnet environment
    return prisma.liquidityPool.create({
      data: {
        asset,
        network,
        totalBalance: new Prisma.Decimal('10000.0000000'),
        reservedBalance: new Prisma.Decimal('0.0000000'),
        availableBalance: new Prisma.Decimal('10000.0000000'),
        minThreshold: new Prisma.Decimal('1000.0000000'),
      },
    });
  }

  /**
   * Returns authoritative available liquidity for a pool.
   */
  static async getAvailableLiquidity(asset: string, network = 'testnet'): Promise<Prisma.Decimal> {
    const pool = await this.getPool(asset, network);
    return pool.availableBalance;
  }

  /**
   * Atomically reserves liquidity for an order within an existing Prisma transaction context.
   * Uses PostgreSQL row locking (`FOR UPDATE`) to prevent race conditions.
   */
  static async reserveForOrderInTx(
    tx: Prisma.TransactionClient,
    params: ReserveLiquidityParams
  ): Promise<LiquidityReservation> {
    const amountDec = new Prisma.Decimal(params.amount);

    if (amountDec.lte(0) || !amountDec.isFinite()) {
      throw new BadRequestError('Reservation amount must be a positive number');
    }

    // Row-level lock on the pool row to guarantee serializability
    await tx.$queryRaw`SELECT * FROM "liquidity_pools" WHERE "id" = ${params.poolId} FOR UPDATE`;

    const pool = await tx.liquidityPool.findUnique({
      where: { id: params.poolId },
    });

    if (!pool) {
      throw new NotFoundError('Liquidity pool not found.');
    }

    // Recalculate available balance from authoritative DB state
    const currentAvailable = pool.totalBalance.minus(pool.reservedBalance);

    if (currentAvailable.lt(amountDec)) {
      throw new BadRequestError('Insufficient liquidity in pool to satisfy request');
    }

    const newReserved = pool.reservedBalance.plus(amountDec);
    const newAvailable = pool.totalBalance.minus(newReserved);

    if (newAvailable.lt(0) || newReserved.gt(pool.totalBalance)) {
      throw new BadRequestError('Insufficient liquidity in pool to satisfy request');
    }

    // Update pool balances
    await tx.liquidityPool.update({
      where: { id: pool.id },
      data: {
        reservedBalance: newReserved,
        availableBalance: newAvailable,
      },
    });

    const expiryMinutes = params.expiryMinutes || 15;
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    // Create reservation record
    return tx.liquidityReservation.create({
      data: {
        poolId: pool.id,
        orderId: params.orderId,
        amount: amountDec,
        status: LiquidityReservationStatus.RESERVED,
        expiresAt,
      },
    });
  }

  /**
   * Confirms a reservation when NGN payment succeeds.
   * RESERVED -> CONFIRMED. Does not release or consume funds.
   */
  static async confirmReservation(orderId: string): Promise<LiquidityReservation | null> {
    const reservation = await prisma.liquidityReservation.findUnique({
      where: { orderId },
    });

    if (!reservation) {
      return null;
    }

    if (
      reservation.status === LiquidityReservationStatus.CONFIRMED ||
      reservation.status === LiquidityReservationStatus.CONSUMED
    ) {
      return reservation;
    }

    if (reservation.status !== LiquidityReservationStatus.RESERVED) {
      return reservation;
    }

    return prisma.liquidityReservation.update({
      where: { id: reservation.id },
      data: { status: LiquidityReservationStatus.CONFIRMED },
    });
  }

  /**
   * Consumes a reservation upon successful USDC settlement.
   * CONFIRMED / RESERVED -> CONSUMED.
   * Reduces totalBalance and reservedBalance. Updates availableBalance.
   * Idempotent: safe against retries.
   */
  static async consumeReservation(
    orderId: string,
    externalRef?: string,
    stellarTxHash?: string
  ): Promise<LiquidityReservation | null> {
    return prisma.$transaction(async (tx) => {
      const reservation = await tx.liquidityReservation.findUnique({
        where: { orderId },
      });

      if (!reservation) {
        return null;
      }

      // Idempotency: if already consumed, return immediately without altering balances
      if (reservation.status === LiquidityReservationStatus.CONSUMED) {
        return reservation;
      }

      if (
        reservation.status === LiquidityReservationStatus.EXPIRED_RELEASED ||
        reservation.status === LiquidityReservationStatus.CANCELLED_RELEASED
      ) {
        return reservation;
      }

      // Lock pool row
      await tx.$queryRaw`SELECT * FROM "liquidity_pools" WHERE "id" = ${reservation.poolId} FOR UPDATE`;

      const pool = await tx.liquidityPool.findUniqueOrThrow({
        where: { id: reservation.poolId },
      });

      const newTotal = pool.totalBalance.minus(reservation.amount);
      const newReserved = pool.reservedBalance.minus(reservation.amount);
      const newAvailable = newTotal.minus(newReserved);

      const safeTotal = newTotal.lt(0) ? new Prisma.Decimal(0) : newTotal;
      const safeReserved = newReserved.lt(0) ? new Prisma.Decimal(0) : newReserved;
      const safeAvailable = safeTotal.minus(safeReserved);

      await tx.liquidityPool.update({
        where: { id: pool.id },
        data: {
          totalBalance: safeTotal,
          reservedBalance: safeReserved,
          availableBalance: safeAvailable,
        },
      });

      const updatedReservation = await tx.liquidityReservation.update({
        where: { id: reservation.id },
        data: { status: LiquidityReservationStatus.CONSUMED },
      });

      // Record treasury payout transaction
      await tx.treasuryTransaction.create({
        data: {
          poolId: pool.id,
          type: TreasuryTransactionType.SETTLEMENT_PAYOUT,
          amount: reservation.amount,
          stellarTxHash: stellarTxHash || null,
          externalRef: externalRef || orderId,
        },
      });

      return updatedReservation;
    });
  }

  /**
   * Releases reserved liquidity when payment fails or order is cancelled.
   * RESERVED / CONFIRMED -> EXPIRED_RELEASED or CANCELLED_RELEASED.
   * Idempotent: safe to run repeatedly.
   */
  static async releaseReservation(
    orderId: string,
    targetStatus: LiquidityReservationStatus = LiquidityReservationStatus.CANCELLED_RELEASED
  ): Promise<LiquidityReservation | null> {
    return prisma.$transaction(async (tx) => {
      const reservation = await tx.liquidityReservation.findUnique({
        where: { orderId },
      });

      if (!reservation) {
        return null;
      }

      if (
        reservation.status === LiquidityReservationStatus.CONSUMED ||
        reservation.status === LiquidityReservationStatus.EXPIRED_RELEASED ||
        reservation.status === LiquidityReservationStatus.CANCELLED_RELEASED
      ) {
        return reservation;
      }

      // Lock pool row
      await tx.$queryRaw`SELECT * FROM "liquidity_pools" WHERE "id" = ${reservation.poolId} FOR UPDATE`;

      const pool = await tx.liquidityPool.findUniqueOrThrow({
        where: { id: reservation.poolId },
      });

      const newReserved = pool.reservedBalance.minus(reservation.amount);
      const safeReserved = newReserved.lt(0) ? new Prisma.Decimal(0) : newReserved;
      const newAvailable = pool.totalBalance.minus(safeReserved);

      await tx.liquidityPool.update({
        where: { id: pool.id },
        data: {
          reservedBalance: safeReserved,
          availableBalance: newAvailable,
        },
      });

      return tx.liquidityReservation.update({
        where: { id: reservation.id },
        data: { status: targetStatus },
      });
    });
  }

  /**
   * Convenient alias for expiring a reservation.
   */
  static async expireReservation(orderId: string): Promise<LiquidityReservation | null> {
    return this.releaseReservation(
      orderId,
      LiquidityReservationStatus.EXPIRED_RELEASED
    );
  }

  /**
   * Records a manual or replenishment treasury transaction and adjusts pool total & available balances.
   */
  static async recordTreasuryTransaction(
    poolId: string,
    type: TreasuryTransactionType,
    amount: Prisma.Decimal | number | string,
    externalRef?: string,
    stellarTxHash?: string
  ) {
    const amountDec = new Prisma.Decimal(amount);

    if (amountDec.lte(0) || !amountDec.isFinite()) {
      throw new BadRequestError('Transaction amount must be a positive number');
    }

    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT * FROM "liquidity_pools" WHERE "id" = ${poolId} FOR UPDATE`;

      const pool = await tx.liquidityPool.findUniqueOrThrow({
        where: { id: poolId },
      });

      let newTotal = pool.totalBalance;

      if (
        type === TreasuryTransactionType.REPLENISHMENT ||
        type === TreasuryTransactionType.MANUAL_ADJUSTMENT ||
        type === TreasuryTransactionType.FEE_COLLECTION
      ) {
        newTotal = pool.totalBalance.plus(amountDec);
      } else if (type === TreasuryTransactionType.SETTLEMENT_PAYOUT) {
        newTotal = pool.totalBalance.minus(amountDec);
        if (newTotal.lt(0)) {
          throw new BadRequestError('Insufficient total balance for payout adjustment');
        }
      }

      const newAvailable = newTotal.minus(pool.reservedBalance);
      if (newAvailable.lt(0)) {
        throw new BadRequestError('Adjustment would result in negative available balance');
      }

      await tx.liquidityPool.update({
        where: { id: poolId },
        data: {
          totalBalance: newTotal,
          availableBalance: newAvailable,
        },
      });

      return tx.treasuryTransaction.create({
        data: {
          poolId,
          type,
          amount: amountDec,
          externalRef: externalRef || null,
          stellarTxHash: stellarTxHash || null,
        },
      });
    });
  }
}

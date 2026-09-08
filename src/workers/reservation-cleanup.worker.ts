import { LiquidityReservationStatus, OrderStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { LiquidityService } from '../modules/liquidity/liquidity.service.js';

export interface ProcessExpiredReservationsOptions {
  batchSize?: number;
}

export interface ProcessedExpiredReservationResult {
  reservationId: string;
  orderId: string;
  releasedAmount: string;
  status: LiquidityReservationStatus;
}

export class ReservationCleanupWorker {
  /**
   * Scans for expired RESERVED reservations and safely releases liquidity capacity.
   * Updates order status to EXPIRED where appropriate.
   * Safe to run repeatedly.
   */
  public async processExpiredReservations(
    options: ProcessExpiredReservationsOptions = {}
  ): Promise<ProcessedExpiredReservationResult[]> {
    const batchSize = options.batchSize || 20;
    const now = new Date();

    const expiredReservations = await prisma.liquidityReservation.findMany({
      where: {
        status: LiquidityReservationStatus.RESERVED,
        expiresAt: { lte: now },
      },
      take: batchSize,
      orderBy: { expiresAt: 'asc' },
    });

    const results: ProcessedExpiredReservationResult[] = [];

    for (const reservation of expiredReservations) {
      const result = await this.processSingleReservation(reservation.id);
      if (result) {
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Processes an individual expired reservation safely and atomically.
   */
  public async processSingleReservation(
    reservationId: string
  ): Promise<ProcessedExpiredReservationResult | null> {
    const reservation = await prisma.liquidityReservation.findUnique({
      where: { id: reservationId },
    });

    if (!reservation || reservation.status !== LiquidityReservationStatus.RESERVED) {
      return null;
    }

    // Release liquidity reservation atomically
    const updatedReservation = await LiquidityService.expireReservation(reservation.orderId);

    if (!updatedReservation) {
      return null;
    }

    // Update Order status to EXPIRED if order is still in CREATED or AWAITING_PAYMENT
    const targetOrder = await prisma.order.findUnique({
      where: { id: reservation.orderId },
    });

    if (
      targetOrder &&
      (targetOrder.status === OrderStatus.CREATED ||
        targetOrder.status === OrderStatus.AWAITING_PAYMENT)
    ) {
      await prisma.order.update({
        where: { id: targetOrder.id },
        data: { status: OrderStatus.EXPIRED },
      });
    }

    return {
      reservationId: updatedReservation.id,
      orderId: updatedReservation.orderId,
      releasedAmount: updatedReservation.amount.toString(),
      status: updatedReservation.status,
    };
  }
}

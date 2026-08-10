import { OrderStatus, Prisma, SettlementStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import {
  NotFoundError,
  ForbiddenError,
  SettlementNotFoundError,
  InvalidOrderStateForSettlementError,
  InvalidSettlementStateError,
} from '../../errors/index.js';
import { SettlementStateMachine } from './settlements.state-machine.js';
import { AuditService } from '../audit/audit.service.js';

export class SettlementService {
  public static async createSettlementForOrder(
    orderId: string,
    actorId?: string,
    ipAddress?: string
  ) {
    // 1. Verify order existence
    const order = await prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundError(`Order not found: ${orderId}`);
    }

    // 2. Strict order status validation: must be SETTLEMENT_PENDING
    if (order.status !== OrderStatus.SETTLEMENT_PENDING) {
      throw new InvalidOrderStateForSettlementError(order.status);
    }

    // 3. Idempotency check: Return existing settlement if present
    const existingSettlement = await prisma.settlement.findUnique({
      where: { orderId },
    });

    if (existingSettlement) {
      return { settlement: existingSettlement, isDuplicate: true };
    }

    // 4. Server-derived amount and asset details (derived strictly from Order)
    const amount = order.destinationAmount;
    const asset = order.destinationAsset;
    const destination = order.walletAddress || null;
    const userId = order.userId;
    const settlementId = `STL_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // 5. Create Settlement Record with P2002 concurrent safety
    try {
      const settlement = await prisma.settlement.create({
        data: {
          settlementId,
          orderId,
          userId,
          status: SettlementStatus.PENDING,
          asset,
          amount,
          source: 'LUMINA_TREASURY',
          destination,
          attemptCount: 0,
        },
      });

      // 6. Record Audit Log
      await AuditService.log({
        actor: actorId || userId,
        userId,
        action: 'SETTLEMENT_CREATED',
        resource: 'Settlement',
        resourceId: settlement.id,
        details: {
          settlementId: settlement.settlementId,
          orderId: settlement.orderId,
          amount: settlement.amount.toString(),
          asset: settlement.asset,
          status: settlement.status,
        },
        ipAddress,
      });

      return { settlement, isDuplicate: false };
    } catch (err: unknown) {
      // Handle TOCTOU race condition on unique orderId constraint (P2002)
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const duplicate = await prisma.settlement.findUnique({
          where: { orderId },
        });

        if (duplicate) {
          return { settlement: duplicate, isDuplicate: true };
        }
      }
      throw err;
    }
  }

  public static async getSettlementById(
    settlementId: string,
    userId?: string,
    isAdmin = false
  ) {
    const settlement = await prisma.settlement.findFirst({
      where: {
        OR: [{ id: settlementId }, { settlementId }],
      },
      include: { order: true },
    });

    if (!settlement) {
      throw new SettlementNotFoundError(settlementId);
    }

    if (!isAdmin && userId && settlement.userId !== userId) {
      throw new ForbiddenError('Unauthorized access to this settlement.');
    }

    return settlement;
  }

  public static async getSettlementByOrder(
    orderId: string,
    userId?: string,
    isAdmin = false
  ) {
    const settlement = await prisma.settlement.findUnique({
      where: { orderId },
      include: { order: true },
    });

    if (!settlement) {
      throw new SettlementNotFoundError(`Order ${orderId}`);
    }

    if (!isAdmin && userId && settlement.userId !== userId) {
      throw new ForbiddenError('Unauthorized access to this settlement.');
    }

    return settlement;
  }

  public static async listPendingSettlements(limit = 50, offset = 0) {
    const [settlements, total] = await Promise.all([
      prisma.settlement.findMany({
        where: { status: SettlementStatus.PENDING },
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'asc' },
        include: { order: true },
      }),
      prisma.settlement.count({
        where: { status: SettlementStatus.PENDING },
      }),
    ]);

    return { settlements, total, limit, offset };
  }

  public static async markSubmitting(settlementId: string, ipAddress?: string) {
    const settlement = await this.getSettlementById(settlementId, undefined, true);
    SettlementStateMachine.validateTransition(settlement.status, SettlementStatus.SUBMITTING);

    const updateResult = await prisma.settlement.updateMany({
      where: { id: settlement.id, status: settlement.status },
      data: {
        status: SettlementStatus.SUBMITTING,
        attemptCount: { increment: 1 },
      },
    });

    if (updateResult.count === 0) {
      const current = await prisma.settlement.findUnique({ where: { id: settlement.id } });
      if (current && current.status === SettlementStatus.SUBMITTING) {
        return current;
      }
      throw new InvalidSettlementStateError(
        `Concurrent status modification detected for settlement ${settlementId}.`
      );
    }

    const updated = await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } });

    await AuditService.log({
      actor: 'system',
      userId: updated.userId,
      action: 'SETTLEMENT_SUBMITTING',
      resource: 'Settlement',
      resourceId: updated.id,
      details: {
        settlementId: updated.settlementId,
        orderId: updated.orderId,
        attemptCount: updated.attemptCount,
      },
      ipAddress,
    });

    return updated;
  }

  public static async markSubmitted(
    settlementId: string,
    transactionHash: string,
    ipAddress?: string
  ) {
    const settlement = await this.getSettlementById(settlementId, undefined, true);
    SettlementStateMachine.validateTransition(settlement.status, SettlementStatus.SUBMITTED);

    const updated = await prisma.settlement.update({
      where: { id: settlement.id },
      data: {
        status: SettlementStatus.SUBMITTED,
        stellarTransactionHash: transactionHash,
        submittedAt: new Date(),
      },
    });

    await AuditService.log({
      actor: 'system',
      userId: updated.userId,
      action: 'SETTLEMENT_SUBMITTED',
      resource: 'Settlement',
      resourceId: updated.id,
      details: {
        settlementId: updated.settlementId,
        orderId: updated.orderId,
        stellarTransactionHash: transactionHash,
      },
      ipAddress,
    });

    return updated;
  }

  public static async markConfirming(settlementId: string, ipAddress?: string) {
    const settlement = await this.getSettlementById(settlementId, undefined, true);
    SettlementStateMachine.validateTransition(settlement.status, SettlementStatus.CONFIRMING);

    const updated = await prisma.settlement.update({
      where: { id: settlement.id },
      data: {
        status: SettlementStatus.CONFIRMING,
      },
    });

    await AuditService.log({
      actor: 'system',
      userId: updated.userId,
      action: 'SETTLEMENT_CONFIRMING',
      resource: 'Settlement',
      resourceId: updated.id,
      details: {
        settlementId: updated.settlementId,
        orderId: updated.orderId,
      },
      ipAddress,
    });

    return updated;
  }

  public static async markCompleted(
    settlementId: string,
    ledger: number,
    ipAddress?: string
  ) {
    const settlement = await this.getSettlementById(settlementId, undefined, true);
    SettlementStateMachine.validateTransition(settlement.status, SettlementStatus.COMPLETED);

    const { updatedSettlement } = await prisma.$transaction(async (tx) => {
      const updatedSettlement = await tx.settlement.update({
        where: { id: settlement.id },
        data: {
          status: SettlementStatus.COMPLETED,
          stellarLedger: ledger,
          confirmedAt: new Date(),
        },
      });

      await tx.order.update({
        where: { id: settlement.orderId },
        data: { status: OrderStatus.COMPLETED },
      });

      return { updatedSettlement };
    });

    await AuditService.log({
      actor: 'system',
      userId: updatedSettlement.userId,
      action: 'SETTLEMENT_COMPLETED',
      resource: 'Settlement',
      resourceId: updatedSettlement.id,
      details: {
        settlementId: updatedSettlement.settlementId,
        orderId: updatedSettlement.orderId,
        stellarLedger: ledger,
        amount: updatedSettlement.amount.toString(),
      },
      ipAddress,
    });

    return updatedSettlement;
  }

  public static async markFailed(
    settlementId: string,
    reason: string,
    ipAddress?: string
  ) {
    const settlement = await this.getSettlementById(settlementId, undefined, true);
    SettlementStateMachine.validateTransition(settlement.status, SettlementStatus.FAILED);

    const updated = await prisma.settlement.update({
      where: { id: settlement.id },
      data: {
        status: SettlementStatus.FAILED,
        lastError: reason,
      },
    });

    await AuditService.log({
      actor: 'system',
      userId: updated.userId,
      action: 'SETTLEMENT_FAILED',
      resource: 'Settlement',
      resourceId: updated.id,
      details: {
        settlementId: updated.settlementId,
        orderId: updated.orderId,
        reason,
      },
      ipAddress,
    });

    return updated;
  }

  public static async markRequiresReconciliation(
    settlementId: string,
    reason: string,
    ipAddress?: string
  ) {
    const settlement = await this.getSettlementById(settlementId, undefined, true);
    SettlementStateMachine.validateTransition(
      settlement.status,
      SettlementStatus.REQUIRES_RECONCILIATION
    );

    const updated = await prisma.settlement.update({
      where: { id: settlement.id },
      data: {
        status: SettlementStatus.REQUIRES_RECONCILIATION,
        lastError: reason,
      },
    });

    await AuditService.log({
      actor: 'system',
      userId: updated.userId,
      action: 'SETTLEMENT_RECONCILIATION_REQUIRED',
      resource: 'Settlement',
      resourceId: updated.id,
      details: {
        settlementId: updated.settlementId,
        orderId: updated.orderId,
        reason,
      },
      ipAddress,
    });

    return updated;
  }
}

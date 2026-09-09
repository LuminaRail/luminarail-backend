import { Decimal } from '@prisma/client/runtime/library';
import { OrderStatus, PaymentStatus, RefundStatus, SettlementStatus, Prisma, LiquidityReservationStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  BadRequestError,
  RefundNotFoundError,
  InvalidRefundStateError,
} from '../../errors/index.js';
import { PaymentProviderRegistry } from '../providers/provider.registry.js';
import { RefundStateMachine } from './refund.state-machine.js';
import { OrderStateMachine } from '../orders/orders.state-machine.js';
import { AuditService } from '../audit/audit.service.js';
import { LiquidityService } from '../liquidity/liquidity.service.js';
import { CreateRefundInput } from './refunds.schemas.js';
import { DistributedLockService } from '../../infrastructure/locks/distributed-lock.service.js';

export class RefundService {
  public static async createRefund(
    userId: string,
    input: CreateRefundInput,
    isAdmin = false,
    idempotencyKeyHeader?: string,
    ipAddress?: string
  ) {
    const idempotencyKey = input.idempotencyKey || idempotencyKeyHeader;

    return await prisma.$transaction(async (tx) => {
      // 1. Lock the order row to guarantee serializability & prevent cumulative refund races (HIGH-01)
      await tx.$queryRaw`SELECT * FROM "orders" WHERE "id" = ${input.orderId} FOR UPDATE`;

      const order = await tx.order.findUnique({
        where: { id: input.orderId },
        include: { payments: true, reservation: true, settlements: true },
      });

      if (!order) {
        throw new NotFoundError(`Order not found: ${input.orderId}`);
      }

      if (!isAdmin && order.userId !== userId) {
        throw new ForbiddenError('Unauthorized access to this order for refund creation.');
      }

      // HIGH-02: Regular users may only request refunds for failed/expired/cancelled orders or pending refunds
      if (!isAdmin) {
        const allowedUserStates: OrderStatus[] = [
          OrderStatus.FAILED,
          OrderStatus.EXPIRED,
          OrderStatus.CANCELLED,
          OrderStatus.REFUND_FAILED,
          OrderStatus.REFUND_PENDING,
        ];
        if (!allowedUserStates.includes(order.status)) {
          throw new ForbiddenError(
            `Regular users may only request refunds for failed, expired, or cancelled orders (Current order state: ${order.status}).`
          );
        }
      }

      // Check terminal completed order
      if (order.status === OrderStatus.COMPLETED || order.status === OrderStatus.SETTLEMENT_COMPLETED) {
        throw new BadRequestError('Cannot refund an order that has already been successfully settled.');
      }

      // CRITICAL-01: Inspect associated settlements. Reject refund creation if ANY settlement is active or completed.
      const activeOrCompletedSettlement = order.settlements.find((s) =>
        s.status === SettlementStatus.SUBMITTING ||
        s.status === SettlementStatus.SUBMITTED ||
        s.status === SettlementStatus.CONFIRMING ||
        s.status === SettlementStatus.REQUIRES_RECONCILIATION ||
        s.status === SettlementStatus.COMPLETED
      );

      if (activeOrCompletedSettlement) {
        throw new BadRequestError(
          `Cannot initiate refund for order ${order.id}: an active or completed settlement exists (Settlement status: ${activeOrCompletedSettlement.status}).`
        );
      }

      // 2. Locate payment for refund
      let payment = input.paymentId
        ? order.payments.find((p) => p.id === input.paymentId)
        : order.payments.find((p) => p.status === PaymentStatus.SUCCEEDED) || order.payments[0];

      if (!payment) {
        throw new BadRequestError(`No eligible payment record found for order ${order.id}.`);
      }

      const capturedPaymentAmount = payment.amount;

      // 3. Check Idempotency inside tx
      const generatedKey = idempotencyKey || `REF_KEY_${order.id}_${Date.now()}`;
      const existingRefund = await tx.refund.findUnique({
        where: { idempotencyKey: generatedKey },
      });

      if (existingRefund) {
        if (!isAdmin && existingRefund.userId !== userId) {
          throw new ConflictError('Idempotency key has already been used for another refund request.');
        }
        return { refund: existingRefund, isDuplicate: true };
      }

      // 4. Calculate cumulative active/succeeded refunds inside transaction (HIGH-01)
      const existingRefunds = await tx.refund.findMany({
        where: {
          orderId: order.id,
          status: {
            in: [RefundStatus.PENDING, RefundStatus.PROCESSING, RefundStatus.SUCCEEDED],
          },
        },
      });

      const totalAlreadyRefunded = existingRefunds.reduce(
        (sum, r) => sum.plus(r.amount),
        new Decimal(0)
      );

      const remainingRefundableAmount = capturedPaymentAmount.minus(totalAlreadyRefunded);

      if (remainingRefundableAmount.lte(0)) {
        throw new BadRequestError(
          `Order ${order.id} has already been fully refunded (Refunded: NGN ${totalAlreadyRefunded.toString()} / Paid: NGN ${capturedPaymentAmount.toString()}).`
        );
      }

      const refundAmount = input.amount
        ? new Decimal(input.amount)
        : remainingRefundableAmount;

      if (refundAmount.lte(0)) {
        throw new BadRequestError('Refund amount must be a positive number.');
      }

      // INVARIANT: sum(successful/active refunds) + requestedRefundAmount <= capturedPaymentAmount
      if (totalAlreadyRefunded.plus(refundAmount).gt(capturedPaymentAmount)) {
        throw new BadRequestError(
          `Requested refund amount (NGN ${refundAmount.toString()}) exceeds remaining refundable payment balance (NGN ${remainingRefundableAmount.toString()}).`
        );
      }

      // 5. Transactionally create Refund record & update Order status
      OrderStateMachine.validateTransition(order.status, OrderStatus.REFUND_PENDING);

      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.REFUND_PENDING },
      });

      const refund = await tx.refund.create({
        data: {
          orderId: order.id,
          paymentId: payment.id,
          userId: order.userId,
          amount: refundAmount,
          currency: payment.currency || 'NGN',
          reason: input.reason || 'Requested refund',
          status: RefundStatus.PENDING,
          idempotencyKey: generatedKey,
          initiatedBy: userId,
          initiatedAt: new Date(),
        },
      });

      await AuditService.log({
        actor: userId,
        userId: order.userId,
        action: 'REFUND_CREATED',
        resource: 'Refund',
        resourceId: refund.id,
        details: {
          orderId: refund.orderId,
          paymentId: refund.paymentId,
          amount: refund.amount.toString(),
          reason: refund.reason,
          idempotencyKey: refund.idempotencyKey,
        },
        ipAddress,
      });

      return { refund, isDuplicate: false };
    });
  }

  public static async executeRefund(
    refundId: string,
    actorId = 'system',
    ipAddress?: string
  ) {
    const lockKey = `lock:refund:${refundId}`;
    const lock = await DistributedLockService.acquire(lockKey, {
      ttlMs: 20000,
      workerId: DistributedLockService.getWorkerProcessId(),
    });

    try {
      const refund = await prisma.refund.findUnique({
        where: { id: refundId },
        include: { order: true, payment: true },
      });

      if (!refund) {
        throw new RefundNotFoundError(refundId);
      }

      if (RefundStateMachine.isTerminal(refund.status)) {
        return refund;
      }

      // PAYSTACK UNKNOWN RESULT SAFETY: If status is PROCESSING and marked ambiguous, DO NOT re-call provider blindly
      if (refund.status === RefundStatus.PROCESSING) {
        const metadata = refund.metadata ? JSON.parse(refund.metadata) : {};
        if (metadata.ambiguousResponse || metadata.ambiguousNetworkFailure) {
          return refund;
        }
      }

      // Verify lock ownership before state modification
      if (lock && !lock.isOwned()) {
        throw new Error(`Distributed lock lost for refund ${refundId} prior to provider execution.`);
      }

      // Validate & lock state transition PENDING -> PROCESSING
      RefundStateMachine.validateTransition(refund.status, RefundStatus.PROCESSING);

      const updatedProcessingCount = await prisma.refund.updateMany({
        where: { id: refund.id, status: refund.status },
        data: { status: RefundStatus.PROCESSING },
      });

      if (updatedProcessingCount.count === 0) {
        return prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
      }

      const currentRefund = await prisma.refund.findUniqueOrThrow({
        where: { id: refund.id },
        include: { order: true, payment: true },
      });

      const paymentProviderName = currentRefund.payment?.provider || 'MOCK';
      const provider = PaymentProviderRegistry.get(paymentProviderName);
      const paymentRef = currentRefund.payment?.providerPaymentId || currentRefund.payment?.reference || currentRefund.orderId;

      // Verify lock ownership right before invoking Paystack external API
      if (lock && !lock.isOwned()) {
        throw new Error(`Distributed lock lost for refund ${refundId} immediately prior to Paystack API call.`);
      }

      // Call Provider Refund API
      const providerResponse = await provider.processRefund({
        refundId: currentRefund.id,
        orderId: currentRefund.orderId,
        paymentReference: paymentRef,
        amount: currentRefund.amount.toString(),
        currency: currentRefund.currency,
        reason: currentRefund.reason,
        idempotencyKey: currentRefund.idempotencyKey,
      });

    // Handle Provider Outcome
    if (providerResponse.status === RefundStatus.SUCCEEDED) {
      const finalRefund = await prisma.$transaction(async (tx) => {
        const updatedRef = await tx.refund.update({
          where: { id: currentRefund.id },
          data: {
            status: RefundStatus.SUCCEEDED,
            paystackRefundId: providerResponse.providerRefundId,
            providerReference: providerResponse.metadata?.transactionReference as string || null,
            completedAt: new Date(),
            metadata: providerResponse.rawResponse ? JSON.stringify(providerResponse.rawResponse) : null,
          },
        });

        // Update Payment status if present
        if (currentRefund.paymentId) {
          await tx.payment.update({
            where: { id: currentRefund.paymentId },
            data: { status: PaymentStatus.REFUNDED },
          });
        }

        // Update Order status to REFUNDED
        OrderStateMachine.validateTransition(currentRefund.order.status, OrderStatus.REFUNDED);
        await tx.order.update({
          where: { id: currentRefund.orderId },
          data: { status: OrderStatus.REFUNDED },
        });

        return updatedRef;
      });

      // Release any active liquidity reservation
      await LiquidityService.releaseReservation(
        currentRefund.orderId,
        LiquidityReservationStatus.CANCELLED_RELEASED
      );

      await AuditService.log({
        actor: actorId,
        userId: currentRefund.userId,
        action: 'REFUND_SUCCEEDED',
        resource: 'Refund',
        resourceId: finalRefund.id,
        details: {
          orderId: finalRefund.orderId,
          amount: finalRefund.amount.toString(),
          paystackRefundId: finalRefund.paystackRefundId,
        },
        ipAddress,
      });

      return finalRefund;
    } else if (providerResponse.status === RefundStatus.FAILED) {
      const finalRefund = await prisma.$transaction(async (tx) => {
        const updatedRef = await tx.refund.update({
          where: { id: currentRefund.id },
          data: {
            status: RefundStatus.FAILED,
            failureReason: providerResponse.failureReason || 'Provider rejected refund',
            failedAt: new Date(),
            metadata: providerResponse.rawResponse ? JSON.stringify(providerResponse.rawResponse) : null,
          },
        });

        OrderStateMachine.validateTransition(currentRefund.order.status, OrderStatus.REFUND_FAILED);
        await tx.order.update({
          where: { id: currentRefund.orderId },
          data: { status: OrderStatus.REFUND_FAILED },
        });

        return updatedRef;
      });

      await AuditService.log({
        actor: actorId,
        userId: currentRefund.userId,
        action: 'REFUND_FAILED',
        resource: 'Refund',
        resourceId: finalRefund.id,
        details: {
          orderId: finalRefund.orderId,
          reason: finalRefund.failureReason,
        },
        ipAddress,
      });

      return finalRefund;
    } else {
      // Ambiguous / Processing Response (e.g. Network Timeout or pending provider review)
      const ambiguousRefund = await prisma.refund.update({
        where: { id: currentRefund.id },
        data: {
          status: RefundStatus.PROCESSING,
          failureReason: providerResponse.failureReason || 'Ambiguous provider network response',
          metadata: JSON.stringify({
            ...(providerResponse.metadata || {}),
            ambiguousResponse: true,
          }),
        },
      });

      await AuditService.log({
        actor: actorId,
        userId: currentRefund.userId,
        action: 'REFUND_PROCESSING_AMBIGUOUS',
        resource: 'Refund',
        resourceId: ambiguousRefund.id,
        details: {
          orderId: ambiguousRefund.orderId,
          reason: ambiguousRefund.failureReason,
        },
        ipAddress,
      });

      return ambiguousRefund;
    }
    } finally {
      if (lock) {
        await DistributedLockService.release(lock);
      }
    }
  }

  /**
   * High-level helper invoked automatically when:
   * 1. Late Paystack webhook arrives after liquidity reservation expired.
   * 2. On-chain settlement explicitly fails deterministically.
   */
  public static async processAutomaticRefund(params: {
    orderId: string;
    paymentId?: string;
    reason: string;
    actorId?: string;
    ipAddress?: string;
  }) {
    const idempotencyKey = `AUTO_REF_${params.orderId}_${params.paymentId || 'def'}`;

    try {
      const order = await prisma.order.findUnique({
        where: { id: params.orderId },
      });

      if (!order) {
        return null;
      }

      const { refund } = await this.createRefund(
        order.userId,
        {
          orderId: params.orderId,
          paymentId: params.paymentId,
          reason: params.reason,
          idempotencyKey,
        },
        true,
        idempotencyKey,
        params.ipAddress
      );

      const executed = await this.executeRefund(refund.id, params.actorId || 'system-auto-refund', params.ipAddress);
      return executed;
    } catch (err) {
      // Automatic trigger failure safety log
      await AuditService.log({
        actor: params.actorId || 'system-auto-refund',
        action: 'AUTOMATIC_REFUND_TRIGGER_ERROR',
        resource: 'Order',
        resourceId: params.orderId,
        details: {
          reason: params.reason,
          error: err instanceof Error ? err.message : 'Unknown automatic refund error',
        },
        ipAddress: params.ipAddress,
      });
      return null;
    }
  }

  public static async getRefundById(refundId: string, userId?: string, isAdmin = false) {
    const refund = await prisma.refund.findUnique({
      where: { id: refundId },
      include: { order: true, payment: true },
    });

    if (!refund) {
      throw new RefundNotFoundError(refundId);
    }

    if (!isAdmin && userId && refund.userId !== userId) {
      throw new ForbiddenError('Unauthorized access to this refund.');
    }

    return refund;
  }

  public static async listRefunds(userId?: string, isAdmin = false, limit = 50, offset = 0) {
    const whereCondition = !isAdmin && userId ? { userId } : {};

    const [refunds, total] = await Promise.all([
      prisma.refund.findMany({
        where: whereCondition,
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
        include: { order: true, payment: true },
      }),
      prisma.refund.count({ where: whereCondition }),
    ]);

    return { refunds, total, limit, offset };
  }
}

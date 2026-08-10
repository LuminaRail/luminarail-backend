import { Decimal } from '@prisma/client/runtime/library';
import { OrderStatus, PaymentStatus, PaymentType, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  PaymentNotFoundError,
  InvalidPaymentStateError,
} from '../../errors/index.js';
import { PaymentProviderRegistry } from '../providers/provider.registry.js';
import { PaymentStateMachine } from './payment.state-machine.js';
import { AuditService } from '../audit/audit.service.js';
import { CreatePaymentInput } from './payments.schemas.js';

export class PaymentService {
  public static async createPayment(
    userId: string,
    input: CreatePaymentInput,
    idempotencyKey?: string,
    ipAddress?: string
  ) {
    // Step 1: Order Validation & Ownership Check FIRST (Security Requirement)
    const order = await prisma.order.findUnique({
      where: { id: input.orderId },
      include: { quote: true },
    });

    if (!order) {
      throw new NotFoundError(`Order not found: ${input.orderId}`);
    }

    if (order.userId !== userId) {
      throw new ForbiddenError('Unauthorized access to this order.');
    }

    // Step 2: Idempotency Check (Only after order & user validation)
    if (idempotencyKey) {
      const existingPayment = await prisma.payment.findUnique({
        where: { idempotencyKey },
        include: { providerTransaction: true },
      });

      if (existingPayment) {
        // Enforce cross-user and cross-order idempotency isolation
        if (existingPayment.userId !== userId || existingPayment.orderId !== input.orderId) {
          throw new ConflictError('Idempotency key has already been used for another payment request.');
        }
        return { payment: existingPayment, isDuplicate: true };
      }
    }

    // Server-calculated amounts derived strictly from Order / Quote
    const grossAmount = new Decimal(order.sourceAmount.toString());
    const providerFee = new Decimal('0.0000');
    const platformFee = grossAmount.mul(new Decimal('0.01'));
    const netAmount = grossAmount.sub(platformFee);
    const reference = `PAY_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const providerName = 'MOCK';
    const provider = PaymentProviderRegistry.get(providerName);

    let initialPayment;

    // Step 3: Establish Payment Intent in DB
    try {
      initialPayment = await prisma.payment.create({
        data: {
          orderId: order.id,
          userId,
          provider: providerName,
          type: input.type || PaymentType.DEPOSIT,
          amount: grossAmount,
          grossAmount,
          providerFee,
          platformFee,
          netAmount,
          currency: input.currency || 'NGN',
          status: PaymentStatus.CREATED,
          reference,
          idempotencyKey: idempotencyKey || null,
        },
      });
    } catch (err: any) {
      // Handle TOCTOU race on idempotencyKey unique constraint (P2002)
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        if (idempotencyKey) {
          const duplicate = await prisma.payment.findUnique({
            where: { idempotencyKey },
            include: { providerTransaction: true },
          });
          if (duplicate && duplicate.userId === userId && duplicate.orderId === input.orderId) {
            return { payment: duplicate, isDuplicate: true };
          }
        }
        throw new ConflictError('Idempotency key conflict detected.');
      }
      throw err;
    }

    // Step 4: Invoke Provider OUTSIDE Database Transaction Block
    let providerResponse;
    try {
      providerResponse = await provider.createPayment({
        orderId: order.id,
        userId,
        amount: grossAmount.toString(),
        currency: input.currency || 'NGN',
        type: input.type || PaymentType.DEPOSIT,
        reference,
      });
    } catch (providerErr) {
      // On provider failure, record payment status as FAILED
      await prisma.payment.update({
        where: { id: initialPayment.id },
        data: { status: PaymentStatus.FAILED },
      });
      throw providerErr;
    }

    // Step 5: Persist Provider Response & Update Order in DB Transaction
    try {
      const finalPayment = await prisma.$transaction(async (tx) => {
        await tx.providerTransaction.create({
          data: {
            paymentId: initialPayment.id,
            provider: providerName,
            providerTransactionId: providerResponse.providerPaymentId,
            status: providerResponse.status,
            amount: grossAmount,
            currency: input.currency || 'NGN',
            rawResponse: providerResponse.rawResponse
              ? JSON.stringify(providerResponse.rawResponse)
              : null,
          },
        });

        const updated = await tx.payment.update({
          where: { id: initialPayment.id },
          data: {
            providerPaymentId: providerResponse.providerPaymentId,
            status: providerResponse.status,
          },
          include: { providerTransaction: true },
        });

        await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.AWAITING_PAYMENT },
        });

        return updated;
      });

      // Step 6: Record Audit Log
      await AuditService.log({
        actor: userId,
        userId,
        action: 'PAYMENT_CREATED',
        resource: 'Payment',
        resourceId: finalPayment.id,
        details: {
          orderId: finalPayment.orderId,
          provider: finalPayment.provider,
          providerPaymentId: finalPayment.providerPaymentId,
          amount: finalPayment.amount.toString(),
          currency: finalPayment.currency,
          status: finalPayment.status,
          idempotencyKey: finalPayment.idempotencyKey,
        },
        ipAddress,
      });

      return { payment: finalPayment, isDuplicate: false };
    } catch (persistenceErr) {
      // Reconcile persistence failure: DB retains initialPayment in CREATED status with reference
      return { payment: initialPayment, isDuplicate: false };
    }
  }

  public static async getPaymentById(paymentId: string, userId: string, isAdmin = false) {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: true, providerTransaction: true },
    });

    if (!payment) {
      throw new PaymentNotFoundError(paymentId);
    }

    if (!isAdmin && payment.userId !== userId) {
      throw new ForbiddenError('Unauthorized access to this payment.');
    }

    return payment;
  }

  public static async verifyPayment(
    paymentId: string,
    userId: string,
    isAdmin = false,
    params?: Record<string, unknown>,
    ipAddress?: string
  ) {
    const payment = await this.getPaymentById(paymentId, userId, isAdmin);

    const provider = PaymentProviderRegistry.get(payment.provider);
    const verificationResponse = await provider.verifyPayment(
      payment.providerPaymentId || payment.reference,
      params
    );

    // Validate State Transition
    PaymentStateMachine.validateTransition(payment.status, verificationResponse.status);

    // Optimistic Concurrency Lock: update only if status is still payment.status
    const updateCount = await prisma.payment.updateMany({
      where: {
        id: payment.id,
        status: payment.status,
      },
      data: {
        status: verificationResponse.status,
      },
    });

    if (updateCount.count === 0) {
      // Payment status was modified concurrently by another worker
      const currentPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      if (currentPayment && currentPayment.status === verificationResponse.status) {
        return currentPayment;
      }
      throw new InvalidPaymentStateError(
        `Concurrent status modification detected for payment ${paymentId}.`
      );
    }

    if (payment.providerTransaction) {
      await prisma.providerTransaction.updateMany({
        where: { paymentId: payment.id },
        data: { status: verificationResponse.status },
      });
    }

    // Order State Machine Integration: STOP at SETTLEMENT_PENDING
    if (verificationResponse.status === PaymentStatus.SUCCEEDED) {
      await prisma.order.update({
        where: { id: payment.orderId },
        data: { status: OrderStatus.SETTLEMENT_PENDING },
      });
    } else if (verificationResponse.status === PaymentStatus.FAILED) {
      await prisma.order.update({
        where: { id: payment.orderId },
        data: { status: OrderStatus.FAILED },
      });
    }

    const updatedPayment = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
      include: { order: true, providerTransaction: true },
    });

    // Record Audit Logs
    await AuditService.log({
      actor: userId,
      userId: payment.userId,
      action: 'PAYMENT_VERIFIED',
      resource: 'Payment',
      resourceId: payment.id,
      details: {
        from: payment.status,
        to: updatedPayment.status,
        providerPaymentId: payment.providerPaymentId,
      },
      ipAddress,
    });

    if (updatedPayment.status === PaymentStatus.SUCCEEDED) {
      await AuditService.log({
        actor: userId,
        userId: payment.userId,
        action: 'PAYMENT_SUCCEEDED',
        resource: 'Payment',
        resourceId: payment.id,
        details: {
          amount: payment.amount.toString(),
          currency: payment.currency,
        },
        ipAddress,
      });
    } else if (updatedPayment.status === PaymentStatus.FAILED) {
      await AuditService.log({
        actor: userId,
        userId: payment.userId,
        action: 'PAYMENT_FAILED',
        resource: 'Payment',
        resourceId: payment.id,
        details: {
          amount: payment.amount.toString(),
        },
        ipAddress,
      });
    }

    return updatedPayment;
  }
}

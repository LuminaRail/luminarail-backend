import { OrderStatus, SettlementStatus, PaymentStatus, RefundStatus, LiquidityReservationStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { SettlementService } from '../modules/settlements/settlements.service.js';
import { LiquidityService } from '../modules/liquidity/liquidity.service.js';
import { SorobanConfirmationService } from '../stellar/soroban/confirmation.service.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { DistributedLockService } from '../infrastructure/locks/distributed-lock.service.js';
import { config } from '../config/index.js';
import { PaymentProviderRegistry } from '../modules/providers/provider.registry.js';

export interface ReconciliationOptions {
  batchSize?: number;
  maxStaleAgeHours?: number;
}

export interface PaymentReconciliationOptions {
  batchSize?: number;
  minPendingAgeMinutes?: number;
}

export interface ReconciledSettlementResult {
  settlementId: string;
  orderId: string;
  previousStatus: SettlementStatus;
  newStatus: SettlementStatus;
  reconciled: boolean;
  error?: string;
}

export interface ReconciledPaymentResult {
  orderId: string;
  paymentReference: string;
  previousOrderStatus: OrderStatus;
  newOrderStatus: OrderStatus;
  reconciled: boolean;
  actionTaken: 'CONFIRMED_AND_SETTLED' | 'MARKED_FAILED' | 'DEFERRED' | 'SKIPPED';
  error?: string;
}

export class ReconciliationDaemon {
  private readonly confirmationService: SorobanConfirmationService;

  constructor(confirmationService?: SorobanConfirmationService) {
    this.confirmationService = confirmationService || new SorobanConfirmationService();
  }

  /**
   * Scans settlements requiring reconciliation and resolves them against Stellar RPC as source of truth.
   */
  public async processReconciliation(
    options: ReconciliationOptions = {}
  ): Promise<ReconciledSettlementResult[]> {
    const sweepLockKey = 'lock:worker:reconciliation-daemon';
    const sweepLock = await DistributedLockService.acquire(sweepLockKey, {
      ttlMs: 30000,
      workerId: DistributedLockService.getWorkerProcessId(),
    });

    if (!sweepLock && (config.redis?.requireDistributedLocks || config.env === 'production')) {
      return []; // Skip sweep if another process holds the reconciliation lock
    }

    try {
      const batchSize = options.batchSize || 10;
      const maxStaleAgeHours = options.maxStaleAgeHours || 24;

      const pendingReconciliation = await prisma.settlement.findMany({
        where: {
          status: {
            in: [
              SettlementStatus.SUBMITTING,
              SettlementStatus.SUBMITTED,
              SettlementStatus.CONFIRMING,
              SettlementStatus.REQUIRES_RECONCILIATION,
            ],
          },
        },
        take: batchSize,
        orderBy: { updatedAt: 'asc' },
      });

      const results: ReconciledSettlementResult[] = [];

      for (const settlement of pendingReconciliation) {
        try {
          const result = await this.reconcileSingleSettlement(settlement.id, maxStaleAgeHours);
          results.push(result);
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : 'Reconciliation execution error';
          results.push({
            settlementId: settlement.settlementId,
            orderId: settlement.orderId,
            previousStatus: settlement.status,
            newStatus: settlement.status,
            reconciled: false,
            error: errorMsg,
          });
        }
      }

      return results;
    } finally {
      if (sweepLock) {
        await DistributedLockService.release(sweepLock);
      }
    }
  }

  /**
   * Safely reconciles a single settlement by ID.
   */
  public async reconcileSingleSettlement(
    settlementDbId: string,
    maxStaleAgeHours = 24
  ): Promise<ReconciledSettlementResult> {
    const settlement = await prisma.settlement.findUnique({
      where: { id: settlementDbId },
    });

    if (!settlement) {
      throw new Error(`Settlement with ID ${settlementDbId} not found.`);
    }

    const previousStatus = settlement.status;

    // Case 1: Status SUBMITTING without transaction hash (Worker crash post-signing/pre-submit)
    if (!settlement.stellarTransactionHash) {
      // Re-verify if settlement has exceeded timeout limit
      const ageMs = Date.now() - settlement.createdAt.getTime();
      const maxAgeMs = maxStaleAgeHours * 60 * 60 * 1000;

      if (ageMs > maxAgeMs) {
        const failed = await SettlementService.markFailed(
          settlement.id,
          'Settlement expired in SUBMITTING state without transaction hash.'
        );
        await LiquidityService.releaseReservation(settlement.orderId);
        await prisma.order.update({
          where: { id: settlement.orderId },
          data: { status: OrderStatus.FAILED },
        });

        await AuditService.log({
          actor: 'system-reconciliation',
          action: 'SETTLEMENT_RECONCILIATION_FAILED',
          resource: 'Settlement',
          resourceId: settlement.id,
          details: {
            settlementId: settlement.settlementId,
            orderId: settlement.orderId,
            reason: 'Exceeded max age without submission hash',
          },
        });

        return {
          settlementId: settlement.settlementId,
          orderId: settlement.orderId,
          previousStatus,
          newStatus: failed.status,
          reconciled: true,
        };
      }
      const recon = await SettlementService.markRequiresReconciliation(
        settlement.id,
        'Settlement left in SUBMITTING state without transaction hash post-worker crash.'
      );

      await AuditService.log({
        actor: 'system-reconciliation',
        action: 'SETTLEMENT_RECONCILIATION_FLAGGED',
        resource: 'Settlement',
        resourceId: settlement.id,
        details: {
          settlementId: settlement.settlementId,
          orderId: settlement.orderId,
          action: 'Flagged SUBMITTING to REQUIRES_RECONCILIATION due to missing hash',
        },
      });

      return {
        settlementId: settlement.settlementId,
        orderId: settlement.orderId,
        previousStatus,
        newStatus: recon.status,
        reconciled: false,
      };
    }

    // Case 2: Transaction hash exists -> Query Soroban RPC as Source of Truth
    const statusResult = await this.confirmationService.getTransactionStatus(
      settlement.stellarTransactionHash
    );

    if (statusResult.status === 'SUCCESS') {
      const completed = await SettlementService.markCompleted(
        settlement.id,
        statusResult.ledger || 0
      );

      await AuditService.log({
        actor: 'system-reconciliation',
        action: 'SETTLEMENT_RECONCILED',
        resource: 'Settlement',
        resourceId: settlement.id,
        details: {
          settlementId: settlement.settlementId,
          orderId: settlement.orderId,
          txHash: settlement.stellarTransactionHash,
          ledger: statusResult.ledger,
        },
      });

      return {
        settlementId: settlement.settlementId,
        orderId: settlement.orderId,
        previousStatus,
        newStatus: completed.status,
        reconciled: true,
      };
    }

    if (statusResult.status === 'FAILED') {
      const failed = await SettlementService.markFailed(
        settlement.id,
        statusResult.error || 'On-chain transaction execution failed.'
      );

      await LiquidityService.releaseReservation(settlement.orderId);
      await prisma.order.update({
        where: { id: settlement.orderId },
        data: { status: OrderStatus.FAILED },
      });

      await AuditService.log({
        actor: 'system-reconciliation',
        action: 'SETTLEMENT_RECONCILIATION_FAILED',
        resource: 'Settlement',
        resourceId: settlement.id,
        details: {
          settlementId: settlement.settlementId,
          orderId: settlement.orderId,
          reason: statusResult.error,
        },
      });

      return {
        settlementId: settlement.settlementId,
        orderId: settlement.orderId,
        previousStatus,
        newStatus: failed.status,
        reconciled: true,
      };
    }

    // Case 3: RPC returns NOT_FOUND or PENDING
    const ageMs = Date.now() - settlement.createdAt.getTime();
    const maxAgeMs = maxStaleAgeHours * 60 * 60 * 1000;

    if (statusResult.status === 'NOT_FOUND' && ageMs > maxAgeMs) {
      const failed = await SettlementService.markFailed(
        settlement.id,
        'Transaction not found on Stellar network after timeout.'
      );

      await LiquidityService.releaseReservation(settlement.orderId);
      await prisma.order.update({
        where: { id: settlement.orderId },
        data: { status: OrderStatus.FAILED },
      });

      return {
        settlementId: settlement.settlementId,
        orderId: settlement.orderId,
        previousStatus,
        newStatus: failed.status,
        reconciled: true,
      };
    }

    // Still pending / within timeout window: retain state for subsequent daemon sweeps
    return {
      settlementId: settlement.settlementId,
      orderId: settlement.orderId,
      previousStatus,
      newStatus: settlement.status,
      reconciled: false,
    };
  }

  /**
   * Scans pending orders created > 5m ago and verifies payment status against Paystack/Payment Provider as source of truth.
   */
  public async processPaymentReconciliation(
    options: PaymentReconciliationOptions = {}
  ): Promise<ReconciledPaymentResult[]> {
    const sweepLockKey = 'lock:worker:payment-reconciliation';
    const sweepLock = await DistributedLockService.acquire(sweepLockKey, {
      ttlMs: 30000,
      workerId: DistributedLockService.getWorkerProcessId(),
    });

    if (!sweepLock && (config.redis?.requireDistributedLocks || config.env === 'production')) {
      return []; // Skip sweep if another process holds the payment reconciliation lock
    }

    try {
      const batchSize = options.batchSize || 10;
      const minAgeMinutes = options.minPendingAgeMinutes || 5;
      const maxPendingAgeCutoff = new Date(Date.now() - minAgeMinutes * 60 * 1000);

      const pendingPayments = await prisma.payment.findMany({
        where: {
          status: PaymentStatus.PENDING,
          createdAt: { lte: maxPendingAgeCutoff },
        },
        take: batchSize,
        orderBy: { createdAt: 'asc' },
      });

      const results: ReconciledPaymentResult[] = [];

      for (const payment of pendingPayments) {
        try {
          const result = await this.reconcileSinglePaymentOrder(payment.orderId);
          results.push(result);
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : 'Payment reconciliation execution error';
          results.push({
            orderId: payment.orderId,
            paymentReference: payment.reference,
            previousOrderStatus: OrderStatus.AWAITING_PAYMENT,
            newOrderStatus: OrderStatus.AWAITING_PAYMENT,
            reconciled: false,
            actionTaken: 'DEFERRED',
            error: errorMsg,
          });
        }
      }

      return results;
    } finally {
      if (sweepLock) {
        await DistributedLockService.release(sweepLock);
      }
    }
  }

  /**
   * Safely reconciles a single pending payment order by ID using Postgres FOR UPDATE row lock.
   */
  public async reconcileSinglePaymentOrder(orderId: string): Promise<ReconciledPaymentResult> {
    return prisma.$transaction(async (tx) => {
      // Row lock the target order
      await tx.$queryRaw`SELECT * FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;

      const order = await tx.order.findUnique({
        where: { id: orderId },
      });

      if (!order) {
        return {
          orderId,
          paymentReference: '',
          previousOrderStatus: OrderStatus.CANCELLED,
          newOrderStatus: OrderStatus.CANCELLED,
          reconciled: false,
          actionTaken: 'SKIPPED',
          error: 'Order not found.',
        };
      }

      const payment = await tx.payment.findFirst({
        where: { orderId: order.id },
      });

      const refund = await tx.refund.findFirst({
        where: { orderId: order.id },
      });

      const paymentReference = payment?.reference || order.idempotencyKey || '';

      if (!paymentReference) {
        return {
          orderId,
          paymentReference: '',
          previousOrderStatus: order.status,
          newOrderStatus: order.status,
          reconciled: false,
          actionTaken: 'SKIPPED',
          error: 'Payment reference not found.',
        };
      }

      // Check eligibility invariants: Must be in reconcilable status (AWAITING_PAYMENT, PAYMENT_DETECTED, CREATED)
      const reconcilableStatuses: OrderStatus[] = [
        OrderStatus.AWAITING_PAYMENT,
        OrderStatus.PAYMENT_DETECTED,
        OrderStatus.CREATED,
      ];

      if (!reconcilableStatuses.includes(order.status)) {
        return {
          orderId,
          paymentReference,
          previousOrderStatus: order.status,
          newOrderStatus: order.status,
          reconciled: false,
          actionTaken: 'SKIPPED',
        };
      }

      // If refund already exists in SUCCEEDED, PROCESSING, or PENDING state, skip payment confirmation
      if (
        refund &&
        (refund.status === RefundStatus.SUCCEEDED ||
          refund.status === RefundStatus.PROCESSING ||
          refund.status === RefundStatus.PENDING)
      ) {
        return {
          orderId,
          paymentReference,
          previousOrderStatus: order.status,
          newOrderStatus: order.status,
          reconciled: false,
          actionTaken: 'SKIPPED',
          error: 'Order has active or completed refund.',
        };
      }

      // If liquidity reservation has already been released or expired by cleanup worker, skip
      const reservation = await tx.liquidityReservation.findUnique({
        where: { orderId: order.id },
      });

      if (
        reservation &&
        (reservation.status === LiquidityReservationStatus.EXPIRED_RELEASED ||
          reservation.status === LiquidityReservationStatus.CANCELLED_RELEASED)
      ) {
        return {
          orderId,
          paymentReference,
          previousOrderStatus: order.status,
          newOrderStatus: order.status,
          reconciled: false,
          actionTaken: 'SKIPPED',
          error: 'Liquidity reservation has already been released or expired.',
        };
      }

      // Query Payment Provider
      const providerId = payment?.provider || config.ngnProvider || 'SANDBOX';
      let verifyRes;
      try {
        const provider = PaymentProviderRegistry.get(providerId);
        verifyRes = await provider.verifyPayment(paymentReference, {
          expectedAmount: order.sourceAmount.toString(),
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'Provider verification error';
        await AuditService.log({
          actor: 'system-payment-reconciliation',
          action: 'PAYMENT_RECONCILIATION_DEFERRED',
          resource: 'Order',
          resourceId: order.id,
          details: {
            orderId: order.id,
            paymentReference,
            reason: `Provider error / temporary outage: ${errMsg}`,
          },
        });

        return {
          orderId: order.id,
          paymentReference,
          previousOrderStatus: order.status,
          newOrderStatus: order.status,
          reconciled: false,
          actionTaken: 'DEFERRED',
          error: errMsg,
        };
      }

      if (verifyRes.status === PaymentStatus.SUCCEEDED) {
        // Validate amount and currency integrity
        const amountMatches =
          parseFloat(verifyRes.amount) === order.sourceAmount.toNumber() ||
          verifyRes.amount === order.sourceAmount.toString();
        const currencyMatches = verifyRes.currency.toUpperCase() === order.sourceCurrency.toUpperCase();

        if (!amountMatches || !currencyMatches) {
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.FAILED },
          });

          if (payment) {
            await tx.payment.update({
              where: { id: payment.id },
              data: { status: PaymentStatus.FAILED },
            });
          }

          await LiquidityService.releaseReservationInTx(tx, order.id);

          await AuditService.log({
            actor: 'system-payment-reconciliation',
            action: 'PAYMENT_RECONCILIATION_FAILED',
            resource: 'Order',
            resourceId: order.id,
            details: {
              orderId: order.id,
              paymentReference,
              reason: `Payment verification mismatch: amountMatches=${amountMatches}, currencyMatches=${currencyMatches}`,
            },
          });

          return {
            orderId: order.id,
            paymentReference,
            previousOrderStatus: order.status,
            newOrderStatus: OrderStatus.FAILED,
            reconciled: true,
            actionTaken: 'MARKED_FAILED',
            error: 'Amount or currency mismatch during Paystack verification.',
          };
        }

        // Update payment and order status
        if (payment) {
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: PaymentStatus.SUCCEEDED,
              providerPaymentId: verifyRes.providerPaymentId || paymentReference,
            },
          });
        }

        await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.PAYMENT_CONFIRMED },
        });

        // Confirm liquidity reservation inside transaction
        await LiquidityService.confirmReservationInTx(tx, order.id);

        // Create settlement record inside transaction if missing
        let createdSettlementId = '';
        const existingSettlement = await tx.settlement.findUnique({
          where: { orderId: order.id },
        });

        if (existingSettlement) {
          createdSettlementId = existingSettlement.settlementId;
        } else {
          const generatedSettlementId = `STL_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
          const createdSettlement = await tx.settlement.create({
            data: {
              settlementId: generatedSettlementId,
              orderId: order.id,
              userId: order.userId,
              status: SettlementStatus.PENDING,
              asset: order.destinationAsset,
              amount: order.destinationAmount,
              source: config.stellar.signerPublicKey,
              destination: order.walletAddress || null,
              attemptCount: 0,
            },
          });
          createdSettlementId = createdSettlement.settlementId;
        }

        await AuditService.log({
          actor: 'system-payment-reconciliation',
          action: 'PAYMENT_RECONCILED_SUCCESS',
          resource: 'Order',
          resourceId: order.id,
          details: {
            orderId: order.id,
            paymentReference,
            settlementId: createdSettlementId,
          },
        });

        return {
          orderId: order.id,
          paymentReference,
          previousOrderStatus: order.status,
          newOrderStatus: OrderStatus.PAYMENT_CONFIRMED,
          reconciled: true,
          actionTaken: 'CONFIRMED_AND_SETTLED',
        };
      }

      if (verifyRes.status === PaymentStatus.FAILED) {
        await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.FAILED },
        });

        if (payment) {
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: PaymentStatus.FAILED },
          });
        }

        await LiquidityService.releaseReservationInTx(tx, order.id);

        await AuditService.log({
          actor: 'system-payment-reconciliation',
          action: 'PAYMENT_RECONCILIATION_FAILED',
          resource: 'Order',
          resourceId: order.id,
          details: {
            orderId: order.id,
            paymentReference,
            reason: 'Payment provider reported transaction status FAILED/ABANDONED',
          },
        });

        return {
          orderId: order.id,
          paymentReference,
          previousOrderStatus: order.status,
          newOrderStatus: OrderStatus.FAILED,
          reconciled: true,
          actionTaken: 'MARKED_FAILED',
        };
      }

      // Provider returned PENDING / IN_PROGRESS: defer safely
      await AuditService.log({
        actor: 'system-payment-reconciliation',
        action: 'PAYMENT_RECONCILIATION_DEFERRED',
        resource: 'Order',
        resourceId: order.id,
        details: {
          orderId: order.id,
          paymentReference,
          providerStatus: verifyRes.status,
        },
      });

      return {
        orderId: order.id,
        paymentReference,
        previousOrderStatus: order.status,
        newOrderStatus: order.status,
        reconciled: false,
        actionTaken: 'DEFERRED',
      };
    });
  }
}

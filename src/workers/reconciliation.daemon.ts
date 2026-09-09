import { OrderStatus, SettlementStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { SettlementService } from '../modules/settlements/settlements.service.js';
import { LiquidityService } from '../modules/liquidity/liquidity.service.js';
import { SorobanConfirmationService } from '../stellar/soroban/confirmation.service.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { DistributedLockService } from '../infrastructure/locks/distributed-lock.service.js';
import { config } from '../config/index.js';

export interface ReconciliationOptions {
  batchSize?: number;
  maxStaleAgeHours?: number;
}

export interface ReconciledSettlementResult {
  settlementId: string;
  orderId: string;
  previousStatus: SettlementStatus;
  newStatus: SettlementStatus;
  reconciled: boolean;
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
}

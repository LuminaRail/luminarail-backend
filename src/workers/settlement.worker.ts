import { OrderStatus, Settlement, SettlementStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { SettlementService } from '../modules/settlements/settlements.service.js';
import { SettlementExecutor } from '../stellar/settlement.executor.js';
import { LiveSettlementExecutor } from '../stellar/live-settlement.executor.js';
import { config } from '../config/index.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { DistributedLockService, DistributedLock } from '../infrastructure/locks/distributed-lock.service.js';

export interface ProcessPendingSettlementsOptions {
  batchSize?: number;
  stopAtSubmitting?: boolean;
}

export interface ProcessedSettlementResult {
  orderId: string;
  settlementId: string;
  status: SettlementStatus;
  isNew: boolean;
}

export class SettlementWorker {
  private executor: SettlementExecutor;

  constructor(executor?: SettlementExecutor) {
    this.executor = executor || new LiveSettlementExecutor();
  }

  /**
   * Scans for orders in SETTLEMENT_PENDING and processes settlement work through
   * the full Soroban lifecycle: PENDING -> SUBMITTING -> SUBMITTED -> CONFIRMING -> COMPLETED.
   */
  public async processPendingOrders(
    options: ProcessPendingSettlementsOptions = {}
  ): Promise<ProcessedSettlementResult[]> {
    if (config.treasury.emergencyGlobalPause) {
      await AuditService.log({
        actor: 'system-worker',
        action: 'EMERGENCY_PAUSE_ENCOUNTERED',
        resource: 'SettlementWorker',
        details: { message: 'Settlement worker execution paused due to EMERGENCY_GLOBAL_PAUSE.' },
      });
      return [];
    }

    const sweepLockKey = 'lock:worker:settlement-sweep';
    const sweepLock = await DistributedLockService.acquire(sweepLockKey, {
      ttlMs: 30000,
      workerId: DistributedLockService.getWorkerProcessId(),
    });

    if (!sweepLock && (config.redis?.requireDistributedLocks || config.env === 'production')) {
      return []; // Skip sweep if another process holds the sweep lock
    }

    try {
      const batchSize = options.batchSize || 10;
      const stopAtSubmitting = options.stopAtSubmitting ?? false;

      const eligibleOrders = await prisma.order.findMany({
        where: {
          status: OrderStatus.SETTLEMENT_PENDING,
          walletAddress: { not: null },
          OR: [
            { settlements: { none: {} } },
            { settlements: { some: { status: SettlementStatus.PENDING } } },
          ],
        },
        take: batchSize,
        orderBy: { createdAt: 'asc' },
      });

      const results: ProcessedSettlementResult[] = [];

      for (const order of eligibleOrders) {
        try {
          const result = await this.processSingleOrder(order.id, { stopAtSubmitting });
          results.push(result);
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : 'Worker processing error';
          const existing = await prisma.settlement.findUnique({
            where: { orderId: order.id },
          });
          if (existing && SettlementStateMachineCanTransition(existing.status, SettlementStatus.FAILED)) {
            await SettlementService.markFailed(
              existing.id,
              errorMessage
            );
          }
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
   * Claims and processes a single order settlement work atomically.
   */
  public async processSingleOrder(
    orderId: string,
    options: { stopAtSubmitting?: boolean } = {}
  ): Promise<ProcessedSettlementResult> {
    const { settlement, isDuplicate } = await SettlementService.createSettlementForOrder(
      orderId,
      'system-worker'
    );

    const lockKey = `lock:settlement:${settlement.id}`;
    let lock = await DistributedLockService.acquire(lockKey, {
      ttlMs: 20000,
      workerId: DistributedLockService.getWorkerProcessId(),
    });

    if (!lock) {
      const startTime = Date.now();
      while (!lock && Date.now() - startTime < 3000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        lock = await DistributedLockService.acquire(lockKey, {
          ttlMs: 20000,
          workerId: DistributedLockService.getWorkerProcessId(),
        });
      }
    }

    if (!lock) {
      if (config.redis?.requireDistributedLocks || config.env === 'production') {
        throw new Error(`Could not acquire distributed settlement lock for ${settlement.id}`);
      }
      const current = await prisma.settlement.findUnique({ where: { id: settlement.id } });
      return {
        orderId,
        settlementId: settlement.settlementId,
        status: current?.status || settlement.status,
        isNew: !isDuplicate,
      };
    }

    try {
      // Re-read fresh settlement state inside lock to prevent TOCTOU race
      const currentSettlement = await prisma.settlement.findUnique({
        where: { id: settlement.id },
      }) || settlement;

      let finalStatus = currentSettlement.status;

      if (currentSettlement.status === SettlementStatus.PENDING) {
        const submitting = await SettlementService.markSubmitting(currentSettlement.id);
        finalStatus = submitting.status;

        if (!options.stopAtSubmitting) {
          finalStatus = await this.executeSettlementFlow(submitting, lock);
        }
      } else if (!options.stopAtSubmitting && (
        currentSettlement.status === SettlementStatus.SUBMITTING ||
        currentSettlement.status === SettlementStatus.SUBMITTED ||
        currentSettlement.status === SettlementStatus.CONFIRMING
      )) {
        finalStatus = await this.executeSettlementFlow(currentSettlement, lock);
      }

      return {
        orderId,
        settlementId: settlement.settlementId,
        status: finalStatus,
        isNew: !isDuplicate,
      };
    } finally {
      if (lock) {
        await DistributedLockService.release(lock);
      }
    }
  }

  private async executeSettlementFlow(
    settlement: Settlement,
    lock?: DistributedLock | null
  ): Promise<SettlementStatus> {
    // Re-verify database state directly before taking any action
    const fresh = await prisma.settlement.findUnique({
      where: { id: settlement.id },
    });

    if (!fresh) {
      return settlement.status;
    }

    let current = fresh;

    // 1. Submit transaction if hash does not exist yet (Idempotency & lock check)
    if (!current.stellarTransactionHash) {
      // Verify lock ownership is still valid before calling KMS/RPC
      if (lock && !lock.isOwned()) {
        throw new Error(`Distributed lock lost for settlement ${current.id} before submission.`);
      }

      const submission = await this.executor.submitSettlement({
        settlementId: current.settlementId,
        orderId: current.orderId,
        source: current.source || '',
        destination: current.destination || '',
        amount: current.amount.toString(),
        asset: current.asset,
        contractAddress: current.contractAddress,
        parentLock: lock || undefined,
      });

      if (!submission.submitted || !submission.transactionHash) {
        const err = submission.error || 'Settlement submission failed';
        if (err.includes('simulation') || err.includes('config') || err.includes('Invalid')) {
          const failed = await SettlementService.markFailed(current.id, err);
          return failed.status;
        } else {
          const recon = await SettlementService.markRequiresReconciliation(current.id, err);
          return recon.status;
        }
      }

      current = await SettlementService.markSubmitted(current.id, submission.transactionHash);
    }

    // 2. Transition to CONFIRMING
    if (current.status === SettlementStatus.SUBMITTED) {
      current = await SettlementService.markConfirming(current.id);
    }

    // 3. Poll for transaction confirmation on Soroban RPC
    if (current.status === SettlementStatus.CONFIRMING && current.stellarTransactionHash) {
      const confirmation = await this.executor.confirmSettlement(current.stellarTransactionHash);

      if (confirmation.confirmed && confirmation.ledger !== undefined) {
        const completed = await SettlementService.markCompleted(current.id, confirmation.ledger);
        return completed.status;
      } else {
        const recon = await SettlementService.markRequiresReconciliation(
          current.id,
          confirmation.error || 'Settlement confirmation failed'
        );
        return recon.status;
      }
    }

    return current.status;
  }
}

function SettlementStateMachineCanTransition(from: SettlementStatus, to: SettlementStatus): boolean {
  if (from === to) return true;
  if (from === SettlementStatus.PENDING || from === SettlementStatus.SUBMITTING) {
    return to === SettlementStatus.FAILED;
  }
  return false;
}

import { OrderStatus, Settlement, SettlementStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { SettlementService } from '../modules/settlements/settlements.service.js';
import { SettlementExecutor, MockSettlementExecutor } from '../stellar/settlement.executor.js';
import { LiveSettlementExecutor } from '../stellar/live-settlement.executor.js';

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
        const { settlement, isDuplicate } = await SettlementService.createSettlementForOrder(
          order.id,
          'system-worker'
        );

        let finalStatus = settlement.status;

        if (settlement.status === SettlementStatus.PENDING) {
          const submitting = await SettlementService.markSubmitting(settlement.id);
          finalStatus = submitting.status;

          if (!stopAtSubmitting) {
            finalStatus = await this.executeSettlementFlow(submitting);
          }
        } else if (!stopAtSubmitting && (
          settlement.status === SettlementStatus.SUBMITTING ||
          settlement.status === SettlementStatus.SUBMITTED ||
          settlement.status === SettlementStatus.CONFIRMING
        )) {
          finalStatus = await this.executeSettlementFlow(settlement);
        }

        results.push({
          orderId: order.id,
          settlementId: settlement.settlementId,
          status: finalStatus,
          isNew: !isDuplicate,
        });
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

    let finalStatus = settlement.status;

    if (settlement.status === SettlementStatus.PENDING) {
      const submitting = await SettlementService.markSubmitting(settlement.id);
      finalStatus = submitting.status;

      if (!options.stopAtSubmitting) {
        finalStatus = await this.executeSettlementFlow(submitting);
      }
    } else if (!options.stopAtSubmitting && (
      settlement.status === SettlementStatus.SUBMITTING ||
      settlement.status === SettlementStatus.SUBMITTED ||
      settlement.status === SettlementStatus.CONFIRMING
    )) {
      finalStatus = await this.executeSettlementFlow(settlement);
    }

    return {
      orderId,
      settlementId: settlement.settlementId,
      status: finalStatus,
      isNew: !isDuplicate,
    };
  }

  private async executeSettlementFlow(settlement: Settlement): Promise<SettlementStatus> {
    let current = settlement;

    // 1. Submit transaction if hash does not exist yet (Idempotency guarantee)
    if (!current.stellarTransactionHash) {
      const submission = await this.executor.submitSettlement({
        settlementId: current.settlementId,
        orderId: current.orderId,
        source: current.source || '',
        destination: current.destination || '',
        amount: current.amount.toString(),
        asset: current.asset,
        contractAddress: current.contractAddress,
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

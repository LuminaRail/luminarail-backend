import { OrderStatus, SettlementStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { SettlementService } from '../modules/settlements/settlements.service.js';
import { SettlementExecutor, MockSettlementExecutor } from '../stellar/settlement.executor.js';

export interface ProcessPendingSettlementsOptions {
  batchSize?: number;
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
    this.executor = executor || new MockSettlementExecutor();
  }

  /**
   * Scans for orders in SETTLEMENT_PENDING and processes settlement work.
   * Atomically claims/creates settlement work in PENDING, transitions to SUBMITTING,
   * and stops BEFORE live on-chain submission (Phase 5A Requirement).
   */
  public async processPendingOrders(
    options: ProcessPendingSettlementsOptions = {}
  ): Promise<ProcessedSettlementResult[]> {
    const batchSize = options.batchSize || 10;

    const eligibleOrders = await prisma.order.findMany({
      where: {
        status: OrderStatus.SETTLEMENT_PENDING,
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

        if (settlement.status === SettlementStatus.PENDING) {
          const submitting = await SettlementService.markSubmitting(settlement.id);
          results.push({
            orderId: order.id,
            settlementId: submitting.settlementId,
            status: submitting.status,
            isNew: !isDuplicate,
          });
        } else {
          results.push({
            orderId: order.id,
            settlementId: settlement.settlementId,
            status: settlement.status,
            isNew: !isDuplicate,
          });
        }
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
  public async processSingleOrder(orderId: string): Promise<ProcessedSettlementResult> {
    const { settlement, isDuplicate } = await SettlementService.createSettlementForOrder(
      orderId,
      'system-worker'
    );

    if (settlement.status === SettlementStatus.PENDING) {
      const submitting = await SettlementService.markSubmitting(settlement.id);
      return {
        orderId,
        settlementId: submitting.settlementId,
        status: submitting.status,
        isNew: !isDuplicate,
      };
    }

    return {
      orderId,
      settlementId: settlement.settlementId,
      status: settlement.status,
      isNew: !isDuplicate,
    };
  }
}

function SettlementStateMachineCanTransition(from: SettlementStatus, to: SettlementStatus): boolean {
  if (from === to) return true;
  if (from === SettlementStatus.PENDING || from === SettlementStatus.SUBMITTING) {
    return to === SettlementStatus.FAILED;
  }
  return false;
}

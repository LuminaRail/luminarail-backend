import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { OrderStatus, SettlementStatus } from '@prisma/client';
import { prisma } from '../../src/db/prisma.js';
import { SettlementWorker } from '../../src/workers/settlement.worker.js';
import { SettlementExecutor, SubmitSettlementParams } from '../../src/stellar/settlement.executor.js';

class MockLiveSorobanExecutor implements SettlementExecutor {
  public submitCount = 0;
  public confirmCount = 0;
  public shouldFailSimulation = false;
  public shouldTimeoutConfirmation = false;

  public async submitSettlement(params: SubmitSettlementParams) {
    this.submitCount++;

    if (this.shouldFailSimulation) {
      return {
        submitted: false,
        error: 'Soroban transaction simulation error: Host error',
      };
    }

    return {
      submitted: true,
      transactionHash: `SOROBAN_TX_HASH_${params.settlementId}`,
    };
  }

  public async getSettlementStatus(_txHash: string) {
    if (this.shouldTimeoutConfirmation) {
      return { status: 'NOT_FOUND' as const };
    }
    return { status: 'SUCCESS' as const, ledger: 887766 };
  }

  public async confirmSettlement(_txHash: string) {
    this.confirmCount++;

    if (this.shouldTimeoutConfirmation) {
      return {
        confirmed: false,
        error: 'Soroban transaction confirmation timed out',
      };
    }

    return {
      confirmed: true,
      ledger: 887766,
    };
  }
}

describe('SettlementWorker Live Soroban Flow & Idempotency Tests', () => {
  let userId: string;
  let quoteId: string;
  let orderId1: string;
  let orderId2: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_worker_live_${Date.now()}@example.com`,
        passwordHash: 'hashed',
      },
    });
    userId = user.id;

    const quote = await prisma.quote.create({
      data: {
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 10000,
        destinationAmount: 6.5,
        exchangeRate: 1538.46,
        fee: 100,
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    quoteId = quote.id;

    const o1 = await prisma.order.create({
      data: {
        userId,
        quoteId,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 10000,
        destinationAmount: 6.5,
        walletAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        status: OrderStatus.SETTLEMENT_PENDING,
      },
    });
    orderId1 = o1.id;

    const o2 = await prisma.order.create({
      data: {
        userId,
        quoteId,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 10000,
        destinationAmount: 6.5,
        walletAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        status: OrderStatus.SETTLEMENT_PENDING,
      },
    });
    orderId2 = o2.id;
  });

  afterAll(async () => {
    if (userId) {
      await prisma.settlement.deleteMany({ where: { userId } });
      await prisma.auditLog.deleteMany({ where: { userId } });
      await prisma.order.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  it('should process pending order through full Soroban lifecycle to COMPLETED', async () => {
    const executor = new MockLiveSorobanExecutor();
    const worker = new SettlementWorker(executor);

    const result = await worker.processSingleOrder(orderId1);

    expect(result.status).toBe(SettlementStatus.COMPLETED);
    expect(executor.submitCount).toBe(1);
    expect(executor.confirmCount).toBe(1);

    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { orderId: orderId1 } });
    expect(settlement.status).toBe(SettlementStatus.COMPLETED);
    expect(settlement.stellarTransactionHash).toBe(`SOROBAN_TX_HASH_${settlement.settlementId}`);
    expect(settlement.stellarLedger).toBe(887766);
    expect(settlement.submittedAt).not.toBeNull();
    expect(settlement.confirmedAt).not.toBeNull();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId1 } });
    expect(order.status).toBe(OrderStatus.COMPLETED);
  });

  it('should prevent duplicate transaction submission if settlement is already submitted', async () => {
    const executor = new MockLiveSorobanExecutor();
    const worker = new SettlementWorker(executor);

    // Call processSingleOrder again on orderId1 (which is already COMPLETED/submitted)
    const result = await worker.processSingleOrder(orderId1);

    expect(result.status).toBe(SettlementStatus.COMPLETED);
    // submitSettlement must NOT have been called again!
    expect(executor.submitCount).toBe(0);
  });

  it('should mark REQUIRES_RECONCILIATION on confirmation timeout without creating duplicate tx', async () => {
    const executor = new MockLiveSorobanExecutor();
    executor.shouldTimeoutConfirmation = true;
    const worker = new SettlementWorker(executor);

    const result = await worker.processSingleOrder(orderId2);

    expect(result.status).toBe(SettlementStatus.REQUIRES_RECONCILIATION);
    expect(executor.submitCount).toBe(1);

    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { orderId: orderId2 } });
    expect(settlement.status).toBe(SettlementStatus.REQUIRES_RECONCILIATION);
    expect(settlement.stellarTransactionHash).toBe(`SOROBAN_TX_HASH_${settlement.settlementId}`);

    // Re-running worker on same order must NOT submit another transaction
    const initialSubmitCount = executor.submitCount;
    await worker.processSingleOrder(orderId2);
    expect(executor.submitCount).toBe(initialSubmitCount);
  });

  it('should mark FAILED on simulation failure', async () => {
    const failOrder = await prisma.order.create({
      data: {
        userId,
        quoteId,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 5000,
        destinationAmount: 3.2,
        walletAddress: 'GBBD47IF6LWK2P7MDEVSCWR7DPUWV3NY3DTQEVFL4TW4D366A5VJ26CM',
        status: OrderStatus.SETTLEMENT_PENDING,
      },
    });

    const executor = new MockLiveSorobanExecutor();
    executor.shouldFailSimulation = true;
    const worker = new SettlementWorker(executor);

    const result = await worker.processSingleOrder(failOrder.id);

    expect(result.status).toBe(SettlementStatus.FAILED);
    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { orderId: failOrder.id } });
    expect(settlement.status).toBe(SettlementStatus.FAILED);
    expect(settlement.lastError).toContain('simulation error');
  });
});

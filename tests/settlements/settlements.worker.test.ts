import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { OrderStatus, SettlementStatus } from '@prisma/client';
import { prisma } from '../../src/db/prisma.js';
import { SettlementWorker } from '../../src/workers/settlement.worker.js';
import { MockSettlementExecutor } from '../../src/stellar/settlement.executor.js';

describe('SettlementWorker Foundation Tests', () => {
  let userId: string;
  let quoteId: string;
  let orderId1: string;
  let orderId2: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_worker_${Date.now()}@example.com`,
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
        walletAddress: 'GWALLET_WORKER_1',
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
        walletAddress: 'GWALLET_WORKER_2',
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

  it('should scan pending orders, claim them, create settlements, and stop at SUBMITTING', async () => {
    const mockExecutor = new MockSettlementExecutor();
    const worker = new SettlementWorker(mockExecutor);

    const processed = await worker.processPendingOrders({ batchSize: 10 });

    expect(processed.length).toBeGreaterThanOrEqual(2);
    
    const p1 = processed.find((p) => p.orderId === orderId1);
    expect(p1).toBeDefined();
    expect(p1?.status).toBe(SettlementStatus.SUBMITTING);
    expect(p1?.isNew).toBe(true);

    const p2 = processed.find((p) => p.orderId === orderId2);
    expect(p2).toBeDefined();
    expect(p2?.status).toBe(SettlementStatus.SUBMITTING);
    expect(p2?.isNew).toBe(true);

    // Verify DB settlement records
    const s1 = await prisma.settlement.findUniqueOrThrow({ where: { orderId: orderId1 } });
    expect(s1.status).toBe(SettlementStatus.SUBMITTING);
    expect(s1.attemptCount).toBe(1);
    // Verified: stops BEFORE live submission or pretending completion
    expect(s1.confirmedAt).toBeNull();
  });

  it('should prevent duplicate settlement processing on subsequent worker run', async () => {
    const mockExecutor = new MockSettlementExecutor();
    const worker = new SettlementWorker(mockExecutor);

    const processed = await worker.processPendingOrders({ batchSize: 10 });

    const p1 = processed.find((p) => p.orderId === orderId1);
    expect(p1).toBeUndefined(); // No longer matching PENDING condition
  });

  it('should process a single order via processSingleOrder', async () => {
    const newOrder = await prisma.order.create({
      data: {
        userId,
        quoteId,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 2000,
        destinationAmount: 1.3,
        status: OrderStatus.SETTLEMENT_PENDING,
      },
    });

    const worker = new SettlementWorker();
    const result = await worker.processSingleOrder(newOrder.id);

    expect(result.orderId).toBe(newOrder.id);
    expect(result.status).toBe(SettlementStatus.SUBMITTING);
    expect(result.isNew).toBe(true);
  });
});

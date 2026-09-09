import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OrderStatus, PaymentStatus, LiquidityReservationStatus, SettlementStatus, Prisma } from '@prisma/client';
import { prisma } from '../../src/db/prisma.js';
import { SettlementWorker } from '../../src/workers/settlement.worker.ts';
import { MockSettlementExecutor } from '../../src/stellar/settlement.executor.ts';
import { SettlementService } from '../../src/modules/settlements/settlements.service.js';

describe('MAINNET-04: Concurrency & Idempotency Hardening Test Suite', () => {
  let mockExecutor: MockSettlementExecutor;
  let worker: SettlementWorker;
  let testUser: any;
  let testOrder: any;

  beforeEach(async () => {
    mockExecutor = new MockSettlementExecutor();
    worker = new SettlementWorker(mockExecutor);

    testUser = await prisma.user.create({
      data: {
        email: `concurrent_user_${Date.now()}@luminarail.com`,
        passwordHash: 'hashed_password',
      },
    });

    const quote = await prisma.quote.create({
      data: {
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: new Prisma.Decimal('30000.0000'),
        destinationAmount: new Prisma.Decimal('20.0000000'),
        exchangeRate: new Prisma.Decimal('1500.000000'),
        fee: new Prisma.Decimal('300.0000'),
        expiresAt: new Date(Date.now() + 300000),
      },
    });

    testOrder = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: quote.id,
        status: OrderStatus.SETTLEMENT_PENDING,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: new Prisma.Decimal('30000.0000'),
        destinationAmount: new Prisma.Decimal('20.0000000'),
        walletAddress: 'GACONCURRENTWORKERTESTADDRESS12345678901234567890123456',
      },
    });
  });

  afterEach(async () => {
    await prisma.settlement.deleteMany({ where: { userId: testUser?.id } });
    await prisma.order.deleteMany({ where: { userId: testUser?.id } });
    await prisma.user.deleteMany({ where: { id: testUser?.id } });
  });

  it('1. Prevents duplicate settlement creation when two workers call SettlementService.createSettlementForOrder concurrently', async () => {
    const promises = Array.from({ length: 5 }, () =>
      SettlementService.createSettlementForOrder(testOrder.id, 'worker-race-test')
    );

    const results = await Promise.all(promises);

    const newSettlements = results.filter((r) => !r.isDuplicate);
    const duplicateSettlements = results.filter((r) => r.isDuplicate);

    expect(newSettlements.length).toBe(1);
    expect(duplicateSettlements.length).toBe(4);

    const totalInDb = await prisma.settlement.count({
      where: { orderId: testOrder.id },
    });
    expect(totalInDb).toBe(1);
  });

  it('2. Prevents double execution when 5 workers run processSingleOrder concurrently', async () => {
    const promises = Array.from({ length: 5 }, () =>
      worker.processSingleOrder(testOrder.id)
    );

    const results = await Promise.all(promises);

    const totalCompleted = results.filter((r) => r.status === SettlementStatus.COMPLETED);
    expect(totalCompleted.length).toBe(5);

    const settlementsInDb = await prisma.settlement.findMany({
      where: { orderId: testOrder.id },
    });
    expect(settlementsInDb.length).toBe(1);
  });
});

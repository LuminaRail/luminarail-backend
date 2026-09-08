import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Prisma, LiquidityReservationStatus, OrderStatus } from '@prisma/client';
import { prisma } from '../../src/db/prisma.js';
import { ReservationCleanupWorker } from '../../src/workers/reservation-cleanup.worker.js';
import { OrderService } from '../../src/modules/orders/orders.service.js';
import { QuoteService } from '../../src/modules/quotes/quotes.service.js';
import { MockQuoteProvider } from '../../src/modules/quotes/providers/mock-quote.provider.js';

describe('MAINNET-02: Reservation Cleanup Worker', () => {
  let testUserId: string;
  let testPoolId: string;

  beforeEach(async () => {
    QuoteService.setProvider(new MockQuoteProvider());

    await prisma.providerTransaction.deleteMany({});
    await prisma.treasuryTransaction.deleteMany({});
    await prisma.liquidityReservation.deleteMany({});
    await prisma.liquidityPool.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.settlement.deleteMany({});
    await prisma.transaction.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.quote.deleteMany({});
    await prisma.user.deleteMany({});

    const user = await prisma.user.create({
      data: {
        email: `worker-test-${Date.now()}@example.com`,
        passwordHash: 'hashed_pw',
      },
    });
    testUserId = user.id;

    const pool = await prisma.liquidityPool.create({
      data: {
        asset: 'USDC',
        network: 'testnet',
        totalBalance: new Prisma.Decimal('100.0000000'),
        reservedBalance: new Prisma.Decimal('0.0000000'),
        availableBalance: new Prisma.Decimal('100.0000000'),
        minThreshold: new Prisma.Decimal('10.0000000'),
      },
    });
    testPoolId = pool.id;
  });

  afterEach(async () => {
    await prisma.providerTransaction.deleteMany({});
    await prisma.treasuryTransaction.deleteMany({});
    await prisma.liquidityReservation.deleteMany({});
    await prisma.liquidityPool.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.settlement.deleteMany({});
    await prisma.transaction.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.quote.deleteMany({});
    await prisma.user.deleteMany({});
  });

  it('scans for expired RESERVED reservations, releases liquidity, and marks order EXPIRED', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 40,
      side: 'destination',
    });

    const { order } = await OrderService.createOrder(testUserId, { quoteId: quote.id });

    // Manually force reservation expiresAt to the past
    await prisma.liquidityReservation.update({
      where: { orderId: order.id },
      data: { expiresAt: new Date(Date.now() - 60000) },
    });

    const worker = new ReservationCleanupWorker();
    const results = await worker.processExpiredReservations();

    expect(results.length).toBe(1);
    expect(results[0].orderId).toBe(order.id);
    expect(results[0].status).toBe(LiquidityReservationStatus.EXPIRED_RELEASED);

    // Verify pool capacity restored
    const pool = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });
    expect(pool.reservedBalance.toString()).toBe('0');
    expect(pool.availableBalance.toString()).toBe('100');

    // Verify order status updated to EXPIRED
    const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updatedOrder.status).toBe(OrderStatus.EXPIRED);
  });

  it('is safe to run repeatedly without duplicate releases', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 25,
      side: 'destination',
    });

    const { order } = await OrderService.createOrder(testUserId, { quoteId: quote.id });

    await prisma.liquidityReservation.update({
      where: { orderId: order.id },
      data: { expiresAt: new Date(Date.now() - 60000) },
    });

    const worker = new ReservationCleanupWorker();
    const results1 = await worker.processExpiredReservations();
    expect(results1.length).toBe(1);

    // Second run should find 0 expired RESERVED reservations
    const results2 = await worker.processExpiredReservations();
    expect(results2.length).toBe(0);

    const pool = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });
    expect(pool.reservedBalance.toString()).toBe('0');
    expect(pool.availableBalance.toString()).toBe('100');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Prisma, LiquidityReservationStatus, OrderStatus, TreasuryTransactionType } from '@prisma/client';
import { prisma } from '../../src/db/prisma.js';
import { LiquidityService } from '../../src/modules/liquidity/liquidity.service.js';
import { OrderService } from '../../src/modules/orders/orders.service.js';
import { QuoteService } from '../../src/modules/quotes/quotes.service.js';
import { BadRequestError } from '../../src/errors/index.js';

import { MockQuoteProvider } from '../../src/modules/quotes/providers/mock-quote.provider.js';

describe('MAINNET-02: Liquidity Reservation Engine', () => {
  let testUserId: string;
  let testPoolId: string;

  beforeEach(async () => {
    QuoteService.setProvider(new MockQuoteProvider());

    // Cleanup DB tables in foreign key dependency order
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

    // Create test user
    const user = await prisma.user.create({
      data: {
        email: `liquidity-test-${Date.now()}@example.com`,
        passwordHash: 'hashed_pw',
      },
    });
    testUserId = user.id;

    // Create test liquidity pool with 100 USDC total balance
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
    await prisma.treasuryTransaction.deleteMany({});
    await prisma.liquidityReservation.deleteMany({});
    await prisma.liquidityPool.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.transaction.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.quote.deleteMany({});
    await prisma.user.deleteMany({});
  });

  it('1. Insufficient liquidity rejects order creation and leaves pool unchanged', async () => {
    // Create quote for 150 USDC (pool only has 100 USDC)
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 150,
      side: 'destination',
    });

    await expect(
      OrderService.createOrder(testUserId, {
        quoteId: quote.id,
        walletAddress: 'GBRPYHIL2CI3FNQ4BXLFMNDLFPPPU2HY53CHWKHB5W455WBAWIVIFS5C',
      })
    ).rejects.toThrow('Insufficient liquidity');

    // Verify pool balance remains untouched
    const pool = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });
    expect(pool.totalBalance.toString()).toBe('100');
    expect(pool.reservedBalance.toString()).toBe('0');
    expect(pool.availableBalance.toString()).toBe('100');

    // Verify order was not created
    const orders = await prisma.order.findMany({});
    expect(orders.length).toBe(0);
  });

  it('2. Exact-balance reservation succeeds completely', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 100,
      side: 'destination',
    });

    const { order } = await OrderService.createOrder(testUserId, {
      quoteId: quote.id,
      walletAddress: 'GBRPYHIL2CI3FNQ4BXLFMNDLFPPPU2HY53CHWKHB5W455WBAWIVIFS5C',
    });

    expect(order).toBeDefined();

    const pool = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });
    expect(pool.reservedBalance.toString()).toBe('100');
    expect(pool.availableBalance.toString()).toBe('0');
  });

  it('3. Partial available balance reservation succeeds and updates remaining capacity', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 40,
      side: 'destination',
    });

    const { order } = await OrderService.createOrder(testUserId, {
      quoteId: quote.id,
      walletAddress: 'GBRPYHIL2CI3FNQ4BXLFMNDLFPPPU2HY53CHWKHB5W455WBAWIVIFS5C',
    });

    expect(order).toBeDefined();

    const pool = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });
    expect(pool.reservedBalance.toString()).toBe('40');
    expect(pool.availableBalance.toString()).toBe('60');
  });

  it('4. Reservation expiry releases reserved capacity back to available balance', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 30,
      side: 'destination',
    });

    const { order } = await OrderService.createOrder(testUserId, {
      quoteId: quote.id,
    });

    const poolBefore = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });
    expect(poolBefore.reservedBalance.toString()).toBe('30');
    expect(poolBefore.availableBalance.toString()).toBe('70');

    // Expire reservation
    await LiquidityService.expireReservation(order.id);

    const poolAfter = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });
    expect(poolAfter.reservedBalance.toString()).toBe('0');
    expect(poolAfter.availableBalance.toString()).toBe('100');

    const reservation = await prisma.liquidityReservation.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    expect(reservation.status).toBe(LiquidityReservationStatus.EXPIRED_RELEASED);
  });

  it('5. Manual release returns reserved capacity to available balance', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 25,
      side: 'destination',
    });

    const { order } = await OrderService.createOrder(testUserId, {
      quoteId: quote.id,
    });

    await LiquidityService.releaseReservation(
      order.id,
      LiquidityReservationStatus.CANCELLED_RELEASED
    );

    const pool = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });
    expect(pool.reservedBalance.toString()).toBe('0');
    expect(pool.availableBalance.toString()).toBe('100');
  });

  it('6. Reservation confirmation moves status to CONFIRMED without changing pool accounting', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 20,
      side: 'destination',
    });

    const { order } = await OrderService.createOrder(testUserId, { quoteId: quote.id });

    const confirmed = await LiquidityService.confirmReservation(order.id);
    expect(confirmed?.status).toBe(LiquidityReservationStatus.CONFIRMED);

    const pool = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });
    expect(pool.reservedBalance.toString()).toBe('20');
    expect(pool.availableBalance.toString()).toBe('80');
  });

  it('7. Successful consumption reduces total & reserved balances and records TreasuryTransaction', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 50,
      side: 'destination',
    });

    const { order } = await OrderService.createOrder(testUserId, { quoteId: quote.id });
    await LiquidityService.confirmReservation(order.id);

    const consumed = await LiquidityService.consumeReservation(
      order.id,
      'SETTLEMENT_REF_123',
      'stellar_tx_hash_abc'
    );

    expect(consumed?.status).toBe(LiquidityReservationStatus.CONSUMED);

    const pool = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });
    expect(pool.totalBalance.toString()).toBe('50');
    expect(pool.reservedBalance.toString()).toBe('0');
    expect(pool.availableBalance.toString()).toBe('50');

    const txs = await prisma.treasuryTransaction.findMany({ where: { poolId: testPoolId } });
    expect(txs.length).toBe(1);
    expect(txs[0].type).toBe(TreasuryTransactionType.SETTLEMENT_PAYOUT);
    expect(txs[0].amount.toString()).toBe('50');
  });

  it('8. Duplicate consume calls are idempotent and modify balances only once', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 40,
      side: 'destination',
    });

    const { order } = await OrderService.createOrder(testUserId, { quoteId: quote.id });
    await LiquidityService.confirmReservation(order.id);

    // Consume #1
    await LiquidityService.consumeReservation(order.id, 'REF_1');
    // Consume #2 (Duplicate)
    await LiquidityService.consumeReservation(order.id, 'REF_1');

    const pool = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });
    expect(pool.totalBalance.toString()).toBe('60');
    expect(pool.reservedBalance.toString()).toBe('0');
    expect(pool.availableBalance.toString()).toBe('60');

    const txs = await prisma.treasuryTransaction.findMany({ where: { poolId: testPoolId } });
    expect(txs.length).toBe(1);
  });

  it('9. Duplicate release calls are idempotent and modify balances only once', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 35,
      side: 'destination',
    });

    const { order } = await OrderService.createOrder(testUserId, { quoteId: quote.id });

    await LiquidityService.releaseReservation(order.id);
    await LiquidityService.releaseReservation(order.id);

    const pool = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });
    expect(pool.reservedBalance.toString()).toBe('0');
    expect(pool.availableBalance.toString()).toBe('100');
  });

  it('10. CONCURRENCY RACE TEST: 10 concurrent orders requesting 20 USDC against 100 USDC pool', async () => {
    // Generate 10 active quotes for 20 USDC each
    const quotes = await Promise.all(
      Array.from({ length: 10 }).map(() =>
        QuoteService.createQuote({
          sourceCurrency: 'NGN',
          destinationAsset: 'USDC',
          amount: 20,
          side: 'destination',
        })
      )
    );

    // Attempt 10 concurrent order creations
    const results = await Promise.allSettled(
      quotes.map((q, idx) =>
        OrderService.createOrder(testUserId, {
          quoteId: q.id,
          idempotencyKey: `concat-test-key-${idx}-${Date.now()}`,
          walletAddress: 'GBRPYHIL2CI3FNQ4BXLFMNDLFPPPU2HY53CHWKHB5W455WBAWIVIFS5C',
        })
      )
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(succeeded.length).toBe(5);
    expect(failed.length).toBe(5);

    // Assert final pool accounting state invariants
    const pool = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });
    expect(pool.totalBalance.toString()).toBe('100');
    expect(pool.reservedBalance.toString()).toBe('100');
    expect(pool.availableBalance.toString()).toBe('0');
  });

  it('11. Order creation idempotency retry returns existing order and reservation without duplicate reservation', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15,
      side: 'destination',
    });

    const idempotencyKey = `idem_key_${Date.now()}`;

    const res1 = await OrderService.createOrder(testUserId, {
      quoteId: quote.id,
      idempotencyKey,
    });

    const res2 = await OrderService.createOrder(testUserId, {
      quoteId: quote.id,
      idempotencyKey,
    });

    expect(res1.isDuplicate).toBe(false);
    expect(res2.isDuplicate).toBe(true);
    expect(res1.order.id).toBe(res2.order.id);

    const pool = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });
    expect(pool.reservedBalance.toString()).toBe('15');
    expect(pool.availableBalance.toString()).toBe('85');
  });

  it('12. Transaction rollback: if error occurs after reservation step, database state rolls back cleanly', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 50,
      side: 'destination',
    });

    const pool = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });

    await expect(
      prisma.$transaction(async (tx) => {
        const order = await tx.order.create({
          data: {
            userId: testUserId,
            quoteId: quote.id,
            sourceCurrency: 'NGN',
            destinationAsset: 'USDC',
            sourceAmount: new Prisma.Decimal(75000),
            destinationAmount: new Prisma.Decimal(50),
          },
        });

        await LiquidityService.reserveForOrderInTx(tx, {
          poolId: pool.id,
          orderId: order.id,
          amount: 50,
        });

        throw new Error('Simulated failure after reservation');
      })
    ).rejects.toThrow('Simulated failure after reservation');

    const poolAfter = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });
    expect(poolAfter.reservedBalance.toString()).toBe('0');
    expect(poolAfter.availableBalance.toString()).toBe('100');
  });

  it('13. Pool not found throws NotFoundError during reservation', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 10,
      side: 'destination',
    });

    await expect(
      prisma.$transaction(async (tx) => {
        const order = await tx.order.create({
          data: {
            userId: testUserId,
            quoteId: quote.id,
            sourceCurrency: 'NGN',
            destinationAsset: 'USDC',
            sourceAmount: new Prisma.Decimal(15000),
            destinationAmount: new Prisma.Decimal(10),
          },
        });

        await LiquidityService.reserveForOrderInTx(tx, {
          poolId: 'non_existent_pool_id',
          orderId: order.id,
          amount: 10,
        });
      })
    ).rejects.toThrow('Liquidity pool not found');
  });

  it('14. Invalid zero or negative amount throws BadRequestError', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await LiquidityService.reserveForOrderInTx(tx, {
          poolId: testPoolId,
          orderId: 'fake_order',
          amount: 0,
        });
      })
    ).rejects.toThrow('Reservation amount must be a positive number');

    await expect(
      prisma.$transaction(async (tx) => {
        await LiquidityService.reserveForOrderInTx(tx, {
          poolId: testPoolId,
          orderId: 'fake_order',
          amount: -25,
        });
      })
    ).rejects.toThrow('Reservation amount must be a positive number');
  });

  it('15. Decimal precision calculation remains exact without floating-point inaccuracies', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 33.3333,
      side: 'destination',
    });

    const { order } = await OrderService.createOrder(testUserId, { quoteId: quote.id });

    const pool = await prisma.liquidityPool.findUniqueOrThrow({ where: { id: testPoolId } });
    expect(pool.reservedBalance.toString()).toBe('33.3333');
    expect(pool.availableBalance.toString()).toBe('66.6667');
  });
});

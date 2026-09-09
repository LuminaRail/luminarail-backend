import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryMockRedis } from '../../src/infrastructure/redis/redis.mock.js';
import { prisma } from '../../src/db/prisma.js';
import { RedisService } from '../../src/infrastructure/redis/redis.service.js';
import { ReconciliationDaemon } from '../../src/workers/reconciliation.daemon.js';
import { PaymentProviderRegistry } from '../../src/modules/providers/provider.registry.js';
import { IPaymentProvider, NormalizedPaymentResponse } from '../../src/modules/providers/paymentProvider.interface.js';
import { OrderStatus, PaymentStatus, SettlementStatus, LiquidityReservationStatus, RefundStatus } from '@prisma/client';
import { LiquidityService } from '../../src/modules/liquidity/liquidity.service.js';
import { DistributedLockService } from '../../src/infrastructure/locks/distributed-lock.service.js';
import { config } from '../../src/config/index.js';

class MockTestPaymentProvider implements IPaymentProvider {
  public readonly providerId = 'MOCK_TEST_PROVIDER';
  public readonly supportedCurrencies = ['NGN', 'USD'];
  public mockStatus: PaymentStatus = PaymentStatus.SUCCEEDED;
  public mockAmount = '15000';
  public mockCurrency = 'NGN';
  public shouldThrow = false;

  async createPayment(): Promise<NormalizedPaymentResponse> {
    return {
      provider: this.providerId,
      providerPaymentId: 'mock_tx_id',
      status: PaymentStatus.PENDING,
      amount: '15000',
      currency: 'NGN',
    };
  }

  async getPaymentStatus(providerPaymentId: string): Promise<NormalizedPaymentResponse> {
    return this.verifyPayment(providerPaymentId);
  }

  async verifyPayment(providerPaymentId: string): Promise<NormalizedPaymentResponse> {
    if (this.shouldThrow) {
      throw new Error('Paystack API network timeout 504 Gateway Timeout');
    }
    return {
      provider: this.providerId,
      providerPaymentId,
      status: this.mockStatus,
      amount: this.mockAmount,
      currency: this.mockCurrency,
    };
  }
}

describe('Paystack Payment Reconciliation Daemon (MAINNET-07 Part 2)', () => {
  let mockRedis: any;
  let testUser: any;
  let testQuote: any;
  let mockProvider: MockTestPaymentProvider;

  beforeEach(async () => {
    mockRedis = new InMemoryMockRedis();
    RedisService.setMockClient(mockRedis);
    mockProvider = new MockTestPaymentProvider();
    PaymentProviderRegistry.register(mockProvider);

    testUser = await prisma.user.create({
      data: {
        email: `pay_recon_${Date.now()}_${Math.random()}@luminarail.com`,
        passwordHash: 'hash',
      },
    });

    testQuote = await prisma.quote.create({
      data: {
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 15000,
        destinationAmount: 10,
        exchangeRate: 1500,
        fee: 150,
        expiresAt: new Date(Date.now() + 300000),
      },
    });
  });

  afterEach(async () => {
    if (testUser) {
      await prisma.settlement.deleteMany({ where: { userId: testUser.id } });
      await prisma.refund.deleteMany({ where: { userId: testUser.id } });
      await prisma.payment.deleteMany({ where: { order: { userId: testUser.id } } });
      await prisma.liquidityReservation.deleteMany({ where: { order: { userId: testUser.id } } });
      await prisma.order.deleteMany({ where: { userId: testUser.id } });
      await prisma.user.delete({ where: { id: testUser.id } });
    }
    await mockRedis.flushall();
    await RedisService.close();
  });

  it('Reconciles missed webhook with successful payment -> confirms order & creates settlement', async () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000); // Created 10m ago

    const order = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: testQuote.id,
        status: OrderStatus.AWAITING_PAYMENT,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 15000,
        destinationAmount: 10,
        createdAt: staleDate,
      },
    });

    const pool = await LiquidityService.getPool('USDC', 'testnet');
    await LiquidityService.reserveForOrderInTx(prisma, {
      poolId: pool.id,
      orderId: order.id,
      amount: 10,
    });

    await prisma.payment.create({
      data: {
        orderId: order.id,
        userId: testUser.id,
        provider: 'MOCK_TEST_PROVIDER',
        reference: `REF_MISSED_WEBHOOK_${Date.now()}`,
        amount: 15000,
        currency: 'NGN',
        status: PaymentStatus.PENDING,
        createdAt: staleDate,
      },
    });

    const daemon = new ReconciliationDaemon();
    const results = await daemon.processPaymentReconciliation({ minPendingAgeMinutes: 5 });

    expect(results.length).toBe(1);
    expect(results[0].actionTaken).toBe('CONFIRMED_AND_SETTLED');
    expect(results[0].newOrderStatus).toBe(OrderStatus.PAYMENT_CONFIRMED);

    const updatedOrder = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updatedOrder?.status).toBe(OrderStatus.PAYMENT_CONFIRMED);

    const settlement = await prisma.settlement.findUnique({ where: { orderId: order.id } });
    expect(settlement).not.toBeNull();
    expect(settlement?.status).toBe(SettlementStatus.PENDING);
  });

  it('Reconciles missed webhook with failed payment -> marks order FAILED & releases liquidity', async () => {
    mockProvider.mockStatus = PaymentStatus.FAILED;
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);

    const order = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: testQuote.id,
        status: OrderStatus.AWAITING_PAYMENT,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 15000,
        destinationAmount: 10,
        createdAt: staleDate,
      },
    });

    const pool = await LiquidityService.getPool('USDC', 'testnet');
    await LiquidityService.reserveForOrderInTx(prisma, {
      poolId: pool.id,
      orderId: order.id,
      amount: 10,
    });

    await prisma.payment.create({
      data: {
        orderId: order.id,
        userId: testUser.id,
        provider: 'MOCK_TEST_PROVIDER',
        reference: `REF_FAILED_PAYMENT_${Date.now()}`,
        amount: 15000,
        currency: 'NGN',
        status: PaymentStatus.PENDING,
        createdAt: staleDate,
      },
    });

    const daemon = new ReconciliationDaemon();
    const results = await daemon.processPaymentReconciliation({ minPendingAgeMinutes: 5 });

    expect(results.length).toBe(1);
    expect(results[0].actionTaken).toBe('MARKED_FAILED');
    expect(results[0].newOrderStatus).toBe(OrderStatus.FAILED);

    const reservation = await prisma.liquidityReservation.findUnique({ where: { orderId: order.id } });
    expect(reservation?.status).toBe(LiquidityReservationStatus.CANCELLED_RELEASED);
  });

  it('Paystack API outage -> defers order safely in AWAITING_PAYMENT without failing', async () => {
    mockProvider.shouldThrow = true;
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);

    const order = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: testQuote.id,
        status: OrderStatus.AWAITING_PAYMENT,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 15000,
        destinationAmount: 10,
        createdAt: staleDate,
      },
    });

    await prisma.payment.create({
      data: {
        orderId: order.id,
        userId: testUser.id,
        provider: 'MOCK_TEST_PROVIDER',
        reference: `REF_OUTAGE_${Date.now()}`,
        amount: 15000,
        currency: 'NGN',
        status: PaymentStatus.PENDING,
        createdAt: staleDate,
      },
    });

    const daemon = new ReconciliationDaemon();
    const results = await daemon.processPaymentReconciliation({ minPendingAgeMinutes: 5 });

    expect(results.length).toBe(1);
    expect(results[0].actionTaken).toBe('DEFERRED');
    expect(results[0].newOrderStatus).toBe(OrderStatus.AWAITING_PAYMENT);

    const freshOrder = await prisma.order.findUnique({ where: { id: order.id } });
    expect(freshOrder?.status).toBe(OrderStatus.AWAITING_PAYMENT);
  });

  it('Rejects payment verification when amount or currency does not match', async () => {
    mockProvider.mockStatus = PaymentStatus.SUCCEEDED;
    mockProvider.mockAmount = '9999'; // Amount mismatch!
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);

    const order = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: testQuote.id,
        status: OrderStatus.AWAITING_PAYMENT,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 15000,
        destinationAmount: 10,
        createdAt: staleDate,
      },
    });

    await prisma.payment.create({
      data: {
        orderId: order.id,
        userId: testUser.id,
        provider: 'MOCK_TEST_PROVIDER',
        reference: `REF_MISMATCH_${Date.now()}`,
        amount: 15000,
        currency: 'NGN',
        status: PaymentStatus.PENDING,
        createdAt: staleDate,
      },
    });

    const daemon = new ReconciliationDaemon();
    const results = await daemon.processPaymentReconciliation({ minPendingAgeMinutes: 5 });

    expect(results[0].actionTaken).toBe('MARKED_FAILED');
    expect(results[0].error).toContain('mismatch');
  });

  it('Skips payment reconciliation if order has active or completed refund', async () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);

    const order = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: testQuote.id,
        status: OrderStatus.AWAITING_PAYMENT,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 15000,
        destinationAmount: 10,
        createdAt: staleDate,
      },
    });

    await prisma.payment.create({
      data: {
        orderId: order.id,
        userId: testUser.id,
        provider: 'MOCK_TEST_PROVIDER',
        reference: `REF_REFUNDED_${Date.now()}`,
        amount: 15000,
        currency: 'NGN',
        status: PaymentStatus.PENDING,
        createdAt: staleDate,
      },
    });

    await prisma.refund.create({
      data: {
        orderId: order.id,
        userId: testUser.id,
        amount: 15000,
        currency: 'NGN',
        status: RefundStatus.SUCCEEDED,
        reason: 'Test refund',
        idempotencyKey: `REFUND-${order.id}`,
      },
    });

    const daemon = new ReconciliationDaemon();
    const results = await daemon.processPaymentReconciliation({ minPendingAgeMinutes: 5 });

    expect(results[0].actionTaken).toBe('SKIPPED');
    expect(results[0].error).toContain('refund');
  });

  it('Idempotency & repeat sweeps: Second sweep against confirmed order is skipped cleanly', async () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);

    const order = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: testQuote.id,
        status: OrderStatus.AWAITING_PAYMENT,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 15000,
        destinationAmount: 10,
        createdAt: staleDate,
      },
    });

    await prisma.payment.create({
      data: {
        orderId: order.id,
        userId: testUser.id,
        provider: 'MOCK_TEST_PROVIDER',
        reference: `REF_REPEAT_${Date.now()}`,
        amount: 15000,
        currency: 'NGN',
        status: PaymentStatus.PENDING,
        createdAt: staleDate,
      },
    });

    const daemon = new ReconciliationDaemon();
    const run1 = await daemon.processPaymentReconciliation({ minPendingAgeMinutes: 5 });
    expect(run1[0].actionTaken).toBe('CONFIRMED_AND_SETTLED');

    const run2 = await daemon.processPaymentReconciliation({ minPendingAgeMinutes: 5 });
    expect(run2.length).toBe(0); // Order is no longer in PENDING payment state
  });

  it('Skips payment reconciliation if liquidity reservation is already EXPIRED_RELEASED', async () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);

    const order = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: testQuote.id,
        status: OrderStatus.AWAITING_PAYMENT,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 15000,
        destinationAmount: 10,
        createdAt: staleDate,
      },
    });

    const pool = await LiquidityService.getPool('USDC', 'testnet');
    await prisma.liquidityReservation.create({
      data: {
        poolId: pool.id,
        orderId: order.id,
        amount: 10,
        status: LiquidityReservationStatus.EXPIRED_RELEASED,
        expiresAt: new Date(Date.now() - 5 * 60 * 1000),
      },
    });

    await prisma.payment.create({
      data: {
        orderId: order.id,
        userId: testUser.id,
        provider: 'MOCK_TEST_PROVIDER',
        reference: `REF_EXPIRED_RES_${Date.now()}`,
        amount: 15000,
        currency: 'NGN',
        status: PaymentStatus.PENDING,
        createdAt: staleDate,
      },
    });

    const daemon = new ReconciliationDaemon();
    const results = await daemon.processPaymentReconciliation({ minPendingAgeMinutes: 5 });

    expect(results[0].actionTaken).toBe('SKIPPED');
    expect(results[0].error).toContain('released or expired');
  });
});

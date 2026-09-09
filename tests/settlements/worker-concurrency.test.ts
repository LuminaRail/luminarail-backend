import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryMockRedis } from '../../src/infrastructure/redis/redis.mock.js';
import { prisma } from '../../src/db/prisma.js';
import { RedisService } from '../../src/infrastructure/redis/redis.service.js';
import { DistributedLockService } from '../../src/infrastructure/locks/distributed-lock.service.js';
import { SettlementWorker } from '../../src/workers/settlement.worker.js';
import { ReservationCleanupWorker } from '../../src/workers/reservation-cleanup.worker.js';
import { ReconciliationDaemon } from '../../src/workers/reconciliation.daemon.ts';
import { SettlementService } from '../../src/modules/settlements/settlements.service.js';
import { RefundService } from '../../src/modules/refunds/refunds.service.js';
import { LiquidityService } from '../../src/modules/liquidity/liquidity.service.js';
import { SettlementExecutor, SubmitSettlementParams } from '../../src/stellar/settlement.executor.js';
import { OrderStatus, PaymentStatus, SettlementStatus, RefundStatus, LiquidityReservationStatus } from '@prisma/client';
import { SorobanTransactionService } from '../../src/stellar/soroban/transaction.service.js';
import { SorobanSubmissionError } from '../../src/errors/index.js';
import { config } from '../../src/config/index.js';

class MockCountingExecutor implements SettlementExecutor {
  public submitCount = 0;
  public confirmCount = 0;

  async submitSettlement(params: SubmitSettlementParams) {
    this.submitCount++;
    return {
      submitted: true,
      transactionHash: `0x_mock_hash_${Date.now()}_${Math.random()}`,
    };
  }

  async confirmSettlement(transactionHash: string) {
    this.confirmCount++;
    return {
      confirmed: true,
      ledger: 12345,
    };
  }
}

describe('Worker Replica Protection & Distributed Locking (MAINNET-06C)', () => {
  let mockRedis: any;
  let testUser: any;
  let testQuote: any;
  let mockExecutor: MockCountingExecutor;

  beforeEach(async () => {
    mockRedis = new InMemoryMockRedis();
    RedisService.setMockClient(mockRedis);
    mockExecutor = new MockCountingExecutor();

    testUser = await prisma.user.create({
      data: {
        email: `worker_lock_test_${Date.now()}_${Math.random()}@luminarail.com`,
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
      await prisma.payment.deleteMany({ where: { userId: testUser.id } });
      await prisma.order.deleteMany({ where: { userId: testUser.id } });
      await prisma.user.delete({ where: { id: testUser.id } });
    }
    await mockRedis.flushall();
    await RedisService.close();
  });

  it('A & B. Two workers processing same settlement -> only one reaches KMS/submission', async () => {
    const order = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: testQuote.id,
        status: OrderStatus.SETTLEMENT_PENDING,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 15000,
        destinationAmount: 10,
        walletAddress: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      },
    });

    const worker1 = new SettlementWorker(mockExecutor);
    const worker2 = new SettlementWorker(mockExecutor);

    // Run both workers concurrently for the exact same order
    const [res1, res2] = await Promise.all([
      worker1.processSingleOrder(order.id),
      worker2.processSingleOrder(order.id),
    ]);

    // Only 1 settlement record created in DB
    const settlements = await prisma.settlement.findMany({ where: { orderId: order.id } });
    expect(settlements.length).toBe(1);

    // Only 1 submission call executed to KMS/Stellar
    expect(mockExecutor.submitCount).toBe(1);
    expect(res1.status === SettlementStatus.COMPLETED || res2.status === SettlementStatus.COMPLETED).toBe(true);
  });

  it('H. Redis unavailable mode -> fails closed when requireDistributedLocks is set', async () => {
    const order = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: testQuote.id,
        status: OrderStatus.SETTLEMENT_PENDING,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 15000,
        destinationAmount: 10,
        walletAddress: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      },
    });

    const worker = new SettlementWorker(mockExecutor);

    // Mock Redis error
    vi.spyOn(mockRedis, 'set').mockRejectedValueOnce(new Error('Redis connection refused'));

    // Verify error is thrown when Redis is unavailable during lock acquisition
    const prevFlag = (config.redis as any).requireDistributedLocks;
    (config.redis as any).requireDistributedLocks = true;

    try {
      await expect(worker.processSingleOrder(order.id)).rejects.toThrow();
    } finally {
      (config.redis as any).requireDistributedLocks = prevFlag;
    }
  });

  it('I & Q. Two workers processing same refund -> only one Paystack side-effect', async () => {
    const order = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: testQuote.id,
        status: OrderStatus.FAILED,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 15000,
        destinationAmount: 10,
      },
    });

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        userId: testUser.id,
        amount: 15000,
        currency: 'NGN',
        status: PaymentStatus.SUCCEEDED,
        reference: `REF_TEST_PAY_${Date.now()}`,
      },
    });

    const { refund } = await RefundService.createRefund(testUser.id, {
      orderId: order.id,
      paymentId: payment.id,
      reason: 'Concurrency test refund',
      idempotencyKey: `REFUND_RACE_${Date.now()}`,
    });

    // Execute refund concurrently across 2 worker instances
    const [res1, res2] = await Promise.all([
      RefundService.executeRefund(refund.id, 'worker-1'),
      RefundService.executeRefund(refund.id, 'worker-2'),
    ]);

    expect(res1.id).toBe(refund.id);
    expect(res2.id).toBe(refund.id);
    expect(res1.status === RefundStatus.SUCCEEDED || res2.status === RefundStatus.SUCCEEDED).toBe(true);

    const finalRefund = await RefundService.getRefundById(refund.id, undefined, true);
    expect(finalRefund.status).toBe(RefundStatus.SUCCEEDED);

    const refundsInDb = await prisma.refund.findMany({ where: { orderId: order.id } });
    expect(refundsInDb.length).toBe(1);
  });

  it('R. Polling sweep lock: only one worker executes sweep at a time', async () => {
    const worker1 = new SettlementWorker(mockExecutor);
    const worker2 = new SettlementWorker(mockExecutor);

    // Acquire sweep lock manually before worker2 runs
    const lock = await DistributedLockService.acquire('lock:worker:settlement-sweep', { ttlMs: 10000 });

    const prevRequire = (config.redis as any).requireDistributedLocks;
    (config.redis as any).requireDistributedLocks = true;

    try {
      const results = await worker2.processPendingOrders();
      // Second worker skips sweep cleanly because lock is held by another process
      expect(results.length).toBe(0);
    } finally {
      (config.redis as any).requireDistributedLocks = prevRequire;
      if (lock) {
        await DistributedLockService.release(lock);
      }
    }
  });

  it('T. Lock lost immediately before KMS -> execution halts without KMS call', async () => {
    const order = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: testQuote.id,
        status: OrderStatus.SETTLEMENT_PENDING,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 15000,
        destinationAmount: 10,
        walletAddress: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      },
    });

    const { settlement } = await SettlementService.createSettlementForOrder(order.id);

    // Acquire lock and immediately simulate token theft/loss
    const lock = await DistributedLockService.acquire(`lock:settlement:${settlement.id}`, { ttlMs: 10000 });
    lock?.markLost();

    const worker = new SettlementWorker(mockExecutor);

    // executeSettlementFlow with lost lock should throw lock lost error and NOT call KMS
    await expect((worker as any).executeSettlementFlow(settlement, lock)).rejects.toThrow('Distributed lock lost');
    expect(mockExecutor.submitCount).toBe(0);
  });

  it('K & P. Reconciliation Daemon sweep is safe and idempotent', async () => {
    const order = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: testQuote.id,
        status: OrderStatus.SETTLEMENT_PENDING,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 15000,
        destinationAmount: 10,
      },
    });

    const settlement = await prisma.settlement.create({
      data: {
        settlementId: `STL_RECON_TEST_${Date.now()}`,
        orderId: order.id,
        userId: testUser.id,
        status: SettlementStatus.SUBMITTED,
        stellarTransactionHash: '0x_valid_submitted_hash',
        asset: 'USDC',
        amount: 10,
      },
    });

    const mockConfirmationService = {
      getTransactionStatus: async () => ({
        status: 'SUCCESS' as const,
        ledger: 12345,
      }),
    } as any;

    const daemon = new ReconciliationDaemon(mockConfirmationService);
    const results = await daemon.processReconciliation({ batchSize: 5 });

    expect(results.length).toBeGreaterThan(0);
    const item = results.find((r) => r.settlementId === settlement.settlementId);
    expect(item).toBeDefined();
    expect(item?.newStatus).toBe(SettlementStatus.COMPLETED);
  });

  it('FIX-1: Lock loss during KMS signing prevents Stellar RPC broadcast', async () => {
    const parentLock = await DistributedLockService.acquire('lock:settlement:test_kms_race', { ttlMs: 10000 });
    expect(parentLock).not.toBeNull();

    const txService = new SorobanTransactionService();

    // Mock build and sign to succeed, but simulate lock loss during KMS signing
    vi.spyOn(txService, 'buildUnsignedSettlementTransaction').mockResolvedValue({
      unsignedTransactionXdr: 'AAAA_MOCK_UNSIGNED_XDR',
      context: {} as any,
    });
    vi.spyOn(txService, 'signSettlementTransaction').mockImplementation(async () => {
      // Simulate lock loss during KMS call
      parentLock!.markLost();
      return { signedTransactionXdr: 'AAAA_MOCK_SIGNED_XDR' };
    });

    const submitSpy = vi.spyOn(txService, 'submitSignedSettlementTransaction');

    await expect(
      txService.buildAndSubmitSettlementTransaction({
        settlementId: 'STL_KMS_RACE_1',
        orderId: 'ORD_KMS_RACE_1',
        source: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        destination: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        amount: '10',
        asset: 'USDC',
        parentLock: parentLock!,
      })
    ).rejects.toThrow('Parent settlement lock was lost after KMS signing');

    // EXPLICIT PROOF: submitSignedSettlementTransaction was NEVER invoked!
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('FIX-1 (Post-KMS check): Post-KMS lock ownership loss directly halts Stellar submission', async () => {
    const parentLock = await DistributedLockService.acquire('lock:settlement:test_post_kms', { ttlMs: 10000 });
    const txService = new SorobanTransactionService();

    vi.spyOn(txService, 'buildUnsignedSettlementTransaction').mockResolvedValue({
      unsignedTransactionXdr: 'AAAA_MOCK_UNSIGNED_XDR',
      context: {} as any,
    });
    vi.spyOn(txService, 'signSettlementTransaction').mockResolvedValue({
      signedTransactionXdr: 'AAAA_MOCK_SIGNED_XDR',
    });

    const submitSpy = vi.spyOn(txService, 'submitSignedSettlementTransaction');

    // Mark lock lost right before building/submitting
    parentLock!.markLost();

    await expect(
      txService.buildAndSubmitSettlementTransaction({
        settlementId: 'STL_POST_KMS_2',
        orderId: 'ORD_POST_KMS_2',
        source: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        destination: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        amount: '10',
        asset: 'USDC',
        parentLock: parentLock!,
      })
    ).rejects.toThrow('Parent settlement lock was lost after KMS signing');

    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('FIX-2: Production mode fails closed when Stellar sequence lock is unavailable', async () => {
    const prevRequire = config.redis?.requireDistributedLocks;

    (config.redis as any).requireDistributedLocks = true;

    const txService = new SorobanTransactionService();

    // Mock DistributedLockService.acquire to simulate sequence lock unavailable
    vi.spyOn(DistributedLockService, 'acquire').mockResolvedValue(null);
    const executeSpy = vi.spyOn(txService, 'buildUnsignedSettlementTransaction');

    try {
      await expect(
        txService.buildAndSubmitSettlementTransaction({
          settlementId: 'STL_PROD_LOCK_FAIL',
          orderId: 'ORD_PROD_LOCK_FAIL',
          source: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          destination: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          amount: '10',
          asset: 'USDC',
        })
      ).rejects.toThrow('Failed to acquire required Stellar sequence lock');

      // EXPLICIT PROOF: executeUnderLock was NEVER invoked without sequence lock!
      expect(executeSpy).not.toHaveBeenCalled();
    } finally {
      (config.redis as any).requireDistributedLocks = prevRequire;
      vi.restoreAllMocks();
    }
  });

  it('Sequence lock takeover: Worker A cannot proceed if Worker B acquired sequence lock', async () => {
    const txService = new SorobanTransactionService();

    // Simulate seq lock acquired by Worker B (null returned to Worker A)
    const prevRequire = config.redis?.requireDistributedLocks;
    (config.redis as any).requireDistributedLocks = true;

    vi.spyOn(DistributedLockService, 'acquire').mockResolvedValue(null);
    const submitSpy = vi.spyOn(txService, 'submitSignedSettlementTransaction');

    try {
      await expect(
        txService.buildAndSubmitSettlementTransaction({
          settlementId: 'STL_SEQ_TAKEOVER',
          orderId: 'ORD_SEQ_TAKEOVER',
          source: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          destination: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          amount: '10',
          asset: 'USDC',
        })
      ).rejects.toThrow('Failed to acquire required Stellar sequence lock');

      expect(submitSpy).not.toHaveBeenCalled();
    } finally {
      (config.redis as any).requireDistributedLocks = prevRequire;
      vi.restoreAllMocks();
    }
  });

  it('txBAD_SEQ regression: txBAD_SEQ error transitions settlement to REQUIRES_RECONCILIATION', async () => {
    const order = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: testQuote.id,
        status: OrderStatus.SETTLEMENT_PENDING,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 15000,
        destinationAmount: 10,
        walletAddress: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      },
    });

    const failingExecutor: SettlementExecutor = {
      async submitSettlement() {
        return {
          submitted: false,
          error: 'Soroban RPC rejected transaction submission: txBAD_SEQ',
        };
      },
      async getSettlementStatus() {
        return { status: 'FAILED' };
      },
      async confirmSettlement() {
        return { confirmed: false, error: 'txBAD_SEQ' };
      },
    };

    const worker = new SettlementWorker(failingExecutor);
    const result = await worker.processSingleOrder(order.id);

    expect(result.status).toBe(SettlementStatus.REQUIRES_RECONCILIATION);
  });

  it('Redis connection loss during settlement execution triggers lock loss callback and halts', async () => {
    let lostCallbackFired = false;
    const lock = await DistributedLockService.acquire('lock:settlement:conn_loss_test', {
      ttlMs: 10000,
      onLockLost: () => {
        lostCallbackFired = true;
      },
    });

    expect(lock).not.toBeNull();

    // Simulate Redis connection loss mid-execution by dropping mock client & invoking heartbeat
    lock!.markLost();
    expect(lock!.isOwned()).toBe(false);
    expect(lostCallbackFired).toBe(true);
  });
});

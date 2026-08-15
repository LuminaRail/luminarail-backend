import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { OrderStatus, SettlementStatus } from '@prisma/client';
import { prisma } from '../../src/db/prisma.js';
import { SettlementService } from '../../src/modules/settlements/settlements.service.js';
import { InvalidOrderStateForSettlementError, InvalidSettlementStateError } from '../../src/errors/index.js';

describe('SettlementService Unit & Integration Tests', () => {
  let userId: string;
  let quoteId: string;
  let pendingOrderId: string;
  let createdOrderId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `test_settle_service_${Date.now()}@example.com`,
        passwordHash: 'hashed',
      },
    });
    userId = user.id;

    const quote = await prisma.quote.create({
      data: {
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 50000,
        destinationAmount: 32.5,
        exchangeRate: 1538.46,
        fee: 500,
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    quoteId = quote.id;

    const pendingOrder = await prisma.order.create({
      data: {
        userId,
        quoteId,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 50000,
        destinationAmount: 32.5,
        walletAddress: 'GBBD47IF6LWK2P7MDEVSCWR7DPUWV3NY3DTQEVFL4TW4D366A5VJ26CM',
        status: OrderStatus.SETTLEMENT_PENDING,
      },
    });
    pendingOrderId = pendingOrder.id;

    const createdOrder = await prisma.order.create({
      data: {
        userId,
        quoteId,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 50000,
        destinationAmount: 32.5,
        status: OrderStatus.CREATED,
      },
    });
    createdOrderId = createdOrder.id;
  });

  afterAll(async () => {
  if (userId) {
    const orders = await prisma.order.findMany({
      where: { userId },
      select: { id: true },
    });

    const orderIds = orders.map((order) => order.id);

    if (orderIds.length > 0) {
      await prisma.settlement.deleteMany({
        where: { orderId: { in: orderIds } },
      });
    }

    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.order.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

  it('should create settlement for order in SETTLEMENT_PENDING with server-derived amount', async () => {
    const result = await SettlementService.createSettlementForOrder(pendingOrderId, userId);

    expect(result.isDuplicate).toBe(false);
    expect(result.settlement).toBeDefined();
    expect(result.settlement.orderId).toBe(pendingOrderId);
    expect(result.settlement.status).toBe(SettlementStatus.PENDING);
    expect(Number(result.settlement.amount.toString())).toBe(32.5);
    expect(result.settlement.asset).toBe('USDC');
    expect(result.settlement.destination).toBe('GBBD47IF6LWK2P7MDEVSCWR7DPUWV3NY3DTQEVFL4TW4D366A5VJ26CM');

    // Audit log check
    const audit = await prisma.auditLog.findFirst({
      where: { resourceId: result.settlement.id, action: 'SETTLEMENT_CREATED' },
    });
    expect(audit).toBeDefined();
  });

  it('should reject settlement creation for invalid order state CREATED', async () => {
    await expect(
      SettlementService.createSettlementForOrder(createdOrderId, userId)
    ).rejects.toThrow(InvalidOrderStateForSettlementError);
  });

  it('should reject settlement creation for other invalid order states', async () => {
    const states = [
      OrderStatus.AWAITING_PAYMENT,
      OrderStatus.PAYMENT_CONFIRMED,
      OrderStatus.COMPLETED,
      OrderStatus.FAILED,
      OrderStatus.CANCELLED,
    ];

    for (const status of states) {
      const order = await prisma.order.create({
        data: {
          userId,
          quoteId,
          sourceCurrency: 'NGN',
          destinationAsset: 'USDC',
          sourceAmount: 1000,
          destinationAmount: 1,
          status,
        },
      });

      await expect(
        SettlementService.createSettlementForOrder(order.id, userId)
      ).rejects.toThrow(InvalidOrderStateForSettlementError);
    }
  });

  it('should return existing settlement idempotently on duplicate creation attempt', async () => {
    const res1 = await SettlementService.createSettlementForOrder(pendingOrderId, userId);
    expect(res1.isDuplicate).toBe(true);

    const res2 = await SettlementService.createSettlementForOrder(pendingOrderId, userId);
    expect(res2.isDuplicate).toBe(true);
    expect(res2.settlement.id).toBe(res1.settlement.id);
  });

  let completedSettlementId = '';

  it('should handle state transitions: PENDING -> SUBMITTING -> SUBMITTED -> CONFIRMING -> COMPLETED', async () => {
    const transitionOrder = await prisma.order.create({
      data: {
        userId,
        quoteId,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 20000,
        destinationAmount: 13,
        walletAddress: 'GBBD47IF6LWK2P7MDEVSCWR7DPUWV3NY3DTQEVFL4TW4D366A5VJ26CM',
        status: OrderStatus.SETTLEMENT_PENDING,
      },
    });

    const { settlement } = await SettlementService.createSettlementForOrder(transitionOrder.id, userId);
    completedSettlementId = settlement.id;

    // Mark submitting
    const submitting = await SettlementService.markSubmitting(settlement.id);
    expect(submitting.status).toBe(SettlementStatus.SUBMITTING);
    expect(submitting.attemptCount).toBe(1);

    // Mark submitted
    const hash = `0xMOCK_HASH_${Date.now()}`;
    const submitted = await SettlementService.markSubmitted(settlement.id, hash);
    expect(submitted.status).toBe(SettlementStatus.SUBMITTED);
    expect(submitted.stellarTransactionHash).toBe(hash);
    expect(submitted.submittedAt).toBeDefined();

    // Mark confirming
    const confirming = await SettlementService.markConfirming(settlement.id);
    expect(confirming.status).toBe(SettlementStatus.CONFIRMING);

    // Mark completed
    const completed = await SettlementService.markCompleted(settlement.id, 998877);
    expect(completed.status).toBe(SettlementStatus.COMPLETED);
    expect(completed.stellarLedger).toBe(998877);
    expect(completed.confirmedAt).toBeDefined();

    // Verify order updated to COMPLETED
    const order = await prisma.order.findUniqueOrThrow({ where: { id: transitionOrder.id } });
    expect(order.status).toBe(OrderStatus.COMPLETED);
  });

  it('should handle reconciliation failure transition from SUBMITTING to REQUIRES_RECONCILIATION', async () => {
    const newPendingOrder = await prisma.order.create({
      data: {
        userId,
        quoteId,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 5000,
        destinationAmount: 3.25,
        walletAddress: 'GBBD47IF6LWK2P7MDEVSCWR7DPUWV3NY3DTQEVFL4TW4D366A5VJ26CM',
        status: OrderStatus.SETTLEMENT_PENDING,
      },
    });

    const { settlement } = await SettlementService.createSettlementForOrder(newPendingOrder.id, userId);
    await SettlementService.markSubmitting(settlement.id);

    const recon = await SettlementService.markRequiresReconciliation(settlement.id, 'RPC timeout during submission');
    expect(recon.status).toBe(SettlementStatus.REQUIRES_RECONCILIATION);
    expect(recon.lastError).toBe('RPC timeout during submission');
  });

  it('should prevent invalid transition from COMPLETED state', async () => {
    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { id: completedSettlementId } });
    expect(settlement.status).toBe(SettlementStatus.COMPLETED);

    await expect(
      SettlementService.markSubmitting(settlement.id)
    ).rejects.toThrow(InvalidSettlementStateError);
  });
});

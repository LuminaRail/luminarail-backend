import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OrderStatus, PaymentStatus, LiquidityReservationStatus, SettlementStatus, Prisma } from '@prisma/client';
import { prisma } from '../../src/db/prisma.js';
import { ReconciliationDaemon } from '../../src/workers/reconciliation.daemon.js';
import { SorobanConfirmationService } from '../../src/stellar/soroban/confirmation.service.js';

describe('MAINNET-04: ReconciliationDaemon & Crash Recovery Test Suite', () => {
  let daemon: ReconciliationDaemon;
  let mockConfirmationService: SorobanConfirmationService;
  let testUser: any;
  let testOrder: any;
  let testPool: any;
  let testReservation: any;
  let testSettlement: any;

  beforeEach(async () => {
    mockConfirmationService = new SorobanConfirmationService();
    daemon = new ReconciliationDaemon(mockConfirmationService);

    testUser = await prisma.user.create({
      data: {
        email: `recon_user_${Date.now()}@luminarail.com`,
        passwordHash: 'hashed_password',
      },
    });

    const quote = await prisma.quote.create({
      data: {
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: new Prisma.Decimal('75000.0000'),
        destinationAmount: new Prisma.Decimal('50.0000000'),
        exchangeRate: new Prisma.Decimal('1500.000000'),
        fee: new Prisma.Decimal('750.0000'),
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
        sourceAmount: new Prisma.Decimal('75000.0000'),
        destinationAmount: new Prisma.Decimal('50.0000000'),
        walletAddress: 'GARECONRECIPIENTADDRESS12345678901234567890123456789012',
      },
    });

    const testAsset = `USDC_RECON_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    testPool = await prisma.liquidityPool.create({
      data: {
        asset: testAsset,
        network: 'testnet',
        totalBalance: new Prisma.Decimal('5000.0000000'),
        reservedBalance: new Prisma.Decimal('50.0000000'),
        availableBalance: new Prisma.Decimal('4950.0000000'),
        minThreshold: new Prisma.Decimal('500.0000000'),
      },
    });

    testReservation = await prisma.liquidityReservation.create({
      data: {
        poolId: testPool.id,
        orderId: testOrder.id,
        amount: new Prisma.Decimal('50.0000000'),
        status: LiquidityReservationStatus.CONFIRMED,
        expiresAt: new Date(Date.now() + 900000),
      },
    });

    testSettlement = await prisma.settlement.create({
      data: {
        settlementId: `STL_RECON_${Date.now()}`,
        orderId: testOrder.id,
        userId: testUser.id,
        status: SettlementStatus.SUBMITTED,
        asset: 'USDC',
        amount: new Prisma.Decimal('50.0000000'),
        source: 'GATREASURYSOURCEADDRESS12345678901234567890123456789012',
        destination: 'GARECONRECIPIENTADDRESS12345678901234567890123456789012',
        stellarTransactionHash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
      },
    });
  });

  afterEach(async () => {
    if (testPool) {
      await prisma.treasuryTransaction.deleteMany({ where: { poolId: testPool.id } });
      await prisma.liquidityReservation.deleteMany({ where: { poolId: testPool.id } });
      await prisma.liquidityPool.deleteMany({ where: { id: testPool.id } });
    }
    if (testUser) {
      await prisma.settlement.deleteMany({ where: { userId: testUser.id } });
      await prisma.order.deleteMany({ where: { userId: testUser.id } });
      await prisma.user.deleteMany({ where: { id: testUser.id } });
    }
  });

  it('1. Crash after signing (SUBMITTING without txHash): transitions status to REQUIRES_RECONCILIATION to block double payout', async () => {
    const unsubmittedSettlement = await prisma.settlement.create({
      data: {
        settlementId: `STL_CRASH_SIGN_${Date.now()}`,
        orderId: (await prisma.order.create({
          data: {
            userId: testUser.id,
            quoteId: testOrder.quoteId,
            status: OrderStatus.SETTLEMENT_PENDING,
            sourceCurrency: 'NGN',
            destinationAsset: 'USDC',
            sourceAmount: new Prisma.Decimal('15000.0000'),
            destinationAmount: new Prisma.Decimal('10.0000000'),
            walletAddress: 'GARECONRECIPIENTADDRESS12345678901234567890123456789012',
          },
        })).id,
        userId: testUser.id,
        status: SettlementStatus.SUBMITTING,
        asset: 'USDC',
        amount: new Prisma.Decimal('10.0000000'),
      },
    });

    const result = await daemon.reconcileSingleSettlement(unsubmittedSettlement.id);
    expect(result.newStatus).toBe(SettlementStatus.REQUIRES_RECONCILIATION);
    expect(result.reconciled).toBe(false);

    const updated = await prisma.settlement.findUnique({ where: { id: unsubmittedSettlement.id } });
    expect(updated?.status).toBe(SettlementStatus.REQUIRES_RECONCILIATION);

    // Clean up temporary order/settlement
    await prisma.settlement.delete({ where: { id: unsubmittedSettlement.id } });
    await prisma.order.delete({ where: { id: unsubmittedSettlement.orderId } });
  });

  it('2. Scenario A & E: On RPC SUCCESS -> completes Settlement, completes Order, and consumes reservation', async () => {
    vi.spyOn(mockConfirmationService, 'getTransactionStatus').mockResolvedValue({
      status: 'SUCCESS',
      ledger: 998877,
    });

    const result = await daemon.reconcileSingleSettlement(testSettlement.id);

    expect(result.newStatus).toBe(SettlementStatus.COMPLETED);
    expect(result.reconciled).toBe(true);

    const updatedSettlement = await prisma.settlement.findUnique({ where: { id: testSettlement.id } });
    expect(updatedSettlement?.status).toBe(SettlementStatus.COMPLETED);
    expect(updatedSettlement?.stellarLedger).toBe(998877);

    const updatedOrder = await prisma.order.findUnique({ where: { id: testOrder.id } });
    expect(updatedOrder?.status).toBe(OrderStatus.COMPLETED);

    const updatedReservation = await prisma.liquidityReservation.findUnique({ where: { id: testReservation.id } });
    expect(updatedReservation?.status).toBe(LiquidityReservationStatus.CONSUMED);
  });

  it('3. Scenario B: On RPC FAILED -> marks Settlement FAILED, marks Order FAILED, and releases reservation', async () => {
    vi.spyOn(mockConfirmationService, 'getTransactionStatus').mockResolvedValue({
      status: 'FAILED',
      error: 'Soroban contract revert code 12',
    });

    const result = await daemon.reconcileSingleSettlement(testSettlement.id);

    expect(result.newStatus).toBe(SettlementStatus.FAILED);
    expect(result.reconciled).toBe(true);

    const updatedSettlement = await prisma.settlement.findUnique({ where: { id: testSettlement.id } });
    expect(updatedSettlement?.status).toBe(SettlementStatus.FAILED);
    expect(updatedSettlement?.lastError).toContain('Soroban contract revert code 12');

    const updatedOrder = await prisma.order.findUnique({ where: { id: testOrder.id } });
    expect(updatedOrder?.status).toBe(OrderStatus.FAILED);

    const updatedReservation = await prisma.liquidityReservation.findUnique({ where: { id: testReservation.id } });
    expect(updatedReservation?.status).toBe(LiquidityReservationStatus.CANCELLED_RELEASED);
  });

  it('4. Scenario C: On RPC NOT_FOUND within timeout -> retains status for subsequent polling rounds', async () => {
    vi.spyOn(mockConfirmationService, 'getTransactionStatus').mockResolvedValue({
      status: 'NOT_FOUND',
    });

    const result = await daemon.reconcileSingleSettlement(testSettlement.id, 24);

    expect(result.newStatus).toBe(SettlementStatus.SUBMITTED);
    expect(result.reconciled).toBe(false);

    const updatedSettlement = await prisma.settlement.findUnique({ where: { id: testSettlement.id } });
    expect(updatedSettlement?.status).toBe(SettlementStatus.SUBMITTED);
  });

  it('5. Prevents double-consumption: Re-running daemon on already COMPLETED settlement returns early without balance changes', async () => {
    await prisma.settlement.update({
      where: { id: testSettlement.id },
      data: { status: SettlementStatus.COMPLETED, stellarLedger: 12345 },
    });
    await prisma.liquidityReservation.update({
      where: { id: testReservation.id },
      data: { status: LiquidityReservationStatus.CONSUMED },
    });

    vi.spyOn(mockConfirmationService, 'getTransactionStatus').mockResolvedValue({
      status: 'SUCCESS',
      ledger: 12345,
    });

    const result = await daemon.reconcileSingleSettlement(testSettlement.id);
    expect(result.newStatus).toBe(SettlementStatus.COMPLETED);

    const poolAfter = await prisma.liquidityPool.findUnique({ where: { id: testPool.id } });
    expect(parseFloat(poolAfter?.totalBalance.toString() || '0')).toBe(5000);
  });
});

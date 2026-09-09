import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OrderStatus, PaymentStatus, LiquidityReservationStatus, SettlementStatus, RefundStatus, Prisma } from '@prisma/client';
import { prisma } from '../../src/db/prisma.js';
import { RefundService } from '../../src/modules/refunds/refunds.service.js';
import { SettlementService } from '../../src/modules/settlements/settlements.service.js';
import { SettlementPolicyEngine } from '../../src/stellar/policy/settlement-policy.engine.js';
import { PaymentProviderRegistry } from '../../src/modules/providers/provider.registry.js';
import { ForbiddenError, BadRequestError, NotFoundError } from '../../src/errors/index.js';
import { Keypair, Address, Contract, Account, TransactionBuilder, nativeToScVal } from '@stellar/stellar-sdk';
import { stellarConfig } from '../../src/stellar/config/index.js';
import { parseSettlementIdToU64, parseAmountToStroops } from '../../src/stellar/soroban/transaction.service.js';

describe('MAINNET-05: Refund Engine Security, Concurrency & Lifecycle Test Suite', () => {
  let testUser: any;
  let adminUser: any;
  let testOrder: any;
  let testQuote: any;
  let testPayment: any;
  let testPool: any;
  let testReservation: any;

  beforeEach(async () => {
    testUser = await prisma.user.create({
      data: {
        email: `refund_user_${Date.now()}_${Math.random().toString(36).substring(2, 6)}@luminarail.com`,
        passwordHash: 'hashed_password',
        role: 'USER',
      },
    });

    adminUser = await prisma.user.create({
      data: {
        email: `admin_user_${Date.now()}_${Math.random().toString(36).substring(2, 6)}@luminarail.com`,
        passwordHash: 'hashed_password',
        role: 'ADMIN',
      },
    });

    testQuote = await prisma.quote.create({
      data: {
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: new Prisma.Decimal('150000.0000'),
        destinationAmount: new Prisma.Decimal('100.0000000'),
        exchangeRate: new Prisma.Decimal('1500.000000'),
        fee: new Prisma.Decimal('1500.0000'),
        expiresAt: new Date(Date.now() + 300000),
      },
    });

    testOrder = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: testQuote.id,
        status: OrderStatus.FAILED, // Default user-eligible state
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: new Prisma.Decimal('150000.0000'),
        destinationAmount: new Prisma.Decimal('100.0000000'),
        walletAddress: 'GARECONRECIPIENTADDRESS12345678901234567890123456789012',
      },
    });

    testPayment = await prisma.payment.create({
      data: {
        orderId: testOrder.id,
        userId: testUser.id,
        provider: 'MOCK',
        type: 'DEPOSIT',
        amount: new Prisma.Decimal('150000.0000'),
        currency: 'NGN',
        status: PaymentStatus.SUCCEEDED,
        reference: `PAY_REFUND_TEST_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      },
    });

    const testAsset = `USDC_REF_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    testPool = await prisma.liquidityPool.create({
      data: {
        asset: testAsset,
        network: 'testnet',
        totalBalance: new Prisma.Decimal('10000.0000000'),
        reservedBalance: new Prisma.Decimal('100.0000000'),
        availableBalance: new Prisma.Decimal('9900.0000000'),
        minThreshold: new Prisma.Decimal('1000.0000000'),
      },
    });

    testReservation = await prisma.liquidityReservation.create({
      data: {
        poolId: testPool.id,
        orderId: testOrder.id,
        amount: new Prisma.Decimal('100.0000000'),
        status: LiquidityReservationStatus.CONFIRMED,
        expiresAt: new Date(Date.now() + 900000),
      },
    });
  });

  afterEach(async () => {
    if (testOrder) {
      await prisma.refund.deleteMany({ where: { orderId: testOrder.id } });
      await prisma.settlement.deleteMany({ where: { orderId: testOrder.id } });
      await prisma.payment.deleteMany({ where: { orderId: testOrder.id } });
      await prisma.liquidityReservation.deleteMany({ where: { orderId: testOrder.id } });
    }
    if (testPool) {
      await prisma.liquidityPool.deleteMany({ where: { id: testPool.id } });
    }
    if (testOrder) {
      await prisma.order.deleteMany({ where: { id: testOrder.id } });
    }
    if (testUser) {
      await prisma.user.deleteMany({ where: { id: testUser.id } });
    }
    if (adminUser) {
      await prisma.user.deleteMany({ where: { id: adminUser.id } });
    }
  });

  it('1. Successful eligible refund creation and execution', async () => {
    const { refund, isDuplicate } = await RefundService.createRefund(
      testUser.id,
      { orderId: testOrder.id, reason: 'Payment failed downstream' },
      false
    );

    expect(isDuplicate).toBe(false);
    expect(refund.status).toBe(RefundStatus.PENDING);
    expect(parseFloat(refund.amount.toString())).toBe(150000);

    const executed = await RefundService.executeRefund(refund.id);
    expect(executed.status).toBe(RefundStatus.SUCCEEDED);

    const updatedOrder = await prisma.order.findUnique({ where: { id: testOrder.id } });
    expect(updatedOrder?.status).toBe(OrderStatus.REFUNDED);

    const updatedReservation = await prisma.liquidityReservation.findUnique({ where: { id: testReservation.id } });
    expect(updatedReservation?.status).toBe(LiquidityReservationStatus.CANCELLED_RELEASED);
  });

  it('2. Refund rejected for nonexistent order', async () => {
    await expect(
      RefundService.createRefund(testUser.id, { orderId: 'nonexistent-order-id', reason: 'Test' }, true)
    ).rejects.toThrow(NotFoundError);
  });

  it('3. Refund rejected for unpaid order (no payment record)', async () => {
    const unpaidOrder = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: testQuote.id,
        status: OrderStatus.FAILED,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: new Prisma.Decimal('5000.0000'),
        destinationAmount: new Prisma.Decimal('3.0000000'),
      },
    });

    await expect(
      RefundService.createRefund(testUser.id, { orderId: unpaidOrder.id, reason: 'Test' }, true)
    ).rejects.toThrow('No eligible payment record found');

    await prisma.order.delete({ where: { id: unpaidOrder.id } });
  });

  it('4. Refund rejected when order has active SETTLEMENT_PENDING state', async () => {
    await prisma.order.update({
      where: { id: testOrder.id },
      data: { status: OrderStatus.SETTLEMENT_PENDING },
    });

    await prisma.settlement.create({
      data: {
        settlementId: `STL_ACT_${Date.now()}`,
        orderId: testOrder.id,
        userId: testUser.id,
        status: SettlementStatus.SUBMITTING,
        asset: 'USDC',
        amount: new Prisma.Decimal('100.0000000'),
      },
    });

    await expect(
      RefundService.createRefund(adminUser.id, { orderId: testOrder.id, reason: 'Test' }, true)
    ).rejects.toThrow('an active or completed settlement exists');
  });

  it('5. Refund rejected when settlement status is SUBMITTING', async () => {
    await prisma.settlement.create({
      data: {
        settlementId: `STL_SUBMITTING_${Date.now()}`,
        orderId: testOrder.id,
        userId: testUser.id,
        status: SettlementStatus.SUBMITTING,
        asset: 'USDC',
        amount: new Prisma.Decimal('100.0000000'),
      },
    });

    await expect(
      RefundService.createRefund(adminUser.id, { orderId: testOrder.id, reason: 'Test' }, true)
    ).rejects.toThrow('Settlement status: SUBMITTING');
  });

  it('6. Refund rejected when settlement status is SUBMITTED', async () => {
    await prisma.settlement.create({
      data: {
        settlementId: `STL_SUBMITTED_${Date.now()}`,
        orderId: testOrder.id,
        userId: testUser.id,
        status: SettlementStatus.SUBMITTED,
        asset: 'USDC',
        amount: new Prisma.Decimal('100.0000000'),
      },
    });

    await expect(
      RefundService.createRefund(adminUser.id, { orderId: testOrder.id, reason: 'Test' }, true)
    ).rejects.toThrow('Settlement status: SUBMITTED');
  });

  it('7. Refund rejected when settlement status is CONFIRMING', async () => {
    await prisma.settlement.create({
      data: {
        settlementId: `STL_CONFIRMING_${Date.now()}`,
        orderId: testOrder.id,
        userId: testUser.id,
        status: SettlementStatus.CONFIRMING,
        asset: 'USDC',
        amount: new Prisma.Decimal('100.0000000'),
      },
    });

    await expect(
      RefundService.createRefund(adminUser.id, { orderId: testOrder.id, reason: 'Test' }, true)
    ).rejects.toThrow('Settlement status: CONFIRMING');
  });

  it('8. Refund rejected when settlement status is REQUIRES_RECONCILIATION', async () => {
    await prisma.settlement.create({
      data: {
        settlementId: `STL_RECON_${Date.now()}`,
        orderId: testOrder.id,
        userId: testUser.id,
        status: SettlementStatus.REQUIRES_RECONCILIATION,
        asset: 'USDC',
        amount: new Prisma.Decimal('100.0000000'),
      },
    });

    await expect(
      RefundService.createRefund(adminUser.id, { orderId: testOrder.id, reason: 'Test' }, true)
    ).rejects.toThrow('Settlement status: REQUIRES_RECONCILIATION');
  });

  it('9. Refund rejected after successful COMPLETED settlement', async () => {
    await prisma.order.update({
      where: { id: testOrder.id },
      data: { status: OrderStatus.COMPLETED },
    });

    await prisma.settlement.create({
      data: {
        settlementId: `STL_COMPLETED_${Date.now()}`,
        orderId: testOrder.id,
        userId: testUser.id,
        status: SettlementStatus.COMPLETED,
        asset: 'USDC',
        amount: new Prisma.Decimal('100.0000000'),
      },
    });

    await expect(
      RefundService.createRefund(adminUser.id, { orderId: testOrder.id, reason: 'Test' }, true)
    ).rejects.toThrow('already been successfully settled');
  });

  it('10. Duplicate refund request / idempotency handling', async () => {
    const key = `IDEM_REF_${Date.now()}`;
    const first = await RefundService.createRefund(
      testUser.id,
      { orderId: testOrder.id, reason: 'Test', idempotencyKey: key },
      false
    );

    expect(first.isDuplicate).toBe(false);

    const second = await RefundService.createRefund(
      testUser.id,
      { orderId: testOrder.id, reason: 'Test', idempotencyKey: key },
      false
    );

    expect(second.isDuplicate).toBe(true);
    expect(second.refund.id).toBe(first.refund.id);
  });

  it('11 & 12. Over-refund prevention & cumulative refund calculation (HIGH-01)', async () => {
    await RefundService.createRefund(
      adminUser.id,
      { orderId: testOrder.id, reason: 'Partial 1', amount: '100000.0000' },
      true
    );

    await expect(
      RefundService.createRefund(
        adminUser.id,
        { orderId: testOrder.id, reason: 'Partial 2', amount: '60000.0000' },
        true
      )
    ).rejects.toThrow('exceeds remaining refundable payment balance');

    const validSecond = await RefundService.createRefund(
      adminUser.id,
      { orderId: testOrder.id, reason: 'Partial 2 valid', amount: '50000.0000' },
      true
    );
    expect(parseFloat(validSecond.refund.amount.toString())).toBe(50000);
  });

  it('13. Refund amount tampering (negative or zero amount rejected)', async () => {
    await expect(
      RefundService.createRefund(adminUser.id, { orderId: testOrder.id, reason: 'Test', amount: '-500.0000' }, true)
    ).rejects.toThrow('Refund amount must be a positive number');

    await expect(
      RefundService.createRefund(adminUser.id, { orderId: testOrder.id, reason: 'Test', amount: '0.0000' }, true)
    ).rejects.toThrow('Refund amount must be a positive number');
  });

  it('14. Refund after payment failure or order expiry', async () => {
    const expiredOrder = await prisma.order.create({
      data: {
        userId: testUser.id,
        quoteId: testQuote.id,
        status: OrderStatus.EXPIRED,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: new Prisma.Decimal('10000.0000'),
        destinationAmount: new Prisma.Decimal('6.6600000'),
      },
    });

    const expiredPayment = await prisma.payment.create({
      data: {
        orderId: expiredOrder.id,
        userId: testUser.id,
        provider: 'MOCK',
        type: 'DEPOSIT',
        amount: new Prisma.Decimal('10000.0000'),
        currency: 'NGN',
        status: PaymentStatus.SUCCEEDED,
        reference: `PAY_EXP_${Date.now()}`,
      },
    });

    const res = await RefundService.createRefund(testUser.id, { orderId: expiredOrder.id, reason: 'Expired refund' }, false);
    expect(res.refund.status).toBe(RefundStatus.PENDING);

    await prisma.refund.deleteMany({ where: { orderId: expiredOrder.id } });
    await prisma.payment.delete({ where: { id: expiredPayment.id } });
    await prisma.order.delete({ where: { id: expiredOrder.id } });
  });

  it('15. Refund / Settlement Race Protection: Settlement creation & policy assertion reject orders with active refund', async () => {
    await RefundService.createRefund(adminUser.id, { orderId: testOrder.id, reason: 'Test' }, true);

    await expect(
      SettlementService.createSettlementForOrder(testOrder.id, 'system')
    ).rejects.toThrow();

    const policyEngine = new SettlementPolicyEngine();
    const signerKeypair = Keypair.random();
    const validRecipientKey = Keypair.random().publicKey();
    const account = new Account(signerKeypair.publicKey(), '100');
    const contract = new Contract(Address.contract(Buffer.alloc(32)).toString());

    const tx = new TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: stellarConfig.passphrase,
    })
      .addOperation(
        contract.call(
          'create_settlement',
          nativeToScVal(parseSettlementIdToU64('STL_TEST_123'), { type: 'u64' }),
          nativeToScVal(new Address(signerKeypair.publicKey())),
          nativeToScVal(new Address(validRecipientKey)),
          nativeToScVal(new Address(Address.contract(Buffer.alloc(32, 1)).toString())),
          nativeToScVal(parseAmountToStroops('100.0000000'), { type: 'i128' })
        )
      )
      .setTimeout(30)
      .build();

    const request = {
      unsignedTransactionXdr: tx.toXDR(),
      context: {
        settlementId: 'STL_TEST_123',
        orderId: testOrder.id,
        expectedSource: signerKeypair.publicKey(),
        expectedDestination: validRecipientKey,
        expectedAmountStroops: parseAmountToStroops('100.0000000'),
        expectedAssetContract: Address.contract(Buffer.alloc(32, 1)).toString(),
        expectedVaultContract: Address.contract(Buffer.alloc(32)).toString(),
      },
    };

    await expect(policyEngine.validateAndApprove(request)).rejects.toThrow('Policy Violation');
  });

  it('16. Paystack explicit refund failure sets status to FAILED', async () => {
    const { refund } = await RefundService.createRefund(
      adminUser.id,
      { orderId: testOrder.id, reason: 'simulated_failure' },
      true
    );
    const executed = await RefundService.executeRefund(refund.id);

    expect(executed.status).toBe(RefundStatus.FAILED);
    expect(executed.failureReason).toContain('Paystack Refund Rejected');

    const updatedOrder = await prisma.order.findUnique({ where: { id: testOrder.id } });
    expect(updatedOrder?.status).toBe(OrderStatus.REFUND_FAILED);
  });

  it('17. Paystack refund success sets status to SUCCEEDED and releases liquidity', async () => {
    const { refund } = await RefundService.createRefund(adminUser.id, { orderId: testOrder.id, reason: 'Success refund' }, true);
    const executed = await RefundService.executeRefund(refund.id);

    expect(executed.status).toBe(RefundStatus.SUCCEEDED);

    const updatedOrder = await prisma.order.findUnique({ where: { id: testOrder.id } });
    expect(updatedOrder?.status).toBe(OrderStatus.REFUNDED);

    const updatedReservation = await prisma.liquidityReservation.findUnique({ where: { id: testReservation.id } });
    expect(updatedReservation?.status).toBe(LiquidityReservationStatus.CANCELLED_RELEASED);
  });

  it('18 & 19. Paystack refund timeout / unknown result retains PROCESSING and prevents duplicate external refund calls', async () => {
    const mockProvider = PaymentProviderRegistry.get('MOCK');
    const processRefundSpy = vi.spyOn(mockProvider, 'processRefund');

    const { refund } = await RefundService.createRefund(
      adminUser.id,
      { orderId: testOrder.id, reason: 'simulated_network_error' },
      true
    );
    const firstExec = await RefundService.executeRefund(refund.id);

    expect(firstExec.status).toBe(RefundStatus.PROCESSING);
    expect(processRefundSpy).toHaveBeenCalledTimes(1);

    // Re-execute on ambiguous processing refund -> must NOT re-call processRefund
    const secondExec = await RefundService.executeRefund(refund.id);
    expect(secondExec.status).toBe(RefundStatus.PROCESSING);
    expect(processRefundSpy).toHaveBeenCalledTimes(1); // Call count remains 1!
  });

  it('20. Authorization failure: regular user attempting active order refund is rejected (HIGH-02)', async () => {
    await prisma.order.update({
      where: { id: testOrder.id },
      data: { status: OrderStatus.SETTLEMENT_PENDING },
    });

    await expect(
      RefundService.createRefund(testUser.id, { orderId: testOrder.id, reason: 'User attempt' }, false)
    ).rejects.toThrow(ForbiddenError);
  });

  it('21. Webhook automatic refund uses deterministic idempotency key', async () => {
    const autoResult1 = await RefundService.processAutomaticRefund({
      orderId: testOrder.id,
      paymentId: testPayment.id,
      reason: 'Late payment auto-refund',
    });

    expect(autoResult1?.status).toBe(RefundStatus.SUCCEEDED);

    // Second call with same parameters -> Idempotently returns existing refund
    const autoResult2 = await RefundService.processAutomaticRefund({
      orderId: testOrder.id,
      paymentId: testPayment.id,
      reason: 'Late payment auto-refund',
    });

    expect(autoResult2?.id).toBe(autoResult1?.id);
  });

  it('22. Liquidity reservation release correctness', async () => {
    const { refund } = await RefundService.createRefund(adminUser.id, { orderId: testOrder.id, reason: 'Test release' }, true);
    await RefundService.executeRefund(refund.id);

    const pool = await prisma.liquidityPool.findUnique({ where: { id: testPool.id } });
    expect(parseFloat(pool?.reservedBalance.toString() || '0')).toBe(0);
    expect(parseFloat(pool?.availableBalance.toString() || '0')).toBe(10000);
  });

  it('23. Terminal state regression protection: Order in REFUNDED state cannot transition back to active states', async () => {
    await prisma.order.update({
      where: { id: testOrder.id },
      data: { status: OrderStatus.REFUNDED },
    });

    await expect(
      SettlementService.createSettlementForOrder(testOrder.id, 'system')
    ).rejects.toThrow();
  });
});

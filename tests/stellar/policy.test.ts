import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Account,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  StrKey,
} from '@stellar/stellar-sdk';
import { OrderStatus, PaymentStatus, LiquidityReservationStatus, SettlementStatus, Prisma } from '@prisma/client';
import { prisma } from '../../src/db/prisma.js';
import { config } from '../../src/config/index.js';
import { stellarConfig } from '../../src/stellar/config/index.js';
import { SettlementPolicyEngine } from '../../src/stellar/policy/settlement-policy.engine.js';
import { parseAmountToStroops, parseSettlementIdToU64 } from '../../src/stellar/soroban/transaction.service.js';
import { SignTransactionRequest } from '../../src/stellar/signer/types.js';

describe('MAINNET-04: SettlementPolicyEngine Comprehensive Security Test Suite', () => {
  let policyEngine: SettlementPolicyEngine;
  let testUser: any;
  let testOrder: any;
  let testSettlement: any;
  let testPool: any;
  let testReservation: any;
  let testPayment: any;

  const signerKeypair = Keypair.random();
  const signerPublicKey = signerKeypair.publicKey();
  const validRecipientKey = Keypair.random().publicKey();
  const validContractId = Address.contract(Buffer.alloc(32)).toString();
  const validUsdcContract = Address.contract(Buffer.alloc(32, 1)).toString();

  beforeEach(async () => {
    policyEngine = new SettlementPolicyEngine();
    (config.stellar as any).signerPublicKey = signerPublicKey;
    (config.stellar as any).signerSecretKey = signerKeypair.secret();
    (config.stellar as any).settlementVaultContractId = validContractId;
    (config.stellar as any).usdcContractId = validUsdcContract;
    (config.treasury as any).emergencyGlobalPause = false;
    (config.treasury as any).maxSingleSettlementUsdc = 10000;
    (config.treasury as any).maxHourlyOutflowUsdc = 50000;
    (config.treasury as any).maxDailyOutflowUsdc = 200000;
    (config.treasury as any).minSettlementUsdc = 1;

    // Seed test database state
    testUser = await prisma.user.create({
      data: {
        email: `policy_user_${Date.now()}_${Math.random().toString(36).substring(2, 6)}@luminarail.com`,
        passwordHash: 'hashed_password',
      },
    });

    const quote = await prisma.quote.create({
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
        quoteId: quote.id,
        status: OrderStatus.SETTLEMENT_PENDING,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: new Prisma.Decimal('150000.0000'),
        destinationAmount: new Prisma.Decimal('100.0000000'),
        walletAddress: validRecipientKey,
      },
    });

    const testAsset = `USDC_POL_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
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

    testPayment = await prisma.payment.create({
      data: {
        orderId: testOrder.id,
        userId: testUser.id,
        provider: 'PAYSTACK',
        type: 'DEPOSIT',
        amount: new Prisma.Decimal('150000.0000'),
        currency: 'NGN',
        status: PaymentStatus.SUCCEEDED,
        reference: `PAY_POLICY_${Date.now()}`,
      },
    });

    testSettlement = await prisma.settlement.create({
      data: {
        settlementId: `STL_${Date.now()}_test`,
        orderId: testOrder.id,
        userId: testUser.id,
        status: SettlementStatus.PENDING,
        asset: 'USDC',
        amount: new Prisma.Decimal('100.0000000'),
        source: signerPublicKey,
        destination: validRecipientKey,
        contractAddress: validContractId,
      },
    });
  });

  afterEach(async () => {
    await prisma.treasuryTransaction.deleteMany({ where: { poolId: testPool?.id } });
    await prisma.settlement.deleteMany({ where: { userId: testUser?.id } });
    await prisma.payment.deleteMany({ where: { userId: testUser?.id } });
    await prisma.liquidityReservation.deleteMany({ where: { orderId: testOrder?.id } });
    await prisma.liquidityPool.deleteMany({ where: { id: testPool?.id } });
    await prisma.order.deleteMany({ where: { userId: testUser?.id } });
    await prisma.user.deleteMany({ where: { id: testUser?.id } });
  });

  function buildTestXdr(overrides: Partial<{
    settlementId: string;
    source: string;
    destination: string;
    asset: string;
    amount: string;
    contractId: string;
    functionName: string;
    passphrase: string;
  }> = {}): string {
    const account = new Account(overrides.source || signerPublicKey, '100');
    const contract = new Contract(overrides.contractId || validContractId);
    const setlId = parseSettlementIdToU64(overrides.settlementId || testSettlement.settlementId);
    const stroops = parseAmountToStroops(overrides.amount || '100.0000000');

    const tx = new TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: overrides.passphrase || stellarConfig.passphrase,
    })
      .addOperation(
        contract.call(
          overrides.functionName || 'create_settlement',
          nativeToScVal(setlId, { type: 'u64' }),
          nativeToScVal(new Address(overrides.source || signerPublicKey)),
          nativeToScVal(new Address(overrides.destination || validRecipientKey)),
          nativeToScVal(new Address(overrides.asset || validUsdcContract)),
          nativeToScVal(stroops, { type: 'i128' })
        )
      )
      .setTimeout(30)
      .build();

    return tx.toXDR();
  }

  function buildValidRequest(overrides: Partial<SignTransactionRequest['context']> = {}, xdrOverrides = {}): SignTransactionRequest {
    return {
      unsignedTransactionXdr: buildTestXdr(xdrOverrides),
      context: {
        settlementId: testSettlement.settlementId,
        orderId: testOrder.id,
        expectedSource: signerPublicKey,
        expectedDestination: validRecipientKey,
        expectedAmountStroops: parseAmountToStroops('100.0000000'),
        expectedAssetContract: validUsdcContract,
        expectedVaultContract: validContractId,
        ...overrides,
      },
    };
  }

  it('1. Approves valid transaction matching DB state & parameters', async () => {
    const request = buildValidRequest();
    await expect(policyEngine.validateAndApprove(request)).resolves.not.toThrow();
  });

  it('2. Rejects transaction when EMERGENCY_GLOBAL_PAUSE is active', async () => {
    (config.treasury as any).emergencyGlobalPause = true;
    const request = buildValidRequest();
    await expect(policyEngine.validateAndApprove(request)).rejects.toThrow('Emergency global settlement pause is active');
  });

  it('3. Rejects transaction when target contract ID is unapproved', async () => {
    const badContract = Address.contract(Buffer.alloc(32, 9)).toString();
    const request = buildValidRequest({ expectedVaultContract: validContractId }, { contractId: badContract });
    await expect(policyEngine.validateAndApprove(request)).rejects.toThrow('does not match approved vault contract');
  });

  it('4. Rejects transaction when function name is not create_settlement', async () => {
    const request = buildValidRequest({}, { functionName: 'drain_vault' });
    await expect(policyEngine.validateAndApprove(request)).rejects.toThrow('not authorized');
  });

  it('5. Rejects transaction when destination does not match Order.walletAddress', async () => {
    const attackerKey = Keypair.random().publicKey();
    const request = buildValidRequest({}, { destination: attackerKey });
    await expect(policyEngine.validateAndApprove(request)).rejects.toThrow('destination address does not match order recipient');
  });

  it('6. Rejects transaction when amount in XDR differs from Order.destinationAmount', async () => {
    const request = buildValidRequest({}, { amount: '1000.0000000' });
    await expect(policyEngine.validateAndApprove(request)).rejects.toThrow('does not match authoritative order destination amount');
  });

  it('7. Rejects transaction when Order.status is not SETTLEMENT_PENDING', async () => {
    await prisma.order.update({
      where: { id: testOrder.id },
      data: { status: OrderStatus.COMPLETED },
    });
    const request = buildValidRequest();
    await expect(policyEngine.validateAndApprove(request)).rejects.toThrow('Order state must be SETTLEMENT_PENDING');
  });

  it('8. Rejects transaction when Payment.status is not SUCCEEDED', async () => {
    await prisma.payment.update({
      where: { id: testPayment.id },
      data: { status: PaymentStatus.FAILED },
    });
    const request = buildValidRequest();
    await expect(policyEngine.validateAndApprove(request)).rejects.toThrow('confirmed succeeded payment');
  });

  it('9. Rejects transaction when LiquidityReservation is in RESERVED state (must be CONFIRMED)', async () => {
    await prisma.liquidityReservation.update({
      where: { id: testReservation.id },
      data: { status: LiquidityReservationStatus.RESERVED },
    });
    const request = buildValidRequest();
    await expect(policyEngine.validateAndApprove(request)).rejects.toThrow('confirmed liquidity reservation');
  });

  it('10. Rejects transaction when Settlement is already COMPLETED', async () => {
    await prisma.settlement.update({
      where: { id: testSettlement.id },
      data: { status: SettlementStatus.COMPLETED },
    });
    const request = buildValidRequest();
    await expect(policyEngine.validateAndApprove(request)).rejects.toThrow('Settlement has already completed');
  });

  it('11. Rejects transaction when single settlement exceeds MAX_SINGLE_SETTLEMENT_USDC', async () => {
    (config.treasury as any).maxSingleSettlementUsdc = 50; // set cap lower than 100 USDC order
    const request = buildValidRequest();
    await expect(policyEngine.validateAndApprove(request)).rejects.toThrow('exceeds maximum single transaction limit');
  });

  it('12. Rejects transaction when amount is below MIN_SETTLEMENT_USDC', async () => {
    (config.treasury as any).minSettlementUsdc = 500;
    const request = buildValidRequest();
    await expect(policyEngine.validateAndApprove(request)).rejects.toThrow('below configured minimum');
  });

  it('13. Rejects transaction when hourly outflow limit is exceeded', async () => {
    await prisma.treasuryTransaction.create({
      data: {
        poolId: testPool.id,
        type: 'SETTLEMENT_PAYOUT',
        amount: new Prisma.Decimal('49950.0000000'),
        createdAt: new Date(),
      },
    });

    (config.treasury as any).maxHourlyOutflowUsdc = 50000;
    const request = buildValidRequest();
    await expect(policyEngine.validateAndApprove(request)).rejects.toThrow('exceed 1-hour cumulative outflow limit');
  });

  it('14. Rejects transaction when daily outflow limit is exceeded', async () => {
    await prisma.treasuryTransaction.create({
      data: {
        poolId: testPool.id,
        type: 'SETTLEMENT_PAYOUT',
        amount: new Prisma.Decimal('199950.0000000'),
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
      },
    });

    (config.treasury as any).maxDailyOutflowUsdc = 200000;
    const request = buildValidRequest();
    await expect(policyEngine.validateAndApprove(request)).rejects.toThrow('exceed 24-hour cumulative outflow limit');
  });

  it('15. Rejects stale settlement older than 24 hours', async () => {
    await prisma.settlement.update({
      where: { id: testSettlement.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }, // 25 hours ago
    });
    const request = buildValidRequest();
    await expect(policyEngine.validateAndApprove(request)).rejects.toThrow('stale (> 24 hours)');
  });

  it('16. Rejects malformed XDR string', async () => {
    const request = {
      unsignedTransactionXdr: 'INVALID_BASE64_XDR_STRING',
      context: buildValidRequest().context,
    };
    await expect(policyEngine.validateAndApprove(request)).rejects.toThrow('Malformed transaction XDR envelope');
  });
});

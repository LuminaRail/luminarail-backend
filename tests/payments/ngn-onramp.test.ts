import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { OrderStatus, PaymentStatus, SettlementStatus, Role } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { QuoteService } from '../../src/modules/quotes/quotes.service.js';
import { MockQuoteProvider } from '../../src/modules/quotes/providers/mock-quote.provider.js';
import { NgnPaymentProvider } from '../../src/modules/providers/ngn.provider.js';
import { SettlementWorker } from '../../src/workers/settlement.worker.js';
import { MockSettlementExecutor } from '../../src/stellar/settlement.executor.js';
import { Keypair } from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import { config } from '../../src/config/index.js';

const app = createApp();

describe('NGN Fiat On-Ramp Architecture & Payment Rail Integration', () => {
  let userToken: string;
  let userId: string;
  const testWallet = Keypair.random().publicKey();

  beforeEach(async () => {
    QuoteService.setProvider(new MockQuoteProvider());
    await prisma.transaction.deleteMany();
    await prisma.settlement.deleteMany();
    await prisma.providerTransaction.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.order.deleteMany();
    await prisma.quote.deleteMany();
    await prisma.webhookEvent.deleteMany();
    await prisma.user.deleteMany();
    NgnPaymentProvider.clearStore();

    const user = await prisma.user.create({
      data: {
        email: `ngn_test_${Date.now()}@example.com`,
        passwordHash: '$2a$10$abcdefghijklmnopqrstuv',
        role: Role.USER,
        status: 'ACTIVE',
      },
    });

    userId = user.id;
    userToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role, status: user.status },
      config.jwt.secret
    );
  });

  afterEach(async () => {
    NgnPaymentProvider.clearStore();
  });

  it('executes full NGN on-ramp flow from quote to verified payment and Soroban USDC settlement', { timeout: 15000 }, async () => {
    // Step 1: Create Quote
    const quoteRes = await request(app)
      .post('/api/v1/quotes')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        amount: 150000,
      });

    expect(quoteRes.status).toBe(201);
    const quoteId = quoteRes.body.data.id;

    // Step 2: Create Order (Status: CREATED)
    const orderRes = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        quoteId,
        type: 'ON_RAMP',
        walletAddress: testWallet,
      });

    if (orderRes.status !== 201) {
      console.log('Order creation failed body:', JSON.stringify(orderRes.body));
    }
    expect(orderRes.status).toBe(201);
    const orderId = orderRes.body.data.id;
    expect(orderRes.body.data.status).toBe(OrderStatus.CREATED);

    // Step 3: Verify Settlement CANNOT be triggered prematurely on CREATED order
    const worker = new SettlementWorker(new MockSettlementExecutor());
    await expect(worker.processSingleOrder(orderId)).rejects.toThrow();

    // Step 4: Create NGN Payment (Status: PENDING with Virtual Bank Transfer Instructions)
    const paymentRes = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        orderId,
        currency: 'NGN',
        type: 'DEPOSIT',
        provider: 'NGN_BANK_TRANSFER',
      });

    expect(paymentRes.status).toBe(201);
    const paymentData = paymentRes.body.data;
    expect(paymentData.status).toBe(PaymentStatus.PENDING);
    expect(paymentData.provider).toBe('NGN_BANK_TRANSFER');
    expect(paymentData.reference).toBeDefined();
    expect(paymentData.instructions).toBeDefined();
    expect(paymentData.instructions.bankName).toContain('Providus Bank');
    expect(paymentData.instructions.accountNumber).toBeDefined();
    expect(paymentData.instructions.accountName).toBe('LuminaRail On-Ramp Vault');

    // Confirm Order transitioned to AWAITING_PAYMENT
    const awaitingOrder = await prisma.order.findUnique({ where: { id: orderId } });
    expect(awaitingOrder?.status).toBe(OrderStatus.AWAITING_PAYMENT);

    // Step 5: Verify Payment via Provider Confirmation
    const verifyRes = await request(app)
      .post(`/api/v1/payments/${paymentData.paymentId}/verify`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ simulateSuccess: true });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.status).toBe(PaymentStatus.SUCCEEDED);

    // Confirm Order transitioned to SETTLEMENT_PENDING
    const pendingOrder = await prisma.order.findUnique({ where: { id: orderId } });
    expect(pendingOrder?.status).toBe(OrderStatus.SETTLEMENT_PENDING);

    // Step 6: Trigger Settlement Worker and Confirm Soroban USDC Settlement Completion
    const settlementResult = await worker.processSingleOrder(orderId);
    expect(settlementResult.status).toBe(SettlementStatus.COMPLETED);

    const completedOrder = await prisma.order.findUnique({ where: { id: orderId } });
    expect(completedOrder?.status).toBe(OrderStatus.COMPLETED);
  });

  it('enforces wallet association gate: requires Stellar wallet before settlement transition', { timeout: 15000 }, async () => {
    // 1. Create Quote
    const quoteRes = await request(app)
      .post('/api/v1/quotes')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        amount: 100000,
      });

    const quoteId = quoteRes.body.data.id;

    // 2. Create Order WITHOUT Wallet Address
    const orderRes = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        quoteId,
        type: 'ON_RAMP',
      });

    const orderId = orderRes.body.data.id;

    // 3. Create NGN Payment
    const paymentRes = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        orderId,
        currency: 'NGN',
        provider: 'NGN_BANK_TRANSFER',
      });

    const paymentId = paymentRes.body.data.paymentId;

    // 4. Verify Payment -> Status becomes SUCCEEDED, but Order becomes PAYMENT_CONFIRMED (not SETTLEMENT_PENDING)
    await request(app)
      .post(`/api/v1/payments/${paymentId}/verify`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ simulateSuccess: true });

    const confirmedOrder = await prisma.order.findUnique({ where: { id: orderId } });
    expect(confirmedOrder?.status).toBe(OrderStatus.PAYMENT_CONFIRMED);

    // 5. Attach Stellar Wallet to Order -> Order transitions to SETTLEMENT_PENDING
    const walletRes = await request(app)
      .patch(`/api/v1/orders/${orderId}/wallet`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ walletAddress: testWallet });

    expect(walletRes.status).toBe(200);
    expect(walletRes.body.data.status).toBe(OrderStatus.SETTLEMENT_PENDING);

    // 6. Execute Settlement
    const worker = new SettlementWorker(new MockSettlementExecutor());
    const settlementResult = await worker.processSingleOrder(orderId);
    expect(settlementResult.status).toBe(SettlementStatus.COMPLETED);
  });

  it('processes signed NGN webhooks and handles duplicate webhook idempotency cleanly', { timeout: 15000 }, async () => {
    // 1. Create Quote & Order & Payment
    const quoteRes = await request(app)
      .post('/api/v1/quotes')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ sourceCurrency: 'NGN', destinationAsset: 'USDC', amount: 50000 });

    const orderRes = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ quoteId: quoteRes.body.data.id, walletAddress: testWallet });

    const orderId = orderRes.body.data.id;

    const paymentRes = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ orderId, currency: 'NGN', provider: 'NGN_BANK_TRANSFER' });

    const providerPaymentId = paymentRes.body.data.providerPaymentId;

    // 2. Deliver Valid Signed Webhook
    const webhookPayload = {
      event_id: `evt_ngn_${Date.now()}`,
      event_type: 'charge.success',
      data: {
        provider_payment_id: providerPaymentId,
        status: 'SUCCESSFUL',
      },
    };

    const webhookRes = await request(app)
      .post('/api/v1/webhooks/NGN_BANK_TRANSFER')
      .set('x-ngn-signature', 'ngn_valid_signature')
      .send(webhookPayload);

    expect(webhookRes.status).toBe(200);
    expect(webhookRes.body.success).toBe(true);
    expect(webhookRes.body.duplicate).toBe(false);

    // Confirm Payment & Order status
    const updatedPayment = await prisma.payment.findFirst({ where: { orderId } });
    expect(updatedPayment?.status).toBe(PaymentStatus.SUCCEEDED);

    const updatedOrder = await prisma.order.findUnique({ where: { id: orderId } });
    expect(updatedOrder?.status).toBe(OrderStatus.SETTLEMENT_PENDING);

    // 3. Re-play Same Webhook Event -> Idempotent duplicate response
    const dupRes = await request(app)
      .post('/api/v1/webhooks/NGN_BANK_TRANSFER')
      .set('x-ngn-signature', 'ngn_valid_signature')
      .send(webhookPayload);

    expect(dupRes.status).toBe(200);
    expect(dupRes.body.duplicate).toBe(true);
  });
});

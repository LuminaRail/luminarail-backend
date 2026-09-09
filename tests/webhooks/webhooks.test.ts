import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { QuoteService } from '../../src/modules/quotes/quotes.service.js';
import { MockQuoteProvider } from '../../src/modules/quotes/providers/mock-quote.provider.js';
import { Keypair } from '@stellar/stellar-sdk';
import { OrderStatus } from '@prisma/client';

import { config } from '../../src/config/index.js';
import { PaystackClient } from '../../src/services/paystack.client.js';

describe('Webhooks API & Signature Verification', () => {
  const app = createApp();
  const userEmail = `test_wh_${Date.now()}@example.com`;
  const paystackSecret = 'test_paystack_secret_key_123';

  let userToken = '';
  let orderId = '';
  let paymentId = '';
  let providerPaymentId = '';
  let paystackOrderId = '';
  let paystackPaymentId = '';
  let paystackReference = '';

  const eventId = `evt_wh_${Date.now()}`;
  const validWallet = Keypair.random().publicKey();

  beforeAll(async () => {
    process.env.PAYSTACK_SECRET_KEY = paystackSecret;
    config.paystack.secretKey = paystackSecret;
    vi.spyOn(PaystackClient.prototype, 'initializeTransaction').mockImplementation(async (input) => ({
      authorizationUrl: 'https://checkout.paystack.com/test',
      accessCode: 'test_access',
      reference: input.reference,
    }));
    QuoteService.setProvider(new MockQuoteProvider());

    const r1 = await request(app).post('/api/v1/auth/register').send({
      email: userEmail,
      password: 'Password123!',
    });
    userToken = r1.body.data.token;

    // Create Order 1 for mock provider webhooks
    const qRes = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 25000,
    });
    const quoteId = qRes.body.data.id;

    const oRes = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        quoteId,
        type: 'ON_RAMP',
        walletAddress: validWallet,
      });

    orderId = oRes.body.data.id;

    const pRes = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ orderId });

    paymentId = pRes.body.data.paymentId;
    providerPaymentId = pRes.body.data.providerPaymentId;

    // Create Order 2 for Paystack provider webhooks
    const qRes2 = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 50000,
    });
    const quoteId2 = qRes2.body.data.id;

    const oRes2 = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        quoteId: quoteId2,
        type: 'ON_RAMP',
        walletAddress: validWallet,
      });

    paystackOrderId = oRes2.body.data.id;

    const pRes2 = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        orderId: paystackOrderId,
        provider: 'PAYSTACK',
      });

    paystackPaymentId = pRes2.body.data.paymentId;
    paystackReference = pRes2.body.data.reference;
  }, 30000);

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { contains: 'test_wh_' } },
    });
    const userIds = users.map((u) => u.id);

    await prisma.webhookEvent.deleteMany({
      where: {
        OR: [
          { eventId: { contains: 'evt_wh_' } },
          { eventId: { contains: 'evt_pstk_' } },
          { provider: 'PAYSTACK_NGN_BANK_TRANSFER' },
        ],
      },
    });

    if (userIds.length > 0) {
      await prisma.providerTransaction.deleteMany({
        where: { payment: { userId: { in: userIds } } },
      });
      await prisma.payment.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.settlement.deleteMany({ where: { order: { userId: { in: userIds } } } });
      await prisma.liquidityReservation.deleteMany({ where: { order: { userId: { in: userIds } } } });
      await prisma.order.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });

  it('POST /api/v1/webhooks/:provider — reject webhook with invalid signature', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/mock')
      .set('x-mock-signature', 'invalid_signature')
      .send({
        eventId,
        event_type: 'payment.updated',
        data: {
          providerPaymentId,
          status: 'SUCCEEDED',
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/v1/webhooks/:provider — process valid webhook event', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/mock')
      .set('x-mock-signature', 'mock_valid_signature')
      .send({
        eventId,
        event_type: 'payment.updated',
        data: {
          providerPaymentId,
          status: 'SUCCEEDED',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.eventId).toBe(eventId);
    expect(res.body.duplicate).toBe(false);

    // Verify order status updated to SETTLEMENT_PENDING
    const oRes = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(oRes.body.data.status).toBe('SETTLEMENT_PENDING');
  });

  it('POST /api/v1/webhooks/:provider — duplicate webhook event is idempotent', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/mock')
      .set('x-mock-signature', 'mock_valid_signature')
      .send({
        eventId,
        event_type: 'payment.updated',
        data: {
          providerPaymentId,
          status: 'SUCCEEDED',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.duplicate).toBe(true);
  });

  it('POST /api/v1/webhooks/:provider — unknown provider returns 404', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks/non_existent_provider')
      .set('x-mock-signature', 'mock_valid_signature')
      .send({ eventId: '123' });

    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // TASK 5: Paystack HTTP Raw-Body Signature, Timing-Safe & Non-Regression Tests
  // ---------------------------------------------------------------------------

  it('TASK 5.1: Paystack HTTP webhook with valid HMAC on raw body is accepted', async () => {
    const rawPayload = JSON.stringify({
      id: 990011,
      event: 'charge.success',
      data: {
        reference: paystackReference,
        status: 'success',
        amount: 5000000,
        paid_at: '2026-09-08T16:00:00.000Z',
      },
    });

    const signature = crypto
      .createHmac('sha512', paystackSecret)
      .update(rawPayload)
      .digest('hex');

    const res = await request(app)
      .post('/api/v1/webhooks/PAYSTACK_NGN_BANK_TRANSFER')
      .set('x-paystack-signature', signature)
      .set('Content-Type', 'application/json')
      .send(rawPayload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.duplicate).toBe(false);

    // Verify Payment status updated to SUCCEEDED
    const dbPayment = await prisma.payment.findUnique({ where: { id: paystackPaymentId } });
    expect(dbPayment?.status).toBe('SUCCEEDED');
  });

  it('TASK 5.2: Paystack HTTP webhook with invalid HMAC signature is rejected with 400', async () => {
    const rawPayload = JSON.stringify({
      id: 990012,
      event: 'charge.success',
      data: {
        reference: paystackReference,
        status: 'success',
      },
    });

    const invalidSignature = 'a'.repeat(128);

    const res = await request(app)
      .post('/api/v1/webhooks/PAYSTACK_NGN_BANK_TRANSFER')
      .set('x-paystack-signature', invalidSignature)
      .set('Content-Type', 'application/json')
      .send(rawPayload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('TASK 5.3: Paystack HTTP webhook with non-standard JSON formatting/whitespace passes verification via rawBody', async () => {
    // Payload with unusual whitespace/indentation that differs from JSON.stringify(req.body)
    const unformattedPayload = `{\n  "id": 990013,\n  "event":   "charge.success",\n  "data": {\n    "reference": "${paystackReference}",\n    "status": "success"\n  }\n}`;

    const unformattedSignature = crypto
      .createHmac('sha512', paystackSecret)
      .update(unformattedPayload)
      .digest('hex');

    const res = await request(app)
      .post('/api/v1/webhooks/PAYSTACK_NGN_BANK_TRANSFER')
      .set('x-paystack-signature', unformattedSignature)
      .set('Content-Type', 'application/json')
      .send(unformattedPayload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('TASK 5.4: Webhook payloads without root id generate deterministic event IDs and deduplicate correctly', async () => {
    const payloadWithoutId = JSON.stringify({
      event: 'charge.success',
      data: {
        reference: paystackReference,
        status: 'success',
        paid_at: '2026-09-08T16:30:00.000Z',
        amount: 5000000,
      },
    });

    const signature = crypto
      .createHmac('sha512', paystackSecret)
      .update(payloadWithoutId)
      .digest('hex');

    // First request should process normally
    const res1 = await request(app)
      .post('/api/v1/webhooks/PAYSTACK_NGN_BANK_TRANSFER')
      .set('x-paystack-signature', signature)
      .set('Content-Type', 'application/json')
      .send(payloadWithoutId);

    expect(res1.status).toBe(200);
    expect(res1.body.success).toBe(true);
    expect(res1.body.duplicate).toBe(false);
    expect(res1.body.eventId).toContain('evt_pstk_');

    // Second identical request must generate the exact same deterministic eventId and return duplicate
    const res2 = await request(app)
      .post('/api/v1/webhooks/PAYSTACK_NGN_BANK_TRANSFER')
      .set('x-paystack-signature', signature)
      .set('Content-Type', 'application/json')
      .send(payloadWithoutId);

    expect(res2.status).toBe(200);
    expect(res2.body.success).toBe(true);
    expect(res2.body.duplicate).toBe(true);
    expect(res2.body.eventId).toBe(res1.body.eventId);
  });

  it('TASK 5.5: Duplicate webhook or re-verification does NOT regress COMPLETED order status', async () => {
    // Manually advance order status to COMPLETED
    await prisma.order.update({
      where: { id: paystackOrderId },
      data: { status: OrderStatus.COMPLETED },
    });

    const rawPayload = JSON.stringify({
      id: 990015,
      event: 'charge.success',
      data: {
        reference: paystackReference,
        status: 'success',
      },
    });

    const signature = crypto
      .createHmac('sha512', paystackSecret)
      .update(rawPayload)
      .digest('hex');

    // Process duplicate webhook
    const webhookRes = await request(app)
      .post('/api/v1/webhooks/PAYSTACK_NGN_BANK_TRANSFER')
      .set('x-paystack-signature', signature)
      .set('Content-Type', 'application/json')
      .send(rawPayload);

    expect(webhookRes.status).toBe(200);

    // Verify order status remains COMPLETED
    const completedOrder = await prisma.order.findUnique({ where: { id: paystackOrderId } });
    expect(completedOrder?.status).toBe(OrderStatus.COMPLETED);

    // Perform manual payment re-verification on mock payment (Order 1)
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.COMPLETED },
    });

    const verifyRes = await request(app)
      .post(`/api/v1/payments/${paymentId}/verify`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({});

    expect(verifyRes.status).toBe(200);

    // Verify order status STILL remains COMPLETED
    const reVerifiedOrder = await prisma.order.findUnique({ where: { id: orderId } });
    expect(reVerifiedOrder?.status).toBe(OrderStatus.COMPLETED);
  });
});


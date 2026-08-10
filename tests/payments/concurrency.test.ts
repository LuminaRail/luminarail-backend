import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { MockPaymentProvider } from '../../src/modules/providers/mock.provider.js';

describe('Payment & Webhook Hardening (Security, Concurrency & Idempotency)', () => {
  const app = createApp();
  const user1Email = `hardened_user1_${Date.now()}@example.com`;
  const user2Email = `hardened_user2_${Date.now()}@example.com`;

  let token1 = '';
  let token2 = '';
  let order1Id = '';
  let order2Id = '';
  const sharedKey = `idemp_shared_${Date.now()}`;

  beforeAll(async () => {
    MockPaymentProvider.clearMockStore();

    const r1 = await request(app).post('/api/v1/auth/register').send({
      email: user1Email,
      password: 'Password123!',
    });
    token1 = r1.body.data.token;

    const r2 = await request(app).post('/api/v1/auth/register').send({
      email: user2Email,
      password: 'Password123!',
    });
    token2 = r2.body.data.token;

    // Create quotes & orders for user1 and user2
    const q1 = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 10000,
    });
    const o1 = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token1}`)
      .send({ quoteId: q1.body.data.id });
    order1Id = o1.body.data.id;

    const q2 = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 20000,
    });
    const o2 = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token2}`)
      .send({ quoteId: q2.body.data.id });
    order2Id = o2.body.data.id;
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: 'hardened_user1_' } },
          { email: { contains: 'hardened_user2_' } },
        ],
      },
    });
    const userIds = users.map((u) => u.id);

    await prisma.webhookEvent.deleteMany({
      where: { eventId: { contains: 'evt_conc_' } },
    });

    if (userIds.length > 0) {
      await prisma.providerTransaction.deleteMany({
        where: { payment: { userId: { in: userIds } } },
      });
      await prisma.payment.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.settlement.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.order.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });

  it('1. Order Ownership Validation — User2 cannot create payment for User1 order', async () => {
    const res = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token2}`)
      .send({ orderId: order1Id });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('2. Idempotency Security — User1 creates payment with sharedKey', async () => {
    const res = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token1}`)
      .set('Idempotency-Key', sharedKey)
      .send({ orderId: order1Id });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.idempotencyKey).toBe(sharedKey);
  });

  it('3. Idempotency Security — User2 reusing sharedKey for order2 is rejected (409 Conflict)', async () => {
    const res = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token2}`)
      .set('Idempotency-Key', sharedKey)
      .send({ orderId: order2Id });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it('4. Payment Concurrency — Concurrent payment requests with same key produce 1 payment', async () => {
    const concKey = `conc_key_${Date.now()}`;

    // Create a new order for concurrency test
    const q = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 50000,
    });
    const o = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token1}`)
      .send({ quoteId: q.body.data.id });
    const concOrderId = o.body.data.id;

    const reqs = Array.from({ length: 5 }).map(() =>
      request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${token1}`)
        .set('Idempotency-Key', concKey)
        .send({ orderId: concOrderId })
    );

    const responses = await Promise.all(reqs);

    const successful = responses.filter((r) => r.status === 201 || r.status === 200);
    expect(successful.length).toBe(5);

    const paymentIds = new Set(successful.map((r) => r.body.data.paymentId));
    expect(paymentIds.size).toBe(1);
  });

  it('5. Webhook Concurrency — Concurrent webhook deliveries process event exactly once', async () => {
    // First create a payment to send webhooks for
    const q = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 12000,
    });
    const o = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token1}`)
      .send({ quoteId: q.body.data.id });
    const pRes = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token1}`)
      .send({ orderId: o.body.data.id });

    const providerPaymentId = pRes.body.data.providerPaymentId;
    const concEvtId = `evt_conc_${Date.now()}`;

    const webhookReqs = Array.from({ length: 5 }).map(() =>
      request(app)
        .post('/api/v1/webhooks/mock')
        .set('x-mock-signature', 'mock_valid_signature')
        .send({
          eventId: concEvtId,
          event_type: 'payment.updated',
          data: {
            providerPaymentId,
            status: 'SUCCEEDED',
          },
        })
    );

    const responses = await Promise.all(webhookReqs);
    const okResponses = responses.filter((r) => r.status === 200);
    expect(okResponses.length).toBe(5);

    const processedResp = okResponses.find((r) => r.body.duplicate === false);
    const duplicateResps = okResponses.filter((r) => r.body.duplicate === true);

    expect(processedResp).toBeDefined();
    expect(duplicateResps.length).toBe(4);
  });

  it('6. Mock Provider Preserved Amount — preserves exact created amount & currency', async () => {
    const provider = new MockPaymentProvider();
    const mockRef = `mock_ref_${Date.now()}`;
    const p = await provider.createPayment({
      orderId: '00000000-0000-0000-0000-000000000000',
      userId: '00000000-0000-0000-0000-000000000000',
      amount: '9876.5432',
      currency: 'NGN',
      type: 'DEPOSIT' as any,
      reference: mockRef,
    });

    const status = await provider.getPaymentStatus(p.providerPaymentId);
    expect(status.amount).toBe('9876.5432');
    expect(status.currency).toBe('NGN');

    const verified = await provider.verifyPayment(p.providerPaymentId);
    expect(verified.amount).toBe('9876.5432');
    expect(verified.currency).toBe('NGN');
  });

  it('7. Terminal State Lock — SUCCEEDED payment cannot transition to FAILED', async () => {
    const q = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 8000,
    });
    const o = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token1}`)
      .send({ quoteId: q.body.data.id });
    const pRes = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${token1}`)
      .send({ orderId: o.body.data.id });

    const payId = pRes.body.data.paymentId;

    // Verify to SUCCEEDED
    await request(app)
      .post(`/api/v1/payments/${payId}/verify`)
      .set('Authorization', `Bearer ${token1}`)
      .send({});

    // Update providerPaymentId in DB to mock_pay_fail_123 so provider returns FAILED
    await prisma.payment.update({
      where: { id: payId },
      data: { providerPaymentId: 'mock_pay_fail_123' },
    });

    // Attempt second verify which returns FAILED
    const secondVerify = await request(app)
      .post(`/api/v1/payments/${payId}/verify`)
      .set('Authorization', `Bearer ${token1}`)
      .send({});

    expect(secondVerify.status).toBe(400);
    expect(secondVerify.body.error.message).toContain('Invalid payment state transition');
  });
});

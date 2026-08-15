import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { QuoteService } from '../../src/modules/quotes/quotes.service.js';
import { MockQuoteProvider } from '../../src/modules/quotes/providers/mock-quote.provider.js';

describe('Payments API Endpoints & Lifecycle', () => {
  const app = createApp();
  const userEmail = `test_pay_${Date.now()}@example.com`;
  const otherUserEmail = `test_other_pay_${Date.now()}@example.com`;

  let userToken = '';
  let otherUserToken = '';
  let orderId = '';
  let paymentId = '';
  const idempotencyKey = `pay_idemp_${Date.now()}`;

  beforeAll(async () => {
  QuoteService.setProvider(new MockQuoteProvider());  

    const r1 = await request(app).post('/api/v1/auth/register').send({
      email: userEmail,
      password: 'Password123!',
    });
    userToken = r1.body.data.token;

    const r2 = await request(app).post('/api/v1/auth/register').send({
      email: otherUserEmail,
      password: 'Password123!',
    });
    otherUserToken = r2.body.data.token;

    // Create quote & order
    const qRes = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });
    const quoteId = qRes.body.data.id;

    const oRes = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        quoteId,
        type: 'ON_RAMP',
        walletAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      });

    orderId = oRes.body.data.id;
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: 'test_pay_' } },
          { email: { contains: 'test_other_pay_' } },
        ],
      },
    });
    const userIds = users.map((u) => u.id);

    if (userIds.length > 0) {
      await prisma.providerTransaction.deleteMany({
        where: { payment: { userId: { in: userIds } } },
      });
      await prisma.payment.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.settlement.deleteMany({ where: { order: { userId: { in: userIds } } } });
      await prisma.order.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });

  it('POST /api/v1/payments — successful payment creation', async () => {
    const res = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        orderId,
        currency: 'NGN',
        type: 'DEPOSIT',
        amount: '1.00', // Client attempt to pass lower amount is ignored
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.paymentId).toBeDefined();
    paymentId = res.body.data.paymentId;

    expect(res.body.data.orderId).toBe(orderId);
    expect(res.body.data.provider).toBe('MOCK');
    expect(res.body.data.status).toBe('PENDING');
    // Amount must come from Order (15000), not client input 1.00
    expect(parseFloat(res.body.data.amount)).toBe(15000);
    expect(res.body.data.idempotencyKey).toBe(idempotencyKey);
  });

  it('POST /api/v1/payments — idempotency check returns existing payment', async () => {
    const res = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        orderId,
        currency: 'NGN',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.paymentId).toBe(paymentId);
  });

  it('GET /api/v1/payments/:id — retrieve payment by ID', async () => {
    const res = await request(app)
      .get(`/api/v1/payments/${paymentId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.paymentId).toBe(paymentId);
  });

  it('GET /api/v1/payments/:id — forbidden for unauthorized user', async () => {
    const res = await request(app)
      .get(`/api/v1/payments/${paymentId}`)
      .set('Authorization', `Bearer ${otherUserToken}`);

    expect(res.status).toBe(403);
  });

  it('POST /api/v1/payments/:id/verify — verify payment status transition', async () => {
    const res = await request(app)
      .post(`/api/v1/payments/${paymentId}/verify`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('SUCCEEDED');

    // Verify order status updated to SETTLEMENT_PENDING (stopping at settlement!)
    const oRes = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(oRes.body.data.status).toBe('SETTLEMENT_PENDING');
  });
});

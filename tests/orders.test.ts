import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { QuoteService } from '../src/modules/quotes/quotes.service.js';
import { MockQuoteProvider } from '../src/modules/quotes/providers/mock-quote.provider.js';

describe('Orders & Idempotency API Endpoints', () => {
  const app = createApp();
  const userEmail = `test_order_${Date.now()}@example.com`;
  const otherUserEmail = `test_other_order_${Date.now()}@example.com`;

  let userToken = '';
  let otherUserToken = '';
  let quoteId = '';
  let orderId = '';
  const idempotencyKey = `idemp_${Date.now()}_abc123`;

  beforeAll(async () => {
    const res1 = await request(app).post('/api/v1/auth/register').send({
      email: userEmail,
      password: 'Password123!',
    });
    userToken = res1.body.data.token;

    const res2 = await request(app).post('/api/v1/auth/register').send({
      email: otherUserEmail,
      password: 'Password123!',
    });
    otherUserToken = res2.body.data.token;
    QuoteService.setProvider(new MockQuoteProvider());
    const qRes = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 30000,
    });
    quoteId = qRes.body.data.id;
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: 'test_order_' } },
          { email: { contains: 'test_other_order_' } },
        ],
      },
    });
    const userIds = users.map((u) => u.id);

    if (userIds.length > 0) {
      await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.order.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });

  it('POST /api/v1/orders — successful order creation with quote and idempotency key', async () => {
    const res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        quoteId,
        type: 'ON_RAMP',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('CREATED');
    expect(res.body.data.idempotencyKey).toBe(idempotencyKey);
    orderId = res.body.data.id;
  });

  it('POST /api/v1/orders — idempotent request returns original order', async () => {
    const res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        quoteId,
        type: 'ON_RAMP',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(orderId);
  });

  it('POST /api/v1/orders — attempting to reuse quote for a new order fails', async () => {
    const res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        quoteId,
        type: 'ON_RAMP',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toContain('already been used');
  });

  it('GET /api/v1/orders — list user orders', async () => {
    const res = await request(app)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.orders.length).toBeGreaterThan(0);
  });

  it('GET /api/v1/orders/:id — retrieve specific order by ID', async () => {
    const res = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(orderId);
  });

  it('GET /api/v1/orders/:id — unauthorized order access rejection', async () => {
    const res = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${otherUserToken}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});

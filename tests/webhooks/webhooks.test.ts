import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';

describe('Webhooks API & Signature Verification', () => {
  const app = createApp();
  const userEmail = `test_wh_${Date.now()}@example.com`;

  let userToken = '';
  let orderId = '';
  let paymentId = '';
  let providerPaymentId = '';
  const eventId = `evt_wh_${Date.now()}`;

  beforeAll(async () => {
    const r1 = await request(app).post('/api/v1/auth/register').send({
      email: userEmail,
      password: 'Password123!',
    });
    userToken = r1.body.data.token;

    const qRes = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 25000,
    });
    const quoteId = qRes.body.data.id;

    const oRes = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ quoteId, type: 'ON_RAMP' });

    orderId = oRes.body.data.id;

    const pRes = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ orderId });

    paymentId = pRes.body.data.paymentId;
    providerPaymentId = pRes.body.data.providerPaymentId;
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { contains: 'test_wh_' } },
    });
    const userIds = users.map((u) => u.id);

    await prisma.webhookEvent.deleteMany({
      where: { eventId: { contains: 'evt_wh_' } },
    });

    if (userIds.length > 0) {
      await prisma.providerTransaction.deleteMany({
        where: { payment: { userId: { in: userIds } } },
      });
      await prisma.payment.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } });
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
});

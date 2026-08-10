import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { OrderStatus } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { SettlementService } from '../../src/modules/settlements/settlements.service.js';

describe('Settlement API Endpoints', () => {
  const app = createApp();

  const userEmail = `test_settle_api_${Date.now()}@example.com`;
  const otherUserEmail = `test_settle_other_${Date.now()}@example.com`;
  const adminEmail = `test_settle_admin_${Date.now()}@example.com`;

  let userToken = '';
  let userId = '';
  let otherUserToken = '';
  let adminToken = '';
  let orderId = '';
  let settlementId = '';

  beforeAll(async () => {
    // 1. Register User 1
    const res1 = await request(app).post('/api/v1/auth/register').send({
      email: userEmail,
      password: 'Password123!',
    });
    userToken = res1.body.data.token;
    userId = res1.body.data.user.id;

    // 2. Register User 2
    const res2 = await request(app).post('/api/v1/auth/register').send({
      email: otherUserEmail,
      password: 'Password123!',
    });
    otherUserToken = res2.body.data.token;

    // 3. Register Admin User
    const res3 = await request(app).post('/api/v1/auth/register').send({
      email: adminEmail,
      password: 'Password123!',
    });
    adminToken = res3.body.data.token;
    const adminId = res3.body.data.user.id;

    // Promote admin user to ADMIN role and re-authenticate to update JWT token payload
    await prisma.user.update({
      where: { id: adminId },
      data: { role: 'ADMIN' },
    });

    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email: adminEmail,
      password: 'Password123!',
    });
    adminToken = loginRes.body.data.token;

    // Create quote & SETTLEMENT_PENDING order for User 1
    const quote = await prisma.quote.create({
      data: {
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 15000,
        destinationAmount: 10,
        exchangeRate: 1500,
        fee: 0,
        expiresAt: new Date(Date.now() + 600000),
      },
    });

    const order = await prisma.order.create({
      data: {
        userId,
        quoteId: quote.id,
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        sourceAmount: 15000,
        destinationAmount: 10,
        walletAddress: 'GSETTLEMENT_API_WALLET_ADDRESS',
        status: OrderStatus.SETTLEMENT_PENDING,
      },
    });
    orderId = order.id;

    const { settlement } = await SettlementService.createSettlementForOrder(orderId, userId);
    settlementId = settlement.id;
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: 'test_settle_api_' } },
          { email: { contains: 'test_settle_other_' } },
          { email: { contains: 'test_settle_admin_' } },
        ],
      },
    });
    const userIds = users.map((u) => u.id);

    if (userIds.length > 0) {
      await prisma.settlement.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.order.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });

  it('GET /api/v1/settlements/:id — user can retrieve own settlement', async () => {
    const res = await request(app)
      .get(`/api/v1/settlements/${settlementId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(settlementId);
    expect(res.body.data.orderId).toBe(orderId);
  });

  it('GET /api/v1/settlements/:id — admin can retrieve any settlement', async () => {
    const res = await request(app)
      .get(`/api/v1/settlements/${settlementId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(settlementId);
  });

  it('GET /api/v1/settlements/:id — unauthorized user access is rejected with 403', async () => {
    const res = await request(app)
      .get(`/api/v1/settlements/${settlementId}`)
      .set('Authorization', `Bearer ${otherUserToken}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/v1/settlements/:id — non-existent settlement returns 404', async () => {
    const fakeUuid = '00000000-0000-0000-0000-000000000000';
    const res = await request(app)
      .get(`/api/v1/settlements/${fakeUuid}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/v1/settlements/order/:orderId — retrieve settlement by order ID', async () => {
    const res = await request(app)
      .get(`/api/v1/settlements/order/${orderId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.orderId).toBe(orderId);
  });

  it('GET /api/v1/settlements — admin can list pending settlements', async () => {
    const res = await request(app)
      .get('/api/v1/settlements')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /api/v1/settlements — regular user is forbidden from listing settlements (403)', async () => {
    const res = await request(app)
      .get('/api/v1/settlements')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });
});

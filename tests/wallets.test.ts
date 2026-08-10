import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';

describe('Stellar Wallets API Endpoints', () => {
  const app = createApp();
  const userEmail = `test_wallet_${Date.now()}@example.com`;
  let userToken = '';
  let walletId = '';
  const validStellarAddress = Keypair.random().publicKey();

  beforeAll(async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: userEmail,
      password: 'Password123!',
    });
    userToken = res.body.data.token;
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { contains: 'test_wallet_' } },
    });
    const userIds = users.map((u) => u.id);
    if (userIds.length > 0) {
      await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });

  it('POST /api/v1/wallets — authenticated wallet creation with valid address', async () => {
    const res = await request(app)
      .post('/api/v1/wallets')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        address: validStellarAddress,
        label: 'My Testnet Wallet',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.address).toBe(validStellarAddress);
    expect(res.body.data.network).toBe('testnet');
    walletId = res.body.data.id;
  });

  it('POST /api/v1/wallets — invalid Stellar address rejection', async () => {
    const res = await request(app)
      .post('/api/v1/wallets')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        address: 'INVALID_STELLAR_ADDRESS_123',
        label: 'Bad Wallet',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/v1/wallets — unauthenticated access rejection', async () => {
    const res = await request(app).post('/api/v1/wallets').send({
      address: validStellarAddress,
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/v1/wallets — list user wallets', async () => {
    const res = await request(app)
      .get('/api/v1/wallets')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('DELETE /api/v1/wallets/:id — delete owned wallet', async () => {
    const res = await request(app)
      .delete(`/api/v1/wallets/${walletId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.deleted).toBe(true);
  });
});

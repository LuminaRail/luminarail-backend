import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';
import { config } from '../src/config/index.js';

describe('Authentication & User Profile Endpoints', () => {
  const app = createApp();
  const testEmail = `test_auth_${Date.now()}@example.com`;
  const testPassword = 'Password123!';
  let authToken = '';

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { contains: 'test_auth_' } },
    });
    const userIds = users.map((u) => u.id);
    if (userIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });

  it('POST /api/v1/auth/register — successful registration', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: testEmail,
      password: testPassword,
      role: 'USER',
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe(testEmail);
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.token).toBeDefined();

    authToken = res.body.data.token;
  });

  it('POST /api/v1/auth/register — duplicate email rejection', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: testEmail,
      password: testPassword,
    });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('POST /api/v1/auth/register — invalid payload validation', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'not-an-email',
      password: 'short',
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/v1/auth/login — successful login', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email: testEmail,
      password: testPassword,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
  });

  it('POST /api/v1/auth/login — invalid credentials rejection', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email: testEmail,
      password: 'WrongPassword!',
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /api/v1/users/me — authenticated current user request', async () => {
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe(testEmail);
  });

  it('GET /api/v1/users/me — unauthenticated request rejection', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects expired JWT authentication tokens', async () => {
    const expiredToken = jwt.sign(
      { id: 'test_user_id', email: testEmail, role: 'USER', status: 'ACTIVE' },
      config.jwt.secret,
      { expiresIn: '-1s' }
    );

    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toContain('expired');
  });

  it('rejects malformed or invalid JWT authentication tokens', async () => {
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', 'Bearer YOUR_TOKEN_HERE');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects protected order endpoints when authentication is missing', async () => {
    const res = await request(app).get('/api/v1/orders');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('accepts newly issued tokens on protected order endpoints', async () => {
    const res = await request(app)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('Quotes API Endpoints', () => {
  const app = createApp();
  let quoteId = '';

  it('POST /api/v1/quotes — successful quote creation', async () => {
    const res = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sourceCurrency).toBe('NGN');
    expect(res.body.data.destinationAsset).toBe('USDC');
    expect(res.body.data.status).toBe('ACTIVE');
    expect(res.body.data.expiresAt).toBeDefined();

    quoteId = res.body.data.id;
  });

  it('GET /api/v1/quotes — quote creation via query parameters', async () => {
    const res = await request(app)
      .get('/api/v1/quotes')
      .query({ sourceCurrency: 'USDC', destinationAsset: 'NGN', amount: '100' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sourceCurrency).toBe('USDC');
  });

  it('GET /api/v1/quotes/:id — retrieve quote details', async () => {
    const res = await request(app).get(`/api/v1/quotes/${quoteId}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(quoteId);
  });

  it('POST /api/v1/quotes — invalid parameters validation', async () => {
    const res = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: -50,
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

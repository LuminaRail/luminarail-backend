import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { QuoteService } from '../src/modules/quotes/quotes.service.js';
import { RealFXQuoteProvider } from '../src/modules/quotes/providers/real-fx-quote.provider.js';
import { MockQuoteProvider } from '../src/modules/quotes/providers/mock-quote.provider.js';

describe('Quotes API Endpoints', () => {
  const app = createApp();
  let quoteId = '';

  beforeEach(() => {
    // Reset to MockQuoteProvider by default for API integration tests
    QuoteService.setProvider(new MockQuoteProvider());
  });

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

  it('POST /api/v1/quotes — real FX provider integration', async () => {
    // Inject RealFXQuoteProvider with mocked fetch response
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: 'success',
        rates: { NGN: 1450, USD: 1 },
      }),
    } as Response);

    QuoteService.setProvider(new RealFXQuoteProvider());

    const res = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 145000,
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.provider).toBe('REAL_FX_PROVIDER');
    expect(Number(res.body.data.exchangeRate)).toBeCloseTo(0.00068965, 6);
    expect(Number(res.body.data.destinationAmount)).toBe(99);
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

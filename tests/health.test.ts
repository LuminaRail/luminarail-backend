import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('Health API Endpoint', () => {
  const app = createApp();

  it('GET /health should return 200 OK with service details', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('luminarail-backend');
    expect(res.body.timestamp).toBeDefined();
  });
});

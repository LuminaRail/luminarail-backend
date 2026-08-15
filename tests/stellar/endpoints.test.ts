import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../../src/app.js';

describe('Stellar API Read-Only Endpoints', () => {
  const app = createApp();
  const validAddress = Keypair.random().publicKey();
  const validTxHash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

  it('GET /health — includes Stellar network health status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.stellar).toBeDefined();
    expect(res.body.stellar.network).toBe('testnet');
    expect(res.body.stellar.status).toBeDefined();
  });

  it('GET /api/v1/stellar/accounts/:address — validates Stellar public key input', async () => {
    const res = await request(app).get('/api/v1/stellar/accounts/invalid_address');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/v1/stellar/accounts/:address/balances — validates Stellar public key input', async () => {
    const res = await request(app).get('/api/v1/stellar/accounts/invalid_address/balances');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/v1/stellar/transactions/:hash — validates 64-char transaction hash format', async () => {
    const res = await request(app).get('/api/v1/stellar/transactions/short_hash');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

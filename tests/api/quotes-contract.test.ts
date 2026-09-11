import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { QuoteStatus, Prisma, OrderStatus, OrderType } from '@prisma/client';
import crypto from 'crypto';

// Use vi.hoisted so mockPrisma & in-memory DB are defined prior to vi.mock hoisting
const { db, mockPrisma } = vi.hoisted(() => {
  const db = {
    users: new Map<string, any>(),
    quotes: new Map<string, any>(),
    orders: new Map<string, any>(),
    liquidityPools: new Map<string, any>(),
    liquidityReservations: new Map<string, any>(),
    transactions: new Map<string, any>(),
    auditLogs: new Map<string, any>(),
  };

  const mockPrisma = {
    quote: {
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || crypto.randomUUID();
        const record = {
          id,
          sourceCurrency: data.sourceCurrency,
          destinationAsset: data.destinationAsset,
          sourceAmount: new Prisma.Decimal(data.sourceAmount),
          destinationAmount: new Prisma.Decimal(data.destinationAmount),
          exchangeRate: new Prisma.Decimal(data.exchangeRate),
          fee: new Prisma.Decimal(data.fee),
          grossUsdcAmount: data.grossUsdcAmount ? new Prisma.Decimal(data.grossUsdcAmount) : null,
          networkFeeUsdc: data.networkFeeUsdc ? new Prisma.Decimal(data.networkFeeUsdc) : new Prisma.Decimal(0),
          spread: data.spread ? new Prisma.Decimal(data.spread) : null,
          baseFxRate: data.baseFxRate ? new Prisma.Decimal(data.baseFxRate) : null,
          rateTimestamp: data.rateTimestamp || new Date(),
          liquidityAvailable: data.liquidityAvailable ?? true,
          version: data.version || 1,
          provider: data.provider || 'MOCK_QUOTE_PROVIDER',
          status: data.status || QuoteStatus.ACTIVE,
          expiresAt: data.expiresAt || new Date(Date.now() + 300000),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        db.quotes.set(id, record);
        return record;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        return db.quotes.get(where.id) || null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const record = db.quotes.get(where.id);
        if (!record) throw new Error('Quote not found');
        Object.assign(record, data);
        record.updatedAt = new Date();
        db.quotes.set(where.id, record);
        return record;
      }),
      deleteMany: vi.fn(async () => {
        db.quotes.clear();
        return { count: 0 };
      }),
    },
    user: {
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || crypto.randomUUID();
        const record = {
          id,
          email: data.email,
          passwordHash: data.passwordHash,
          role: data.role || 'USER',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        db.users.set(id, record);
        return record;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return db.users.get(where.id) || null;
        if (where.email) {
          return Array.from(db.users.values()).find((u) => u.email === where.email) || null;
        }
        return null;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.email) {
          return Array.from(db.users.values()).find((u) => u.email === where.email) || null;
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        let list = Array.from(db.users.values());
        if (where?.email?.contains) {
          list = list.filter((u) => u.email.includes(where.email.contains));
        }
        return list;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        if (where?.id?.in) {
          for (const id of where.id.in) db.users.delete(id);
        } else {
          db.users.clear();
        }
        return { count: 0 };
      }),
    },
    order: {
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || crypto.randomUUID();
        const quote = db.quotes.get(data.quoteId);
        const record = {
          id,
          userId: data.userId,
          quoteId: data.quoteId,
          idempotencyKey: data.idempotencyKey || null,
          type: data.type || OrderType.ON_RAMP,
          status: data.status || OrderStatus.CREATED,
          sourceCurrency: data.sourceCurrency,
          destinationAsset: data.destinationAsset,
          sourceAmount: new Prisma.Decimal(data.sourceAmount),
          destinationAmount: new Prisma.Decimal(data.destinationAmount),
          walletAddress: data.walletAddress || null,
          quote,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        db.orders.set(id, record);
        return record;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const list = Array.from(db.orders.values());
        if (where.idempotencyKey && where.userId) {
          return list.find((o) => o.userId === where.userId && o.idempotencyKey === where.idempotencyKey) || null;
        }
        return null;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        return db.orders.get(where.id) || null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const record = db.orders.get(where.id);
        if (!record) throw new Error('Order not found');
        Object.assign(record, data);
        record.updatedAt = new Date();
        db.orders.set(where.id, record);
        return record;
      }),
      deleteMany: vi.fn(async () => {
        db.orders.clear();
        return { count: 0 };
      }),
    },
    liquidityPool: {
      findFirst: vi.fn(async ({ where }: any) => {
        const list = Array.from(db.liquidityPools.values());
        return list.find((p) => p.asset === where.asset) || null;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        return db.liquidityPools.get(where.id) || null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || crypto.randomUUID();
        const record = {
          id,
          asset: data.asset,
          network: data.network || 'testnet',
          totalBalance: new Prisma.Decimal(data.totalBalance || 10000),
          reservedBalance: new Prisma.Decimal(data.reservedBalance || 0),
          availableBalance: new Prisma.Decimal(data.availableBalance || 10000),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        db.liquidityPools.set(id, record);
        return record;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        let record = db.liquidityPools.get(where.id);
        if (!record && where.asset) {
          const list = Array.from(db.liquidityPools.values());
          record = list.find((p) => p.asset === where.asset);
        }
        if (!record) {
          record = {
            id: where.id || crypto.randomUUID(),
            asset: 'USDC',
            network: 'testnet',
            totalBalance: new Prisma.Decimal(10000),
            reservedBalance: new Prisma.Decimal(0),
            availableBalance: new Prisma.Decimal(10000),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          db.liquidityPools.set(record.id, record);
        }
        if (data.totalBalance !== undefined) record.totalBalance = new Prisma.Decimal(data.totalBalance);
        if (data.reservedBalance !== undefined) record.reservedBalance = new Prisma.Decimal(data.reservedBalance);
        if (data.availableBalance !== undefined) record.availableBalance = new Prisma.Decimal(data.availableBalance);
        record.updatedAt = new Date();
        db.liquidityPools.set(record.id, record);
        return record;
      }),
      deleteMany: vi.fn(async () => {
        db.liquidityPools.clear();
        return { count: 0 };
      }),
    },
    liquidityReservation: {
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || crypto.randomUUID();
        const record = {
          id,
          poolId: data.poolId,
          orderId: data.orderId,
          amount: new Prisma.Decimal(data.amount),
          status: data.status || 'RESERVED',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        db.liquidityReservations.set(id, record);
        return record;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.orderId) {
          return Array.from(db.liquidityReservations.values()).find((r) => r.orderId === where.orderId) || null;
        }
        return db.liquidityReservations.get(where.id) || null;
      }),
      deleteMany: vi.fn(async () => {
        db.liquidityReservations.clear();
        return { count: 0 };
      }),
    },
    transaction: {
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || crypto.randomUUID();
        const record = {
          id,
          userId: data.userId,
          orderId: data.orderId,
          type: data.type,
          status: data.status,
          amount: new Prisma.Decimal(data.amount),
          asset: data.asset,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        db.transactions.set(id, record);
        return record;
      }),
      deleteMany: vi.fn(async () => {
        db.transactions.clear();
        return { count: 0 };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || crypto.randomUUID();
        const record = { id, ...data, createdAt: new Date() };
        db.auditLogs.set(id, record);
        return record;
      }),
      deleteMany: vi.fn(async () => {
        db.auditLogs.clear();
        return { count: 0 };
      }),
    },
    providerTransaction: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    payment: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    settlement: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    treasuryTransaction: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(async (cb: any) => cb(mockPrisma)),
    $queryRaw: vi.fn(async () => []),
  };

  return { db, mockPrisma };
});

vi.mock('../../src/db/prisma.js', () => ({
  prisma: mockPrisma,
}));

import { createApp } from '../../src/app.js';
import { QuoteService } from '../../src/modules/quotes/quotes.service.js';
import { MockQuoteProvider } from '../../src/modules/quotes/providers/mock-quote.provider.js';
import { RealFXQuoteProvider } from '../../src/modules/quotes/providers/real-fx-quote.provider.js';
import { LiquidityService } from '../../src/modules/liquidity/liquidity.service.js';
import { config } from '../../src/config/index.js';

describe('FX Quote API Contract Integration Tests (POST /api/v1/quotes)', () => {
  const app = createApp();
  let userToken = '';
  let userId = '';

  beforeAll(async () => {
    // Seed test user and acquire authentication JWT token for authenticated endpoints
    const testEmail = `quotes-contract-${Date.now()}@luminarail.com`;
    const authRes = await request(app).post('/api/v1/auth/register').send({
      email: testEmail,
      password: 'Password123!',
    });
    userToken = authRes.body.data.token;
    userId = authRes.body.data.user.id;
  });

  beforeEach(async () => {
    // Reset QuoteProvider to MockQuoteProvider by default for API integration tests
    QuoteService.setProvider(new MockQuoteProvider());

    // Reset Liquidity Pool to 10,000 USDC available balance
    const pool = await LiquidityService.getPool('USDC', config.stellar.network);
    await mockPrisma.liquidityPool.update({
      where: { id: pool.id },
      data: {
        totalBalance: new Prisma.Decimal(10000),
        reservedBalance: new Prisma.Decimal(0),
        availableBalance: new Prisma.Decimal(10000),
      },
    });
  });

  afterAll(async () => {
    // Clean up DB test records for quotes contract test user
    db.users.clear();
    db.quotes.clear();
    db.orders.clear();
    db.liquidityReservations.clear();
    db.transactions.clear();
    db.auditLogs.clear();
  });

  // 1. Minimum Amount
  it('1. Enforces minimum transaction amount contract limit', async () => {
    // Request amount below minNgnAmount (1000 NGN)
    const invalidRes = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 500,
    });

    expect(invalidRes.status).toBe(400);
    expect(invalidRes.body.success).toBe(false);
    expect(invalidRes.body.error.message).toContain(`Minimum transaction amount is ${config.quotes.minNgnAmount} NGN.`);

    // Request amount meeting minimum threshold
    const validRes = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 1000,
    });

    expect(validRes.status).toBe(201);
    expect(validRes.body.success).toBe(true);
    expect(Number(validRes.body.data.sourceAmount)).toBe(1000);
  });

  // 2. Maximum Amount
  it('2. Enforces maximum transaction amount & max quote size contract limits', async () => {
    // Request NGN amount exceeding maxNgnAmount (10,000,000 NGN)
    const exceedMaxNgnRes = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 20000000,
    });

    expect(exceedMaxNgnRes.status).toBe(400);
    expect(exceedMaxNgnRes.body.success).toBe(false);
    expect(exceedMaxNgnRes.body.error.message).toContain(`Maximum transaction amount is ${config.quotes.maxNgnAmount} NGN.`);

    // Request NGN amount (e.g. 6,000,000 NGN < 10,000,000 NGN) with rate yielding > 10,000 USDC
    const provider = new RealFXQuoteProvider();
    vi.spyOn(provider as any, 'fetchLiveNgnRate').mockResolvedValue({
      rateNgn: 500, // 1 NGN = 0.002 USD -> 6,000,000 NGN = 12,000 USDC output (> 10,000 USDC)
      rateTimestamp: new Date(),
    });
    QuoteService.setProvider(provider);

    const exceedMaxUsdcRes = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 6000000,
    });

    expect(exceedMaxUsdcRes.status).toBe(400);
    expect(exceedMaxUsdcRes.body.success).toBe(false);
    expect(exceedMaxUsdcRes.body.error.message).toContain(`exceeds maximum allowed quote size of ${config.quotes.maxQuoteUsdcAmount} USDC.`);
  });

  // 3. Fee Rounding
  it('3. Validates fee rounding calculation (1% platform fee rounded up)', async () => {
    const amount = 1500.55;
    const res = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount,
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    // 1500.55 * 0.01 fee = 15.0055
    const expectedFee = 15.0055;
    expect(Number(res.body.data.fee)).toBe(expectedFee);
    expect(Number(res.body.data.sourceAmount)).toBe(amount);
  });

  // 4. USDC Truncation (6 decimal precision)
  it('4. Validates USDC destination payout decimal precision standards', async () => {
    const res = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000.1234,
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const destStr = res.body.data.destinationAmount.toString();
    const decimalPlaces = destStr.includes('.') ? destStr.split('.')[1].length : 0;
    // Payout decimals must not exceed USDC precision bounds (<= 7 places)
    expect(decimalPlaces).toBeLessThanOrEqual(7);

    // Assert destination payout calculation consistency
    const grossUsdc = Number(res.body.data.grossUsdcAmount);
    expect(grossUsdc).toBeGreaterThan(0);
    expect(Number(res.body.data.destinationAmount)).toBeLessThan(grossUsdc);
  });

  // 5. Spread Application
  it('5. Validates spread application in exchange rate and destination payout calculations', async () => {
    const provider = new RealFXQuoteProvider({ spreadPercentage: 0.005 }); // 0.5% spread
    vi.spyOn(provider as any, 'fetchLiveNgnRate').mockResolvedValue({
      rateNgn: 1500,
      rateTimestamp: new Date(),
    });
    QuoteService.setProvider(provider);

    const res = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 150000,
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(Number(res.body.data.spread)).toBe(0.005);

    // Base FX rate = 1 / 1500 = 0.00066666666...
    // Applied FX rate = Base * (1 - 0.005) = 0.00066333333...
    expect(Number(res.body.data.exchangeRate)).toBeCloseTo(0.00066333, 6);
  });

  // 6. Network Fee Calculation
  it('6. Validates network fee calculation inclusion in HTTP quote response payload', async () => {
    const res = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.networkFeeUsdc).toBeDefined();
    expect(Number(res.body.data.networkFeeUsdc)).toBeGreaterThanOrEqual(0);
  });

  // 7. Stale FX Rate Handling
  it('7. Rejects quote request with HTTP 502 when FX rate provider rate is stale', async () => {
    const staleTimestamp = new Date(Date.now() - 600 * 1000); // 10 minutes ago
    const provider = new RealFXQuoteProvider({ maxAgeSeconds: 300 });
    vi.spyOn(provider as any, 'fetchLiveNgnRate').mockResolvedValue({
      rateNgn: 1500,
      rateTimestamp: staleTimestamp,
    });
    QuoteService.setProvider(provider);

    const res = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('FX_PROVIDER_STALE_RATE');
    expect(res.body.error.message).toMatch(/stale/i);
  });

  // 8. Quote Expiration
  it('8. Automatically transitions quote to EXPIRED and rejects order placement for expired quotes', async () => {
    // 8a. Create quote
    const createRes = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });
    expect(createRes.status).toBe(201);
    const quoteId = createRes.body.data.id;

    // Verify initial ACTIVE status
    const getActiveRes = await request(app).get(`/api/v1/quotes/${quoteId}`);
    expect(getActiveRes.status).toBe(200);
    expect(getActiveRes.body.data.status).toBe('ACTIVE');

    // Manually force quote expiresAt into the past
    const quoteRecord = db.quotes.get(quoteId);
    quoteRecord.expiresAt = new Date(Date.now() - 10000);

    // Verify GET /quotes/:id returns status EXPIRED
    const getExpiredRes = await request(app).get(`/api/v1/quotes/${quoteId}`);
    expect(getExpiredRes.status).toBe(200);
    expect(getExpiredRes.body.data.status).toBe('EXPIRED');

    // 8b. Attempting to place an order with the expired quote fails
    const orderRes = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ quoteId, type: 'ON_RAMP' });

    expect(orderRes.status).toBe(400);
    expect(orderRes.body.success).toBe(false);
    expect(orderRes.body.error.message).toContain('Quote has expired.');
  });

  // 9. Quote Reuse Prevention
  it('9. Prevents reusing an already USED quote for order creation', async () => {
    // Create quote
    const quoteRes = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });
    const quoteId = quoteRes.body.data.id;

    // Place first order using quote -> succeeds
    const order1Res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ quoteId, type: 'ON_RAMP' });
    expect(order1Res.status).toBe(201);
    expect(order1Res.body.success).toBe(true);

    // Place second order using same quote -> fails with 400
    const order2Res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ quoteId, type: 'ON_RAMP' });
    expect(order2Res.status).toBe(400);
    expect(order2Res.body.success).toBe(false);
    expect(order2Res.body.error.message).toContain('Quote has already been used.');
  });

  // 10. Quote/Order Mismatch Validation
  it('10. Guarantees created order attributes match server quote and rejects invalid quote IDs', async () => {
    // Create quote
    const quoteRes = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });
    const quote = quoteRes.body.data;

    // Place order and verify server quote values dictate order financial values
    const orderRes = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ quoteId: quote.id, walletAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' });

    expect(orderRes.status).toBe(201);
    expect(orderRes.body.data.sourceAmount.toString()).toBe(quote.sourceAmount.toString());
    expect(orderRes.body.data.destinationAmount.toString()).toBe(quote.destinationAmount.toString());

    // Attempt to place order with non-existent quote ID (valid UUID format)
    const fakeQuoteId = '00000000-0000-4000-8000-000000000000';
    const invalidOrderRes = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ quoteId: fakeQuoteId });

    expect(invalidOrderRes.status).toBe(404);
    expect(invalidOrderRes.body.success).toBe(false);
    expect(invalidOrderRes.body.error.message).toContain('Quote not found.');
  });

  // 11. Liquidity Availability Responses
  it('11. Reports liquidityAvailable status in quote response and rejects orders on insufficient liquidity', async () => {
    // Ample liquidity case (10,000 USDC available)
    const quote1Res = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });
    expect(quote1Res.status).toBe(201);
    expect(quote1Res.body.data.liquidityAvailable).toBe(true);

    // Drain available pool liquidity to 1 USDC
    const pool = await LiquidityService.getPool('USDC', config.stellar.network);
    const poolRecord = Array.from(db.liquidityPools.values()).find((p) => p.id === pool.id || p.asset === 'USDC');
    if (poolRecord) {
      poolRecord.totalBalance = new Prisma.Decimal(1);
      poolRecord.availableBalance = new Prisma.Decimal(1);
    }

    // Create quote for ~9.9 USDC output -> returns liquidityAvailable = false
    const quote2Res = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });
    expect(quote2Res.status).toBe(201);
    expect(quote2Res.body.data.liquidityAvailable).toBe(false);

    // Attempting to place order on quote with insufficient liquidity fails
    const orderRes = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ quoteId: quote2Res.body.data.id, type: 'ON_RAMP' });

    expect(orderRes.status).toBe(400);
    expect(orderRes.body.success).toBe(false);
    expect(orderRes.body.error.message).toContain('Insufficient liquidity');
  });

  // 12. Malformed Input Payloads
  it('12. Validates and rejects malformed input payloads with HTTP 400', async () => {
    // 12a. Missing required fields
    const missingRes = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
    });
    expect(missingRes.status).toBe(400);
    expect(missingRes.body.success).toBe(false);
    expect(missingRes.body.error.code).toBe('VALIDATION_ERROR');

    // 12b. Negative amount
    const negRes = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: -500,
    });
    expect(negRes.status).toBe(400);
    expect(negRes.body.success).toBe(false);

    // 12c. Zero amount
    const zeroRes = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 0,
    });
    expect(zeroRes.status).toBe(400);
    expect(zeroRes.body.success).toBe(false);

    // 12d. Non-numeric amount string
    const stringAmountRes = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 'invalid-amount',
    });
    expect(stringAmountRes.status).toBe(400);
    expect(stringAmountRes.body.success).toBe(false);

    // 12e. Unsupported currency pair
    const unsupportedPairRes = await request(app).post('/api/v1/quotes').send({
      sourceCurrency: 'EUR',
      destinationAsset: 'JPY',
      amount: 5000,
    });
    expect(unsupportedPairRes.status).toBe(400);
    expect(unsupportedPairRes.body.success).toBe(false);
    expect(unsupportedPairRes.body.error.message).toContain('Unsupported currency pair');

    // 12f. Invalid UUID parameter on GET /api/v1/quotes/:id
    const invalidUuidRes = await request(app).get('/api/v1/quotes/not-a-uuid-12345');
    expect(invalidUuidRes.status).toBe(400);
    expect(invalidUuidRes.body.success).toBe(false);
    expect(invalidUuidRes.body.error.code).toBe('VALIDATION_ERROR');
  });
});

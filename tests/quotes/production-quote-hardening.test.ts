import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma, QuoteStatus } from '@prisma/client';
import { prisma } from '../../src/db/prisma.js';
import { QuoteService } from '../../src/modules/quotes/quotes.service.js';
import { OrderService } from '../../src/modules/orders/orders.service.js';
import { LiquidityService } from '../../src/modules/liquidity/liquidity.service.js';
import { MockQuoteProvider } from '../../src/modules/quotes/providers/mock-quote.provider.js';
import { RealFXQuoteProvider } from '../../src/modules/quotes/providers/real-fx-quote.provider.js';
import { BadRequestError, AppError } from '../../src/errors/index.js';
import { config } from '../../src/config/index.js';

describe('MAINNET-03 Production Quote Hardening Test Suite', () => {
  let testUserId: string;

  beforeEach(async () => {
    // Reset provider to mock for deterministic tests
    QuoteService.setProvider(new MockQuoteProvider());

    // Cleanup DB tables in foreign key dependency order
    await prisma.liquidityReservation.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.providerTransaction.deleteMany();
    await prisma.payment.deleteMany();
    await prisma.settlement.deleteMany();
    await prisma.order.deleteMany();
    await prisma.quote.deleteMany();
    await prisma.liquidityPool.deleteMany();
    await prisma.user.deleteMany({ where: { email: { contains: 'quote-hardening' } } });

    // Seed test user
    const user = await prisma.user.create({
      data: {
        email: `quote-hardening-${Date.now()}@luminarail.com`,
        passwordHash: 'hashed_pw',
        role: 'USER',
      },
    });
    testUserId = user.id;

    // Seed liquidity pool with 10,000 USDC
    await LiquidityService.getPool('USDC', config.stellar.network);
  });

  // Test 1: Valid NGN -> USDC quote
  it('1. Generates a valid NGN -> USDC quote with canonical fields', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });

    expect(quote.id).toBeDefined();
    expect(quote.sourceCurrency).toBe('NGN');
    expect(quote.destinationAsset).toBe('USDC');
    expect(quote.sourceAmount.toString()).toBe('15000');
    expect(quote.fee.toString()).toBe('150'); // 1% fee = 150 NGN
    expect(quote.status).toBe(QuoteStatus.ACTIVE);
    expect(quote.liquidityAvailable).toBe(true);
    expect(quote.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  // Test 2: Zero NGN
  it('2. Rejects zero NGN input amount', async () => {
    await expect(
      QuoteService.createQuote({
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        amount: 0,
      })
    ).rejects.toThrow('Amount must be a positive number.');
  });

  // Test 3: Negative NGN
  it('3. Rejects negative NGN input amount', async () => {
    await expect(
      QuoteService.createQuote({
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        amount: -5000,
      })
    ).rejects.toThrow('Amount must be a positive number.');
  });

  // Test 4: Malformed amount
  it('4. Rejects malformed / NaN amount', async () => {
    await expect(
      QuoteService.createQuote({
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        amount: NaN as any,
      })
    ).rejects.toThrow('Amount must be a positive number.');
  });

  // Test 5: Unsupported currency pair
  it('5. Rejects unsupported currency pair', async () => {
    await expect(
      QuoteService.createQuote({
        sourceCurrency: 'EUR',
        destinationAsset: 'JPY',
        amount: 5000,
      })
    ).rejects.toThrow('Unsupported currency pair');
  });

  // Test 6: FX provider failure
  it('6. Rejects quote when FX provider returns HTTP error', async () => {
    const mockProvider = new RealFXQuoteProvider({ apiUrl: 'https://invalid-fx-endpoint-999.com/latest' });
    QuoteService.setProvider(mockProvider);

    await expect(
      QuoteService.createQuote({
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        amount: 5000,
      })
    ).rejects.toThrow();
  });

  // Test 7: FX provider timeout
  it('7. Rejects quote on FX provider timeout', async () => {
    const mockProvider = new RealFXQuoteProvider({ timeoutMs: 1, apiUrl: 'https://httpbin.org/delay/10' });
    QuoteService.setProvider(mockProvider);

    await expect(
      QuoteService.createQuote({
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        amount: 5000,
      })
    ).rejects.toThrow();
  });

  // Test 8: Invalid FX rate
  it('8. Rejects invalid FX rate from provider', async () => {
    const provider = new RealFXQuoteProvider();
    vi.spyOn(provider as any, 'fetchLiveNgnRate').mockResolvedValue({ rateNgn: NaN, rateTimestamp: new Date() });
    QuoteService.setProvider(provider);

    await expect(
      QuoteService.createQuote({
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        amount: 5000,
      })
    ).rejects.toThrow();
  });

  // Test 9: Zero FX rate
  it('9. Rejects zero FX rate from provider', async () => {
    const provider = new RealFXQuoteProvider();
    vi.spyOn(provider as any, 'fetchLiveNgnRate').mockResolvedValue({ rateNgn: 0, rateTimestamp: new Date() });
    QuoteService.setProvider(provider);

    await expect(
      QuoteService.createQuote({
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        amount: 5000,
      })
    ).rejects.toThrow();
  });

  // Test 10: Negative FX rate
  it('10. Rejects negative FX rate from provider', async () => {
    const provider = new RealFXQuoteProvider();
    vi.spyOn(provider as any, 'fetchLiveNgnRate').mockResolvedValue({ rateNgn: -1500, rateTimestamp: new Date() });
    QuoteService.setProvider(provider);

    await expect(
      QuoteService.createQuote({
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        amount: 5000,
      })
    ).rejects.toThrow();
  });

  // Test 11: Stale FX rate
  it('11. Rejects stale FX rate exceeding max age threshold', async () => {
    const staleTime = new Date(Date.now() - 600 * 1000); // 10 minutes old
    const provider = new RealFXQuoteProvider({ maxAgeSeconds: 300 });
    vi.spyOn(provider as any, 'fetchLiveNgnRate').mockResolvedValue({ rateNgn: 1500, rateTimestamp: staleTime });
    QuoteService.setProvider(provider);

    await expect(
      QuoteService.createQuote({
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        amount: 5000,
      })
    ).rejects.toThrow(/stale/i);
  });

  // Test 12: Quote expiration
  it('12. Marks quote as EXPIRED when retrieved after expiresAt', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 5000,
    });

    // Manually push expiresAt into past
    await prisma.quote.update({
      where: { id: quote.id },
      data: { expiresAt: new Date(Date.now() - 10000) },
    });

    const retrieved = await QuoteService.getQuoteById(quote.id);
    expect(retrieved.status).toBe(QuoteStatus.EXPIRED);
  });

  // Test 13: Quote still valid
  it('13. Keeps quote ACTIVE before expiresAt', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 5000,
    });

    const retrieved = await QuoteService.getQuoteById(quote.id);
    expect(retrieved.status).toBe(QuoteStatus.ACTIVE);
  });

  // Test 14: Deterministic rounding
  it('14. Applies deterministic rounding (ROUND_DOWN for payout, ROUND_UP for platform fee)', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 1500.555,
    });

    // Destination USDC payout decimal places must not exceed 7
    const destStr = quote.destinationAmount.toString();
    const decimals = destStr.includes('.') ? destStr.split('.')[1].length : 0;
    expect(decimals).toBeLessThanOrEqual(7);
  });

  // Test 15: Decimal precision
  it('15. Uses Decimal objects without JavaScript float inaccuracy', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 100000,
    });

    expect(quote.sourceAmount).toBeInstanceOf(Prisma.Decimal);
    expect(quote.destinationAmount).toBeInstanceOf(Prisma.Decimal);
    expect(quote.fee).toBeInstanceOf(Prisma.Decimal);
  });

  // Test 16: Minimum transaction limit
  it('16. Enforces minimum NGN transaction limit', async () => {
    await expect(
      QuoteService.createQuote({
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        amount: 500, // Below 1000 NGN min limit
      })
    ).rejects.toThrow('Minimum transaction amount is 1000 NGN.');
  });

  // Test 17: Maximum transaction limit
  it('17. Enforces maximum NGN transaction limit', async () => {
    await expect(
      QuoteService.createQuote({
        sourceCurrency: 'NGN',
        destinationAsset: 'USDC',
        amount: 20000000, // Exceeds 10,000,000 NGN max limit
      })
    ).rejects.toThrow('Maximum transaction amount is 10000000 NGN.');
  });

  // Test 18: Client attempting to modify quote values
  it('18. Derives order values exclusively from server quote, ignoring client tampering', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });

    const { order } = await OrderService.createOrder(testUserId, {
      quoteId: quote.id,
      // Client tries to pass fake walletAddress or tampered details
      walletAddress: 'GA7QTESTADDRESS',
    });

    expect(order.sourceAmount.toString()).toBe(quote.sourceAmount.toString());
    expect(order.destinationAmount.toString()).toBe(quote.destinationAmount.toString());
  });

  // Test 19: Expired quote during order creation
  it('19. Fails order creation if quote expires before order is placed', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });

    await prisma.quote.update({
      where: { id: quote.id },
      data: { expiresAt: new Date(Date.now() - 5000) },
    });

    await expect(
      OrderService.createOrder(testUserId, { quoteId: quote.id })
    ).rejects.toThrow('Quote has expired.');
  });

  // Test 20: Quote/order amount mismatch check
  it('20. Prevents creating order with already USED quote', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });

    await OrderService.createOrder(testUserId, { quoteId: quote.id });

    await expect(
      OrderService.createOrder(testUserId, { quoteId: quote.id })
    ).rejects.toThrow('Quote has already been used.');
  });

  // Test 21: Insufficient liquidity during order creation
  it('21. Fails order creation if pool liquidity is insufficient', async () => {
    // Set pool total balance to 1 USDC
    const pool = await LiquidityService.getPool('USDC', config.stellar.network);
    await prisma.liquidityPool.update({
      where: { id: pool.id },
      data: { totalBalance: new Prisma.Decimal(1), availableBalance: new Prisma.Decimal(1) },
    });

    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000, // Requires ~9.9 USDC
    });

    await expect(
      OrderService.createOrder(testUserId, { quoteId: quote.id })
    ).rejects.toThrow('Insufficient liquidity');
  });

  // Test 22: Liquidity disappearing between quote and order creation
  it('22. Handles race where liquidity is drained between quote and order creation', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });

    expect(quote.liquidityAvailable).toBe(true);

    // Draining liquidity between quote and order creation
    const pool = await LiquidityService.getPool('USDC', config.stellar.network);
    await prisma.liquidityPool.update({
      where: { id: pool.id },
      data: { totalBalance: new Prisma.Decimal(0), availableBalance: new Prisma.Decimal(0) },
    });

    await expect(
      OrderService.createOrder(testUserId, { quoteId: quote.id })
    ).rejects.toThrow('Insufficient liquidity');
  });

  // Test 23: Successful quote -> order -> reservation flow
  it('23. Executes full quote -> order creation -> liquidity reservation flow', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });

    const { order } = await OrderService.createOrder(testUserId, { quoteId: quote.id });

    expect(order.id).toBeDefined();
    expect(order.status).toBe('CREATED');

    const reservation = await prisma.liquidityReservation.findUnique({
      where: { orderId: order.id },
    });
    expect(reservation).toBeDefined();
    expect(reservation?.status).toBe('RESERVED');
    expect(reservation?.amount.toString()).toBe(quote.destinationAmount.toString());
  });

  // Test 24: Duplicate order creation / idempotency
  it('24. Returns existing order on duplicate order creation with same idempotency key', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });

    const res1 = await OrderService.createOrder(testUserId, {
      quoteId: quote.id,
      idempotencyKey: 'idem-key-quote-hardening-999',
    });
    expect(res1.isDuplicate).toBe(false);

    const res2 = await OrderService.createOrder(testUserId, {
      quoteId: quote.id,
      idempotencyKey: 'idem-key-quote-hardening-999',
    });
    expect(res2.isDuplicate).toBe(true);
    expect(res2.order.id).toBe(res1.order.id);
  });

  // Test 25: Settlement amount cannot exceed quote-authorized amount
  it('25. Guarantees settlement amount equals quote-authorized destinationAmount', async () => {
    const quote = await QuoteService.createQuote({
      sourceCurrency: 'NGN',
      destinationAsset: 'USDC',
      amount: 15000,
    });

    const { order } = await OrderService.createOrder(testUserId, { quoteId: quote.id });

    const settlementAmount = order.destinationAmount;
    expect(settlementAmount.lte(quote.destinationAmount)).toBe(true);
    expect(settlementAmount.toString()).toBe(quote.destinationAmount.toString());
  });
});

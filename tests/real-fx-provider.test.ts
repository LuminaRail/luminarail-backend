import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealFXQuoteProvider } from '../src/modules/quotes/providers/real-fx-quote.provider.js';
import { MockQuoteProvider } from '../src/modules/quotes/providers/mock-quote.provider.js';
import { QuoteService } from '../src/modules/quotes/quotes.service.js';

describe('RealFXQuoteProvider & Quote System', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successful live-rate conversion with valid FX API response', async () => {
    const mockRatesPayload = {
      result: 'success',
      time_last_update_unix: 1700000000,
      rates: {
        NGN: 1500,
        USD: 1,
      },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockRatesPayload,
    } as Response);

    const provider = new RealFXQuoteProvider({
      apiUrl: 'https://open.er-api.com/v6/latest/USD',
      feePercentage: 0.01,
    });

    const result = await provider.calculate('NGN', 'USDC', 150000, 'source');

    expect(result.provider).toBe('REAL_FX_PROVIDER');
    expect(result.sourceAmount).toBe(150000);

    // Fee = 150000 * 0.01 = 1500
    // Net NGN = 148500
    // Rate = 1 / 1500 = 0.00066667
    // Dest USDC = 148500 * (1/1500) = 99 USDC
    expect(result.fee).toBe(1500);
    expect(result.destinationAmount).toBe(99);
    expect(result.exchangeRate).toBe(0.00066667);
    expect(result.rateTimestamp).toBeInstanceOf(Date);
  });

  it('destination side amount calculation', async () => {
    const mockRatesPayload = {
      result: 'success',
      rates: {
        NGN: 1500,
        USD: 1,
      },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockRatesPayload,
    } as Response);

    const provider = new RealFXQuoteProvider({ feePercentage: 0.01 });
    const result = await provider.calculate('NGN', 'USDC', 99, 'destination');

    expect(result.provider).toBe('REAL_FX_PROVIDER');
    expect(result.destinationAmount).toBe(99);
    // Net source needed = 99 / (1/1500) = 148500 NGN
    // Total source = 148500 / 0.99 = 150000 NGN
    expect(result.sourceAmount).toBe(150000);
    expect(result.fee).toBe(1500);
  });

  it('provider failure (HTTP status 500)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    const provider = new RealFXQuoteProvider();
    await expect(provider.calculate('NGN', 'USDC', 10000, 'source')).rejects.toThrow(
      'FX rate provider returned HTTP status 500'
    );
  });

  it('timeout handling', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(abortError);

    const provider = new RealFXQuoteProvider({ timeoutMs: 100 });
    await expect(provider.calculate('NGN', 'USDC', 10000, 'source')).rejects.toThrow(
      'FX rate provider request timed out'
    );
  });

  it('rejects zero rate returned by FX provider', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ rates: { NGN: 0 } }),
    } as Response);

    const provider = new RealFXQuoteProvider();
    await expect(provider.calculate('NGN', 'USDC', 10000, 'source')).rejects.toThrow(
      'Invalid or non-positive NGN rate'
    );
  });

  it('rejects negative rate returned by FX provider', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ rates: { NGN: -1200 } }),
    } as Response);

    const provider = new RealFXQuoteProvider();
    await expect(provider.calculate('NGN', 'USDC', 10000, 'source')).rejects.toThrow(
      'Invalid or non-positive NGN rate'
    );
  });

  it('rejects malformed payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ invalid_payload: true }),
    } as Response);

    const provider = new RealFXQuoteProvider();
    await expect(provider.calculate('NGN', 'USDC', 10000, 'source')).rejects.toThrow(
      'Rates payload missing from FX rate provider'
    );
  });

  it('rejects zero or negative input amount', async () => {
    const provider = new RealFXQuoteProvider();
    await expect(provider.calculate('NGN', 'USDC', 0, 'source')).rejects.toThrow(
      'Invalid quote amount requested'
    );
    await expect(provider.calculate('NGN', 'USDC', -50, 'source')).rejects.toThrow(
      'Invalid quote amount requested'
    );
  });

  it('QuoteService dependency injection switches between providers', () => {
    const mockProvider = new MockQuoteProvider();
    QuoteService.setProvider(mockProvider);
    expect(QuoteService.getProvider().name).toBe('MOCK_QUOTE_PROVIDER');

    const realProvider = new RealFXQuoteProvider();
    QuoteService.setProvider(realProvider);
    expect(QuoteService.getProvider().name).toBe('REAL_FX_PROVIDER');
  });
});

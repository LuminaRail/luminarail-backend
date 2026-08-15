import { QuoteProvider, QuoteCalculationResult } from './quote-provider.interface.js';
import { config } from '../../../config/index.js';
import { AppError } from '../../../errors/index.js';

export class RealFXQuoteProvider implements QuoteProvider {
  public readonly name = 'REAL_FX_PROVIDER';

  private readonly apiUrl: string;
  private readonly apiKey?: string;
  private readonly feePercentage: number;
  private readonly timeoutMs: number;

  constructor(options?: { apiUrl?: string; apiKey?: string; feePercentage?: number; timeoutMs?: number }) {
    this.apiUrl = options?.apiUrl || config.quotes.fxApiUrl || 'https://open.er-api.com/v6/latest/USD';
    this.apiKey = options?.apiKey ?? config.quotes.fxApiKey;
    this.feePercentage = options?.feePercentage ?? config.quotes.feePercentage ?? 0.01;
    this.timeoutMs = options?.timeoutMs ?? 5000;
  }

  async calculate(
    sourceCurrency: string,
    destinationAsset: string,
    amount: number,
    side: 'source' | 'destination' = 'source'
  ): Promise<QuoteCalculationResult> {
    if (!amount || typeof amount !== 'number' || amount <= 0 || !isFinite(amount) || isNaN(amount)) {
      throw new AppError('Invalid quote amount requested', 400, 'INVALID_AMOUNT');
    }

    const { rateNgn, rateTimestamp } = await this.fetchLiveNgnRate();

    let rawRate: number;

    // Currency pair mapping: NGN ↔ USDC (treating 1 USDC = 1 USD as business rule)
    if (sourceCurrency === 'NGN' && (destinationAsset === 'USDC' || destinationAsset === 'USD')) {
      rawRate = 1 / rateNgn;
    } else if ((sourceCurrency === 'USDC' || sourceCurrency === 'USD') && destinationAsset === 'NGN') {
      rawRate = rateNgn;
    } else if (sourceCurrency === destinationAsset) {
      rawRate = 1.0;
    } else {
      // Fallback for cross pairs relative to USD
      rawRate = 1 / rateNgn;
    }

    if (!rawRate || typeof rawRate !== 'number' || rawRate <= 0 || !isFinite(rawRate) || isNaN(rawRate)) {
      throw new AppError('Calculated exchange rate is invalid', 502, 'INVALID_EXCHANGE_RATE');
    }

    let sourceAmt: number;
    let destAmt: number;
    let feeAmt: number;

    if (side === 'source') {
      sourceAmt = amount;
      feeAmt = sourceAmt * this.feePercentage;
      const netSource = sourceAmt - feeAmt;
      destAmt = netSource * rawRate;
    } else {
      destAmt = amount;
      const netSourceNeeded = destAmt / rawRate;
      sourceAmt = netSourceNeeded / (1 - this.feePercentage);
      feeAmt = sourceAmt * this.feePercentage;
    }

    return {
      exchangeRate: parseFloat(rawRate.toFixed(8)),
      sourceAmount: parseFloat(sourceAmt.toFixed(4)),
      destinationAmount: parseFloat(destAmt.toFixed(4)),
      fee: parseFloat(feeAmt.toFixed(4)),
      provider: this.name,
      rateTimestamp,
    };
  }

  private async fetchLiveNgnRate(): Promise<{ rateNgn: number; rateTimestamp: Date }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };

      let requestUrl = this.apiUrl;

      // Safely apply API key if provided without logging credentials
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(requestUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new AppError(`FX rate provider returned HTTP status ${response.status}`, 502, 'FX_PROVIDER_HTTP_ERROR');
      }

      const data = (await response.json()) as any;

      if (!data || typeof data !== 'object') {
        throw new AppError('Malformed payload from FX rate provider', 502, 'FX_PROVIDER_MALFORMED');
      }

      const rates = data.rates || data.conversion_rates;
      if (!rates || typeof rates !== 'object') {
        throw new AppError('Rates payload missing from FX rate provider', 502, 'FX_PROVIDER_MALFORMED');
      }

      const rateNgn = rates.NGN;

      if (typeof rateNgn !== 'number' || isNaN(rateNgn) || !isFinite(rateNgn) || rateNgn <= 0) {
        throw new AppError('Invalid or non-positive NGN rate returned by FX provider', 502, 'FX_PROVIDER_INVALID_RATE');
      }

      let rateTimestamp = new Date();
      if (data.time_last_update_unix && typeof data.time_last_update_unix === 'number') {
        rateTimestamp = new Date(data.time_last_update_unix * 1000);
      }

      return {
        rateNgn,
        rateTimestamp,
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new AppError('FX rate provider request timed out', 504, 'FX_PROVIDER_TIMEOUT');
      }

      if (err instanceof AppError) {
        throw err;
      }

      throw new AppError(`Failed to fetch FX rate: ${err.message || 'Unknown network error'}`, 502, 'FX_PROVIDER_ERROR');
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

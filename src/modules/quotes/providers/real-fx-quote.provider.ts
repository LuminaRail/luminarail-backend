import { Prisma } from '@prisma/client';
import { QuoteProvider, QuoteCalculationResult } from './quote-provider.interface.js';
import { config } from '../../../config/index.js';
import { AppError } from '../../../errors/index.js';

export class RealFXQuoteProvider implements QuoteProvider {
  public readonly name = 'REAL_FX_PROVIDER';

  private readonly apiUrl: string;
  private readonly apiKey?: string;
  private readonly feePercentage: Prisma.Decimal;
  private readonly spreadPercentage: Prisma.Decimal;
  private readonly timeoutMs: number;
  private readonly maxAgeSeconds: number;

  constructor(options?: {
    apiUrl?: string;
    apiKey?: string;
    feePercentage?: number;
    spreadPercentage?: number;
    timeoutMs?: number;
    maxAgeSeconds?: number;
  }) {
    this.apiUrl = options?.apiUrl || config.quotes.fxApiUrl || 'https://open.er-api.com/v6/latest/USD';
    this.apiKey = options?.apiKey ?? config.quotes.fxApiKey;
    this.feePercentage = new Prisma.Decimal(options?.feePercentage ?? config.quotes.feePercentage ?? 0.01);
    this.spreadPercentage = new Prisma.Decimal(options?.spreadPercentage ?? config.quotes.spreadPercentage ?? 0);
    this.timeoutMs = options?.timeoutMs ?? 5000;
    this.maxAgeSeconds = options?.maxAgeSeconds ?? config.quotes.fxMaxAgeSeconds ?? 300;
  }

  async calculate(
    sourceCurrency: string,
    destinationAsset: string,
    amount: Prisma.Decimal | number | string,
    side: 'source' | 'destination' = 'source'
  ): Promise<QuoteCalculationResult> {
    const amountDec = new Prisma.Decimal(amount);
    if (amountDec.isNaN() || !amountDec.isFinite() || amountDec.lte(0)) {
      throw new AppError('Invalid quote amount requested', 400, 'INVALID_AMOUNT');
    }

    const { rateNgn, rateTimestamp } = await this.fetchLiveNgnRate();

    const rateAgeSeconds = (Date.now() - rateTimestamp.getTime()) / 1000;
    if (this.maxAgeSeconds > 0 && rateAgeSeconds > this.maxAgeSeconds) {
      throw new AppError(
        `FX rate from provider is stale (age: ${Math.round(rateAgeSeconds)}s, max allowed: ${this.maxAgeSeconds}s)`,
        502,
        'FX_PROVIDER_STALE_RATE'
      );
    }

    if (rateNgn < 50 || rateNgn > 500000) {
      throw new AppError('FX rate returned is outside reasonable safety bounds', 502, 'FX_PROVIDER_UNREASONABLE_RATE');
    }

    let rawRateDec: Prisma.Decimal;

    if (sourceCurrency === 'NGN' && (destinationAsset === 'USDC' || destinationAsset === 'USD')) {
      rawRateDec = new Prisma.Decimal(1).div(new Prisma.Decimal(rateNgn));
    } else if ((sourceCurrency === 'USDC' || sourceCurrency === 'USD') && destinationAsset === 'NGN') {
      rawRateDec = new Prisma.Decimal(rateNgn);
    } else if (sourceCurrency === destinationAsset) {
      rawRateDec = new Prisma.Decimal(1);
    } else {
      rawRateDec = new Prisma.Decimal(1).div(new Prisma.Decimal(rateNgn));
    }

    if (rawRateDec.isNaN() || !rawRateDec.isFinite() || rawRateDec.lte(0)) {
      throw new AppError('Calculated exchange rate is invalid or non-positive', 502, 'INVALID_EXCHANGE_RATE');
    }

    const baseFxRate = rawRateDec;
    const appliedFxRate = baseFxRate.mul(new Prisma.Decimal(1).sub(this.spreadPercentage));
    const networkFeeUsdc = new Prisma.Decimal(0);

    let sourceAmountDec: Prisma.Decimal;
    let destinationAmountDec: Prisma.Decimal;
    let grossUsdcAmountDec: Prisma.Decimal;
    let feeDec: Prisma.Decimal;

    if (side === 'source') {
      sourceAmountDec = amountDec.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
      feeDec = sourceAmountDec.mul(this.feePercentage).toDecimalPlaces(4, Prisma.Decimal.ROUND_UP);
      const netSource = sourceAmountDec.sub(feeDec);

      grossUsdcAmountDec = sourceAmountDec.mul(baseFxRate).toDecimalPlaces(7, Prisma.Decimal.ROUND_DOWN);
      destinationAmountDec = netSource.mul(appliedFxRate).toDecimalPlaces(7, Prisma.Decimal.ROUND_DOWN);
    } else {
      destinationAmountDec = amountDec.toDecimalPlaces(7, Prisma.Decimal.ROUND_HALF_UP);
      const netSourceNeeded = destinationAmountDec.div(appliedFxRate);
      sourceAmountDec = netSourceNeeded.div(new Prisma.Decimal(1).sub(this.feePercentage)).toDecimalPlaces(4, Prisma.Decimal.ROUND_UP);
      feeDec = sourceAmountDec.mul(this.feePercentage).toDecimalPlaces(4, Prisma.Decimal.ROUND_UP);
      grossUsdcAmountDec = sourceAmountDec.mul(baseFxRate).toDecimalPlaces(7, Prisma.Decimal.ROUND_DOWN);
    }

    return {
      sourceCurrency,
      destinationAsset,
      sourceAmount: sourceAmountDec.toNumber(),
      destinationAmount: destinationAmountDec.toNumber(),
      grossUsdcAmount: grossUsdcAmountDec.toNumber(),
      fee: feeDec.toNumber(),
      networkFeeUsdc: networkFeeUsdc.toNumber(),
      spread: this.spreadPercentage.toNumber(),
      baseFxRate: baseFxRate.toNumber(),
      appliedFxRate: appliedFxRate.toNumber(),
      exchangeRate: parseFloat(appliedFxRate.toFixed(8)),
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

      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(this.apiUrl, {
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
        const parsedTs = new Date(data.time_last_update_unix * 1000);
        const ageSeconds = (Date.now() - parsedTs.getTime()) / 1000;
        if (ageSeconds >= 0 && ageSeconds <= 7 * 86400) {
          rateTimestamp = parsedTs;
        }
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

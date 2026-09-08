import { Prisma } from '@prisma/client';
import { QuoteProvider, QuoteCalculationResult } from './quote-provider.interface.js';
import { config } from '../../../config/index.js';
import { AppError } from '../../../errors/index.js';

export class MockQuoteProvider implements QuoteProvider {
  public readonly name = 'MOCK_QUOTE_PROVIDER';

  private static MOCK_RATES: Record<string, string> = {
    'NGN_USDC': '0.00066667',
    'USDC_NGN': '1500',
    'USD_NGN': '1500',
    'NGN_USD': '0.00066667',
    'XLM_NGN': '150',
    'NGN_XLM': '0.00666667',
    'USDC_XLM': '10',
    'XLM_USDC': '0.1',
  };

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

    const pairKey = `${sourceCurrency}_${destinationAsset}`;
    const rawRateStr = MockQuoteProvider.MOCK_RATES[pairKey] || '1.0';
    const baseFxRate = new Prisma.Decimal(rawRateStr);

    const feePercentage = new Prisma.Decimal(config.quotes.feePercentage ?? 0.01);
    const spreadPercentage = new Prisma.Decimal(config.quotes.spreadPercentage ?? 0);
    const networkFeeUsdc = new Prisma.Decimal(0);

    const appliedFxRate = baseFxRate.mul(new Prisma.Decimal(1).sub(spreadPercentage));

    let sourceAmountDec: Prisma.Decimal;
    let destinationAmountDec: Prisma.Decimal;
    let grossUsdcAmountDec: Prisma.Decimal;
    let feeDec: Prisma.Decimal;

    if (side === 'source') {
      sourceAmountDec = amountDec.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
      feeDec = sourceAmountDec.mul(feePercentage).toDecimalPlaces(4, Prisma.Decimal.ROUND_UP);
      const netSource = sourceAmountDec.sub(feeDec);

      grossUsdcAmountDec = sourceAmountDec.mul(baseFxRate).toDecimalPlaces(7, Prisma.Decimal.ROUND_DOWN);
      destinationAmountDec = netSource.mul(appliedFxRate).toDecimalPlaces(7, Prisma.Decimal.ROUND_DOWN);
    } else {
      destinationAmountDec = amountDec.toDecimalPlaces(7, Prisma.Decimal.ROUND_HALF_UP);
      const netSourceNeeded = destinationAmountDec.div(appliedFxRate);
      sourceAmountDec = netSourceNeeded.div(new Prisma.Decimal(1).sub(feePercentage)).toDecimalPlaces(4, Prisma.Decimal.ROUND_UP);
      feeDec = sourceAmountDec.mul(feePercentage).toDecimalPlaces(4, Prisma.Decimal.ROUND_UP);
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
      spread: spreadPercentage.toNumber(),
      baseFxRate: baseFxRate.toNumber(),
      appliedFxRate: appliedFxRate.toNumber(),
      exchangeRate: parseFloat(appliedFxRate.toFixed(8)),
      provider: this.name,
      rateTimestamp: new Date(),
    };
  }
}

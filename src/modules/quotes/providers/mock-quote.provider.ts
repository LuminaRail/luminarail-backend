import { QuoteProvider, QuoteCalculationResult } from './quote-provider.interface.js';

export class MockQuoteProvider implements QuoteProvider {
  public readonly name = 'MOCK_QUOTE_PROVIDER';

  private static MOCK_RATES: Record<string, number> = {
    'NGN_USDC': 0.00066667,
    'USDC_NGN': 1500,
    'USD_NGN': 1500,
    'NGN_USD': 0.00066667,
    'XLM_NGN': 150,
    'NGN_XLM': 0.00666667,
    'USDC_XLM': 10,
    'XLM_USDC': 0.1,
  };

  async calculate(
    sourceCurrency: string,
    destinationAsset: string,
    amount: number,
    side: 'source' | 'destination'
  ): Promise<QuoteCalculationResult> {
    const pairKey = `${sourceCurrency}_${destinationAsset}`;
    let rate = MockQuoteProvider.MOCK_RATES[pairKey] || 1.0;

    const feePercentage = 0.01;
    let sourceAmt: number;
    let destAmt: number;
    let feeAmt: number;

    if (side === 'source') {
      sourceAmt = amount;
      feeAmt = sourceAmt * feePercentage;
      const netSource = sourceAmt - feeAmt;
      destAmt = netSource * rate;
    } else {
      destAmt = amount;
      const netSourceNeeded = destAmt / rate;
      sourceAmt = netSourceNeeded / (1 - feePercentage);
      feeAmt = sourceAmt * feePercentage;
    }

    return {
      exchangeRate: rate,
      sourceAmount: parseFloat(sourceAmt.toFixed(4)),
      destinationAmount: parseFloat(destAmt.toFixed(4)),
      fee: parseFloat(feeAmt.toFixed(4)),
      provider: this.name,
      rateTimestamp: new Date(),
    };
  }
}

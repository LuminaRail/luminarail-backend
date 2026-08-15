export interface QuoteCalculationResult {
  exchangeRate: number;
  sourceAmount: number;
  destinationAmount: number;
  fee: number;
  provider: string;
  rateTimestamp: Date;
}

export interface QuoteProvider {
  readonly name: string;
  calculate(
    sourceCurrency: string,
    destinationAsset: string,
    amount: number,
    side: 'source' | 'destination'
  ): Promise<QuoteCalculationResult>;
}

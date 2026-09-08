import { Prisma } from '@prisma/client';

export interface QuoteCalculationResult {
  sourceCurrency: string;
  destinationAsset: string;
  sourceAmount: number | Prisma.Decimal;
  destinationAmount: number | Prisma.Decimal;
  grossUsdcAmount: number | Prisma.Decimal;
  fee: number | Prisma.Decimal;
  networkFeeUsdc: number | Prisma.Decimal;
  spread: number | Prisma.Decimal;
  baseFxRate: number | Prisma.Decimal;
  appliedFxRate: number | Prisma.Decimal;
  exchangeRate: number | Prisma.Decimal;
  provider: string;
  rateTimestamp: Date;
}

export interface QuoteProvider {
  readonly name: string;
  calculate(
    sourceCurrency: string,
    destinationAsset: string,
    amount: Prisma.Decimal | number | string,
    side?: 'source' | 'destination'
  ): Promise<QuoteCalculationResult>;
}

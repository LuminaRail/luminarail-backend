import { Prisma, QuoteStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, NotFoundError } from '../../errors/index.js';
import { AuditService } from '../audit/audit.service.js';

export interface GenerateQuoteInput {
  sourceCurrency: string;
  destinationAsset: string;
  amount: number;
  side?: 'source' | 'destination';
}

// Deterministic Mock Quote Engine (isolated for Phase 1)
class MockQuoteEngine {
  private static MOCK_RATES: Record<string, number> = {
    'NGN_USDC': 0.00066667, // 1 NGN ~ 0.00066667 USDC (1500 NGN/USDC)
    'USDC_NGN': 1500,       // 1 USDC ~ 1500 NGN
    'USD_NGN': 1500,
    'NGN_USD': 0.00066667,
    'XLM_NGN': 150,
    'NGN_XLM': 0.00666667,
    'USDC_XLM': 10,
    'XLM_USDC': 0.1,
  };

  static calculate(source: string, dest: string, amount: number, side: 'source' | 'destination') {
    const pairKey = `${source}_${dest}`;
    let rate = this.MOCK_RATES[pairKey];

    if (!rate) {
      if (source === dest) {
        rate = 1.0;
      } else {
        rate = 1.0; // Fallback mock rate
      }
    }

    const feePercentage = 0.01; // 1% mock fee
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
      provider: 'MOCK_QUOTE_PROVIDER',
    };
  }
}

export class QuoteService {
  static async createQuote(input: GenerateQuoteInput, userId?: string, ipAddress?: string) {
    const calculation = MockQuoteEngine.calculate(
      input.sourceCurrency,
      input.destinationAsset,
      input.amount,
      input.side || 'source'
    );

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minute expiration

    const quote = await prisma.quote.create({
      data: {
        sourceCurrency: input.sourceCurrency,
        destinationAsset: input.destinationAsset,
        sourceAmount: new Prisma.Decimal(calculation.sourceAmount),
        destinationAmount: new Prisma.Decimal(calculation.destinationAmount),
        exchangeRate: new Prisma.Decimal(calculation.exchangeRate),
        fee: new Prisma.Decimal(calculation.fee),
        provider: calculation.provider,
        status: QuoteStatus.ACTIVE,
        expiresAt,
      },
    });

    await AuditService.log({
      actor: userId || 'anonymous',
      userId,
      action: 'QUOTE_CREATED',
      resource: 'Quote',
      resourceId: quote.id,
      details: {
        sourceCurrency: quote.sourceCurrency,
        destinationAsset: quote.destinationAsset,
        sourceAmount: quote.sourceAmount.toString(),
        destinationAmount: quote.destinationAmount.toString(),
        expiresAt: quote.expiresAt.toISOString(),
      },
      ipAddress,
    });

    return quote;
  }

  static async getQuoteById(quoteId: string) {
    const quote = await prisma.quote.findUnique({
      where: { id: quoteId },
    });

    if (!quote) {
      throw new NotFoundError('Quote not found.');
    }

    // Check expiration
    if (quote.status === QuoteStatus.ACTIVE && new Date() > quote.expiresAt) {
      return prisma.quote.update({
        where: { id: quoteId },
        data: { status: QuoteStatus.EXPIRED },
      });
    }

    return quote;
  }

  static async validateAndUseQuote(quoteId: string) {
    const quote = await this.getQuoteById(quoteId);

    if (quote.status === QuoteStatus.EXPIRED || new Date() > quote.expiresAt) {
      throw new BadRequestError('Quote has expired.');
    }

    if (quote.status === QuoteStatus.USED) {
      throw new BadRequestError('Quote has already been used.');
    }

    if (quote.status === QuoteStatus.CANCELLED) {
      throw new BadRequestError('Quote has been cancelled.');
    }

    // Mark as USED
    return prisma.quote.update({
      where: { id: quoteId },
      data: { status: QuoteStatus.USED },
    });
  }
}

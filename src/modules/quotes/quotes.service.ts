import { Prisma, QuoteStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, NotFoundError } from '../../errors/index.js';
import { AuditService } from '../audit/audit.service.js';
import { config } from '../../config/index.js';
import { QuoteProvider } from './providers/quote-provider.interface.js';
import { MockQuoteProvider } from './providers/mock-quote.provider.js';
import { RealFXQuoteProvider } from './providers/real-fx-quote.provider.js';

export interface GenerateQuoteInput {
  sourceCurrency: string;
  destinationAsset: string;
  amount: number;
  side?: 'source' | 'destination';
}

export class QuoteService {
  private static activeProvider: QuoteProvider | null = null;

  public static setProvider(provider: QuoteProvider): void {
    this.activeProvider = provider;
  }

  public static getProvider(): QuoteProvider {
    if (this.activeProvider) {
      return this.activeProvider;
    }

    // Dependency injection selection logic:
    // If QUOTE_PROVIDER is set to 'mock' or NODE_ENV is 'test' (and not explicitly overridden to 'real')
    if (config.quotes.provider === 'mock' || (config.env === 'test' && process.env.QUOTE_PROVIDER !== 'real')) {
      this.activeProvider = new MockQuoteProvider();
    } else {
      this.activeProvider = new RealFXQuoteProvider();
    }

    return this.activeProvider;
  }

  static async createQuote(input: GenerateQuoteInput, userId?: string, ipAddress?: string) {
    if (!input.amount || typeof input.amount !== 'number' || input.amount <= 0 || !isFinite(input.amount) || isNaN(input.amount)) {
      throw new BadRequestError('Amount must be a positive number');
    }

    const provider = this.getProvider();
    const calculation = await provider.calculate(
      input.sourceCurrency,
      input.destinationAsset,
      input.amount,
      input.side || 'source'
    );

    // Calculate real expiry based on configured duration (default: 30 seconds)
    const expiryMs = (config.quotes.expirySeconds || 30) * 1000;
    const expiresAt = new Date(Date.now() + expiryMs);

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
        exchangeRate: quote.exchangeRate.toString(),
        fee: quote.fee.toString(),
        provider: quote.provider,
        rateTimestamp: calculation.rateTimestamp.toISOString(),
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

import { Prisma, QuoteStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, NotFoundError } from '../../errors/index.js';
import { AuditService } from '../audit/audit.service.js';
import { LiquidityService } from '../liquidity/liquidity.service.js';
import { config } from '../../config/index.js';
import { QuoteProvider } from './providers/quote-provider.interface.js';
import { MockQuoteProvider } from './providers/mock-quote.provider.js';
import { RealFXQuoteProvider } from './providers/real-fx-quote.provider.js';

export interface GenerateQuoteInput {
  sourceCurrency: string;
  destinationAsset: string;
  amount: number | string | Prisma.Decimal;
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

    if (config.quotes.provider === 'mock' || (config.env === 'test' && process.env.QUOTE_PROVIDER !== 'real')) {
      this.activeProvider = new MockQuoteProvider();
    } else {
      this.activeProvider = new RealFXQuoteProvider();
    }

    return this.activeProvider;
  }

  static async createQuote(input: GenerateQuoteInput, userId?: string, ipAddress?: string) {
    const rawAmountDec = new Prisma.Decimal(input.amount);

    if (rawAmountDec.isNaN() || !rawAmountDec.isFinite() || rawAmountDec.lte(0)) {
      throw new BadRequestError('Amount must be a positive number.');
    }

    // Currency pair validation
    const sourceCurrency = input.sourceCurrency.toUpperCase();
    const destinationAsset = input.destinationAsset.toUpperCase();

    const allowedPairs = ['NGN_USDC', 'NGN_USD', 'USDC_NGN', 'USD_NGN', 'NGN_XLM', 'XLM_NGN', 'USDC_XLM', 'XLM_USDC', 'NGN_NGN', 'USDC_USDC'];
    const pair = `${sourceCurrency}_${destinationAsset}`;
    if (!allowedPairs.includes(pair)) {
      throw new BadRequestError(`Unsupported currency pair: ${sourceCurrency} -> ${destinationAsset}`);
    }

    // Min/Max NGN limit check for NGN source
    if (sourceCurrency === 'NGN' && (input.side || 'source') === 'source') {
      if (rawAmountDec.lt(config.quotes.minNgnAmount)) {
        throw new BadRequestError(`Minimum transaction amount is ${config.quotes.minNgnAmount} NGN.`);
      }
      if (rawAmountDec.gt(config.quotes.maxNgnAmount)) {
        throw new BadRequestError(`Maximum transaction amount is ${config.quotes.maxNgnAmount} NGN.`);
      }
    }

    const provider = this.getProvider();
    const calculation = await provider.calculate(
      sourceCurrency,
      destinationAsset,
      rawAmountDec,
      input.side || 'source'
    );

    const destAmountDec = new Prisma.Decimal(calculation.destinationAmount);

    // Check maximum USDC output limit
    if (destinationAsset === 'USDC' && destAmountDec.gt(config.quotes.maxQuoteUsdcAmount)) {
      throw new BadRequestError(`Requested output exceeds maximum allowed quote size of ${config.quotes.maxQuoteUsdcAmount} USDC.`);
    }

    // Check liquidity availability without creating a reservation
    const availableLiquidity = await LiquidityService.getAvailableLiquidity(
      destinationAsset,
      config.stellar.network
    );
    const liquidityAvailable = availableLiquidity.gte(destAmountDec);

    // Calculate expiration timestamp (default: 300 seconds)
    const ttlSeconds = config.quotes.ttlSeconds || config.quotes.expirySeconds || 300;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const quote = await prisma.quote.create({
      data: {
        sourceCurrency,
        destinationAsset,
        sourceAmount: calculation.sourceAmount,
        destinationAmount: calculation.destinationAmount,
        exchangeRate: calculation.exchangeRate,
        fee: calculation.fee,
        grossUsdcAmount: calculation.grossUsdcAmount,
        networkFeeUsdc: calculation.networkFeeUsdc,
        spread: calculation.spread,
        baseFxRate: calculation.baseFxRate,
        rateTimestamp: calculation.rateTimestamp,
        liquidityAvailable,
        version: 1,
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
        grossUsdcAmount: quote.grossUsdcAmount?.toString() ?? null,
        spread: quote.spread?.toString() ?? null,
        baseFxRate: quote.baseFxRate?.toString() ?? null,
        liquidityAvailable: quote.liquidityAvailable,
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

    // Automatic expiration transition
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

    return prisma.quote.update({
      where: { id: quoteId },
      data: { status: QuoteStatus.USED },
    });
  }
}

import { OrderStatus, OrderType, TransactionType, TransactionStatus, QuoteStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { ConflictError, NotFoundError, ForbiddenError, BadRequestError } from '../../errors/index.js';
import { QuoteService } from '../quotes/quotes.service.js';
import { AuditService } from '../audit/audit.service.js';
import { LiquidityService } from '../liquidity/liquidity.service.js';
import { config } from '../../config/index.js';

export interface CreateOrderDTO {
  quoteId: string;
  type?: OrderType;
  walletAddress?: string;
  idempotencyKey?: string;
}

export class OrderService {
  static async createOrder(userId: string, dto: CreateOrderDTO, ipAddress?: string) {
    // Step 1: Idempotency Check
    if (dto.idempotencyKey) {
      const existingOrder = await prisma.order.findFirst({
        where: {
          userId,
          idempotencyKey: dto.idempotencyKey,
        },
        include: {
          quote: true,
          transactions: true,
          reservation: true,
        },
      });

      if (existingOrder) {
        return { order: existingOrder, isDuplicate: true };
      }
    }

    // Step 2: Validate Quote before starting transaction
    const quote = await QuoteService.getQuoteById(dto.quoteId);
    if (quote.status === QuoteStatus.EXPIRED || new Date() > quote.expiresAt) {
      throw new BadRequestError('Quote has expired.');
    }
    if (quote.status === QuoteStatus.USED) {
      throw new BadRequestError('Quote has already been used.');
    }
    if (quote.status === QuoteStatus.CANCELLED) {
      throw new BadRequestError('Quote has been cancelled.');
    }

    // Step 3: Ensure LiquidityPool exists for asset
    const pool = await LiquidityService.getPool(quote.destinationAsset, config.stellar.network);

    // Step 4: Atomic Order Creation & Liquidity Reservation
    const order = await prisma.$transaction(async (tx) => {
      // Mark Quote as USED within transaction
      await tx.quote.update({
        where: { id: quote.id },
        data: { status: QuoteStatus.USED },
      });

      const newOrder = await tx.order.create({
        data: {
          userId,
          quoteId: quote.id,
          idempotencyKey: dto.idempotencyKey || null,
          type: dto.type || OrderType.ON_RAMP,
          status: OrderStatus.CREATED,
          sourceCurrency: quote.sourceCurrency,
          destinationAsset: quote.destinationAsset,
          sourceAmount: quote.sourceAmount,
          destinationAmount: quote.destinationAmount,
          walletAddress: dto.walletAddress || null,
        },
        include: {
          quote: true,
        },
      });

      // Atomically reserve pool liquidity for this order (locks pool row with FOR UPDATE)
      await LiquidityService.reserveForOrderInTx(tx, {
        poolId: pool.id,
        orderId: newOrder.id,
        amount: quote.destinationAmount,
      });

      // Create initial application transaction record
      await tx.transaction.create({
        data: {
          userId,
          orderId: newOrder.id,
          type: dto.type === OrderType.OFF_RAMP ? TransactionType.WITHDRAWAL : TransactionType.DEPOSIT,
          status: TransactionStatus.PENDING,
          amount: quote.destinationAmount,
          asset: quote.destinationAsset,
        },
      });

      return newOrder;
    });

    // Step 5: Audit Log
    await AuditService.log({
      actor: userId,
      userId,
      action: 'ORDER_CREATED',
      resource: 'Order',
      resourceId: order.id,
      details: {
        type: order.type,
        status: order.status,
        sourceCurrency: order.sourceCurrency,
        destinationAsset: order.destinationAsset,
        idempotencyKey: order.idempotencyKey,
      },
      ipAddress,
    });

    return { order, isDuplicate: false };
  }

  static async getUserOrders(userId: string, limit = 50, offset = 0) {
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where: { userId },
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
        include: { quote: true, transactions: true },
      }),
      prisma.order.count({ where: { userId } }),
    ]);

    return { orders, total, limit, offset };
  }

  static async getOrderById(userId: string, orderId: string, isAdmin = false) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { quote: true, transactions: true, payments: true, settlements: true },
    });

    if (!order) {
      throw new NotFoundError('Order not found.');
    }

    if (!isAdmin && order.userId !== userId) {
      throw new ForbiddenError('Unauthorized access to this order.');
    }

    return order;
  }

  static async transitionOrderStatus(orderId: string, targetStatus: OrderStatus, actorId: string, ipAddress?: string) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundError('Order not found.');
    }

    const previousStatus = order.status;
    if (previousStatus === targetStatus) {
      return order;
    }

    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: { status: targetStatus },
    });

    await AuditService.log({
      actor: actorId,
      userId: order.userId,
      action: 'ORDER_STATUS_CHANGED',
      resource: 'Order',
      resourceId: order.id,
      details: {
        from: previousStatus,
        to: targetStatus,
      },
      ipAddress,
    });

    return updatedOrder;
  }

  static async updateOrderWallet(
    orderId: string,
    userId: string,
    walletAddress: string,
    isAdmin = false
  ) {
    const order = await this.getOrderById(userId, orderId, isAdmin);

    const isAlreadyCompleted =
      order.status === OrderStatus.COMPLETED ||
      order.status === OrderStatus.SETTLEMENT_COMPLETED;

    const hasSucceededPayment =
      order.payments?.some((p) => p.status === 'SUCCEEDED') ||
      order.status === OrderStatus.PAYMENT_CONFIRMED;

    const newStatus = isAlreadyCompleted
      ? order.status
      : hasSucceededPayment
      ? OrderStatus.SETTLEMENT_PENDING
      : order.status;

    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        walletAddress,
        status: newStatus,
      },
      include: {
        quote: true,
        transactions: true,
        payments: true,
        settlements: true,
      },
    });

    await AuditService.log({
      actor: userId,
      userId: order.userId,
      action: 'ORDER_WALLET_ATTACHED',
      resource: 'Order',
      resourceId: order.id,
      details: {
        walletAddress,
        status: newStatus,
      },
    });

    return updatedOrder;
  }
}

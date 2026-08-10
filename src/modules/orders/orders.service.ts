import { OrderStatus, OrderType, TransactionType, TransactionStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { ConflictError, NotFoundError, ForbiddenError, BadRequestError } from '../../errors/index.js';
import { QuoteService } from '../quotes/quotes.service.js';
import { AuditService } from '../audit/audit.service.js';

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
        },
      });

      if (existingOrder) {
        return { order: existingOrder, isDuplicate: true };
      }
    }

    // Step 2: Validate and Consume Quote
    const quote = await QuoteService.validateAndUseQuote(dto.quoteId);

    // Step 3: Create Order in DB
    const order = await prisma.$transaction(async (tx) => {
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

    // Step 4: Audit Log
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
}

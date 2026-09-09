import { Request, Response } from 'express';
import { RefundService } from './refunds.service.js';
import { createRefundSchema } from './refunds.schemas.js';
import { ValidationError, UnauthorizedError } from '../../errors/index.js';

export class RefundController {
  public static async createRefund(req: Request, res: Response): Promise<void> {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required.');
    }

    const parseResult = createRefundSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid refund request payload.', parseResult.error.format());
    }

    const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN';
    const idempotencyHeader = (req.headers['x-idempotency-key'] as string) || (req.headers['idempotency-key'] as string);

    const { refund, isDuplicate } = await RefundService.createRefund(
      req.user.id,
      parseResult.data,
      isAdmin,
      idempotencyHeader,
      req.ip
    );

    // If newly created, execute refund processing
    let finalRefund = refund;
    if (!isDuplicate && refund.status === 'PENDING') {
      finalRefund = await RefundService.executeRefund(refund.id, req.user.id, req.ip);
    }

    res.status(isDuplicate ? 200 : 201).json({
      success: true,
      isDuplicate,
      refund: {
        id: finalRefund.id,
        orderId: finalRefund.orderId,
        paymentId: finalRefund.paymentId,
        amount: finalRefund.amount.toString(),
        currency: finalRefund.currency,
        reason: finalRefund.reason,
        status: finalRefund.status,
        paystackRefundId: finalRefund.paystackRefundId,
        failureReason: finalRefund.failureReason,
        createdAt: finalRefund.createdAt,
        completedAt: finalRefund.completedAt,
      },
    });
  }

  public static async getRefund(req: Request, res: Response): Promise<void> {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required.');
    }

    const refundId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id) as string;
    const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN';

    const refund = await RefundService.getRefundById(refundId, req.user.id, isAdmin);

    res.status(200).json({
      success: true,
      refund,
    });
  }

  public static async listRefunds(req: Request, res: Response): Promise<void> {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required.');
    }

    const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN';
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const result = await RefundService.listRefunds(req.user.id, isAdmin, limit, offset);

    res.status(200).json({
      success: true,
      ...result,
    });
  }
}

import { Request, Response } from 'express';
import { PaymentService } from './payments.service.js';
import { createPaymentSchema, paymentIdParamSchema } from './payments.schemas.js';
import { Role } from '@prisma/client';
import { RefundService } from '../refunds/refunds.service.js';

export class PaymentController {
  public static async createPayment(req: Request, res: Response) {
    const validatedBody = createPaymentSchema.parse(req.body);
    const idempotencyKey = (req.headers['idempotency-key'] || req.headers['Idempotency-Key']) as string | undefined;

    const { payment, isDuplicate } = await PaymentService.createPayment(
      req.user!.id,
      validatedBody,
      idempotencyKey,
      req.ip
    );

    const statusCode = isDuplicate ? 200 : 201;
    let metadataParsed: Record<string, any> = {};
    if (payment.metadata) {
      try {
        metadataParsed = JSON.parse(payment.metadata);
      } catch {
        // ignore parse error
      }
    }

    res.status(statusCode).json({
      success: true,
      data: {
        paymentId: payment.id,
        id: payment.id,
        orderId: payment.orderId,
        provider: payment.provider,
        providerPaymentId: payment.providerPaymentId,
        type: payment.type,
        status: payment.status,
        amount: payment.amount.toString(),
        grossAmount: payment.grossAmount.toString(),
        providerFee: payment.providerFee.toString(),
        platformFee: payment.platformFee.toString(),
        netAmount: payment.netAmount.toString(),
        currency: payment.currency,
        reference: payment.reference,
        idempotencyKey: payment.idempotencyKey,
        instructions: metadataParsed.instructions || null,
        metadata: metadataParsed,
        createdAt: payment.createdAt,
      },
    });
  }

  public static async getPayment(req: Request, res: Response) {
    const { id } = paymentIdParamSchema.parse(req.params);
    const isAdmin = req.user?.role === Role.ADMIN || req.user?.role === Role.SUPER_ADMIN;

    const payment = await PaymentService.getPaymentById(id, req.user!.id, isAdmin);

    let metadataParsed: Record<string, any> = {};
    if (payment.metadata) {
      try {
        metadataParsed = JSON.parse(payment.metadata);
      } catch {
        // ignore parse error
      }
    }

    res.status(200).json({
      success: true,
      data: {
        paymentId: payment.id,
        id: payment.id,
        orderId: payment.orderId,
        provider: payment.provider,
        providerPaymentId: payment.providerPaymentId,
        type: payment.type,
        status: payment.status,
        amount: payment.amount.toString(),
        grossAmount: payment.grossAmount.toString(),
        providerFee: payment.providerFee.toString(),
        platformFee: payment.platformFee.toString(),
        netAmount: payment.netAmount.toString(),
        currency: payment.currency,
        reference: payment.reference,
        instructions: metadataParsed.instructions || null,
        metadata: metadataParsed,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
      },
    });
  }

  public static async verifyPayment(req: Request, res: Response) {
    const { id } = paymentIdParamSchema.parse(req.params);
    const isAdmin = req.user?.role === Role.ADMIN || req.user?.role === Role.SUPER_ADMIN;

    const payment = await PaymentService.verifyPayment(
      id,
      req.user!.id,
      isAdmin,
      req.body,
      req.ip
    );

    let metadataParsed: Record<string, any> = {};
    if (payment.metadata) {
      try {
        metadataParsed = JSON.parse(payment.metadata);
      } catch {
        // ignore parse error
      }
    }

    res.status(200).json({
      success: true,
      data: {
        paymentId: payment.id,
        id: payment.id,
        orderId: payment.orderId,
        provider: payment.provider,
        type: payment.type,
        status: payment.status,
        amount: payment.amount ? payment.amount.toString() : '0',
        grossAmount: payment.grossAmount ? payment.grossAmount.toString() : '0',
        providerFee: payment.providerFee ? payment.providerFee.toString() : '0',
        platformFee: payment.platformFee ? payment.platformFee.toString() : '0',
        netAmount: payment.netAmount ? payment.netAmount.toString() : '0',
        currency: payment.currency,
        reference: payment.reference,
        providerPaymentId: payment.providerPaymentId,
        instructions: metadataParsed.instructions || null,
        metadata: metadataParsed,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
      },
    });
  }

  public static async refundPayment(req: Request, res: Response) {
    const { id } = paymentIdParamSchema.parse(req.params);
    const isAdmin = req.user?.role === Role.ADMIN || req.user?.role === Role.SUPER_ADMIN;

    const payment = await PaymentService.getPaymentById(id, req.user!.id, isAdmin);
    const reason = req.body.reason || 'Admin initiated refund';
    const amount = req.body.amount;
    const idempotencyKey = (req.headers['idempotency-key'] || req.headers['x-idempotency-key']) as string | undefined;

    const { refund, isDuplicate } = await RefundService.createRefund(
      req.user!.id,
      {
        orderId: payment.orderId,
        paymentId: payment.id,
        amount,
        reason,
        idempotencyKey,
      },
      isAdmin,
      idempotencyKey,
      req.ip
    );

    let finalRefund = refund;
    if (!isDuplicate && refund.status === 'PENDING') {
      finalRefund = await RefundService.executeRefund(refund.id, req.user!.id, req.ip);
    }

    res.status(isDuplicate ? 200 : 201).json({
      success: true,
      isDuplicate,
      data: {
        refundId: finalRefund.id,
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
}

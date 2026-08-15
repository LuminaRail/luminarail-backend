import { Request, Response } from 'express';
import { PaymentService } from './payments.service.js';
import { createPaymentSchema, paymentIdParamSchema } from './payments.schemas.js';
import { Role } from '@prisma/client';

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
        status: payment.status,
        providerPaymentId: payment.providerPaymentId,
        instructions: metadataParsed.instructions || null,
        metadata: metadataParsed,
        updatedAt: payment.updatedAt,
      },
    });
  }
}

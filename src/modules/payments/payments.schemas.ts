import { z } from 'zod';
import { PaymentType } from '@prisma/client';

export const createPaymentSchema = z.object({
  orderId: z.string().uuid('orderId must be a valid UUID'),
  currency: z.string().min(3).max(5).default('NGN'),
  type: z.nativeEnum(PaymentType).default(PaymentType.DEPOSIT),
});

export const paymentIdParamSchema = z.object({
  id: z.string().uuid('Payment ID must be a valid UUID'),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

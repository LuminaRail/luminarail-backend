import { z } from 'zod';

export const createRefundSchema = z.object({
  orderId: z.string().uuid('orderId must be a valid UUID'),
  paymentId: z.string().uuid('paymentId must be a valid UUID').optional(),
  amount: z
    .string()
    .optional()
    .refine((val) => !val || (!isNaN(parseFloat(val)) && parseFloat(val) > 0), {
      message: 'amount must be a positive numeric string',
    }),
  reason: z.string().min(3, 'reason is required and must be at least 3 characters'),
  idempotencyKey: z.string().optional(),
});

export type CreateRefundInput = z.infer<typeof createRefundSchema>;

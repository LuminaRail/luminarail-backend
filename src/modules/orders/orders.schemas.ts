import { z } from 'zod';
import { OrderType, OrderStatus } from '@prisma/client';
import { StrKey } from '@stellar/stellar-sdk';

export const createOrderSchema = z.object({
  quoteId: z.string().uuid('Invalid quote ID format.'),
  type: z.nativeEnum(OrderType).optional().default(OrderType.ON_RAMP),
  walletAddress: z
    .string()
    .refine((val) => StrKey.isValidEd25519PublicKey(val), {
      message: 'Invalid Stellar wallet address format.',
    })
    .optional(),
  idempotencyKey: z.string().max(128).optional(),
});

export const orderIdParamSchema = z.object({
  id: z.string().uuid('Invalid order ID format.'),
});

export const updateOrderStatusSchema = z.object({
  status: z.nativeEnum(OrderStatus),
});

export const updateOrderWalletSchema = z.object({
  walletAddress: z.string().refine((val) => StrKey.isValidEd25519PublicKey(val), {
    message: 'Invalid Stellar wallet address format.',
  }),
});

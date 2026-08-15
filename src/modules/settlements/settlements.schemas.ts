import { z } from 'zod';
import { SettlementStatus } from '@prisma/client';

export const settlementIdParamSchema = z.object({
  id: z.string().uuid('Invalid settlement ID format'),
});

export const orderIdParamSchema = z.object({
  orderId: z.string().uuid('Invalid order ID format'),
});

export const createSettlementSchema = z.object({
  orderId: z.string().uuid('Invalid order ID format'),
});

export const listSettlementsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  status: z.nativeEnum(SettlementStatus).optional(),
});

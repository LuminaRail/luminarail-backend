import { z } from 'zod';

export const createQuoteSchema = z.object({
  sourceCurrency: z.string().min(2).max(10).toUpperCase(),
  destinationAsset: z.string().min(2).max(20).toUpperCase(),
  amount: z.number().positive('Amount must be positive.'),
  side: z.enum(['source', 'destination']).optional().default('source'),
});

export const quoteQuerySchema = z.object({
  sourceCurrency: z.string().min(2).max(10).toUpperCase(),
  destinationAsset: z.string().min(2).max(20).toUpperCase(),
  amount: z.string().transform((val) => parseFloat(val)).refine((val) => !isNaN(val) && val > 0, {
    message: 'Amount must be a positive number.',
  }),
  side: z.enum(['source', 'destination']).optional().default('source'),
});

export const quoteIdParamSchema = z.object({
  id: z.string().uuid('Invalid quote ID format.'),
});

import { z } from 'zod';
import { Role } from '@prisma/client';

export const registerSchema = z.object({
  email: z.string().email('Invalid email address format.'),
  password: z.string().min(8, 'Password must be at least 8 characters long.'),
  phone: z.string().optional(),
  role: z.nativeEnum(Role).optional().default(Role.USER),
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email address format.'),
  password: z.string().min(1, 'Password is required.'),
});

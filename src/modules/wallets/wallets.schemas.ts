import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';

export const createWalletSchema = z.object({
  address: z.string().refine((val) => StrKey.isValidEd25519PublicKey(val), {
    message: 'Invalid Stellar public key address format.',
  }),
  label: z.string().max(50).optional().default('Main Wallet'),
  network: z.string().optional().default('testnet'),
});

export const walletIdParamSchema = z.object({
  id: z.string().uuid('Invalid wallet ID format.'),
});

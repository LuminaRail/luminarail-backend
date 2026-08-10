import { Router, Request, Response, NextFunction } from 'express';
import { getStellarAccountService } from '../accounts/account.service.js';
import { getStellarTransactionService } from '../transactions/transaction.service.js';
import { getStellarCache } from '../cache/cache.service.js';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { StrKey } from '@stellar/stellar-sdk';

export const stellarRouter = Router();

const addressParamSchema = z.object({
  address: z.string().refine((val) => StrKey.isValidEd25519PublicKey(val), {
    message: 'Invalid Stellar public address format.',
  }),
});

const txHashParamSchema = z.object({
  hash: z.string().regex(/^[0-9a-fA-F]{64}$/, 'Invalid Stellar transaction hash format. Expected 64 hex characters.'),
});

// GET /api/v1/stellar/accounts/:address
stellarRouter.get(
  '/accounts/:address',
  validate({ params: addressParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const address = req.params.address as string;
      const cache = getStellarCache();
      const cacheKey = `stellar:account:${address}`;

      const cached = await cache.get(cacheKey);
      if (cached) {
        res.status(200).json({ success: true, data: cached });
        return;
      }

      const accountService = getStellarAccountService();
      const accountDetails = await accountService.getAccountDetails(address);
      await cache.set(cacheKey, accountDetails, 15);

      res.status(200).json({ success: true, data: accountDetails });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/stellar/accounts/:address/balances
stellarRouter.get(
  '/accounts/:address/balances',
  validate({ params: addressParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const address = req.params.address as string;
      const cache = getStellarCache();
      const cacheKey = `stellar:balances:${address}`;

      const cached = await cache.get(cacheKey);
      if (cached) {
        res.status(200).json({ success: true, data: cached });
        return;
      }

      const accountService = getStellarAccountService();
      const accountDetails = await accountService.getAccountDetails(address);
      await cache.set(cacheKey, accountDetails.balances, 15);

      res.status(200).json({ success: true, data: accountDetails.balances });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/stellar/transactions/:hash
stellarRouter.get(
  '/transactions/:hash',
  validate({ params: txHashParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const hash = req.params.hash as string;
      const txService = getStellarTransactionService();
      const tx = await txService.getTransaction(hash);

      res.status(200).json({ success: true, data: tx });
    } catch (err) {
      next(err);
    }
  }
);

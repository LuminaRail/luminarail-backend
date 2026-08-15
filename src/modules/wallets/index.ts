import { Router, Request, Response, NextFunction } from 'express';
import { WalletService } from './wallets.service.js';
import { authenticateToken } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { createWalletSchema, walletIdParamSchema } from './wallets.schemas.js';

export const walletsRouter = Router();

walletsRouter.use(authenticateToken);

walletsRouter.post(
  '/',
  validate({ body: createWalletSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const wallet = await WalletService.createWallet(req.user!.id, req.body, req.ip);
      res.status(201).json({
        success: true,
        data: wallet,
      });
    } catch (err) {
      next(err);
    }
  }
);

walletsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const wallets = await WalletService.listUserWallets(req.user!.id);
    res.status(200).json({
      success: true,
      data: wallets,
    });
  } catch (err) {
    next(err);
  }
});

walletsRouter.delete(
  '/:id',
  validate({ params: walletIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await WalletService.deleteWallet(req.user!.id, req.params.id as string, req.ip);
      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }
);

import { Router, Request, Response, NextFunction } from 'express';
import { TransactionService } from './transactions.service.js';
import { authenticateToken } from '../../middleware/auth.js';

export const transactionsRouter = Router();

transactionsRouter.use(authenticateToken);

transactionsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const result = await TransactionService.getUserTransactions(req.user!.id, limit, offset);
    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

transactionsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isAdmin = req.user!.role === 'ADMIN' || req.user!.role === 'SUPER_ADMIN';
    const tx = await TransactionService.getTransactionById(req.user!.id, req.params.id as string, isAdmin);
    res.status(200).json({
      success: true,
      data: tx,
    });
  } catch (err) {
    next(err);
  }
});

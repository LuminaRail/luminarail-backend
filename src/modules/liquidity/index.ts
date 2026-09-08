import { Router, Request, Response, NextFunction } from 'express';
import { authenticateToken, requireRole } from '../../middleware/auth.js';
import { LiquidityService } from './liquidity.service.js';
import { prisma } from '../../db/prisma.js';
import { TreasuryTransactionType } from '@prisma/client';

export const liquidityRouter = Router();

// Internal Admin Routes Only
liquidityRouter.use(authenticateToken);
liquidityRouter.use(requireRole('ADMIN', 'SUPER_ADMIN'));

/**
 * GET /api/v1/liquidity/pools
 * Admin endpoint to list treasury liquidity pools.
 */
liquidityRouter.get('/pools', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const pools = await prisma.liquidityPool.findMany({
      include: {
        _count: {
          select: { reservations: true, transactions: true },
        },
      },
    });

    res.json({
      success: true,
      data: pools,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/liquidity/pools/:id/adjust
 * Admin endpoint to record manual adjustments or replenishments.
 */
liquidityRouter.post('/pools/:id/adjust', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const poolId = String(req.params.id);
    const { type, amount, externalRef, stellarTxHash } = req.body;

    const txType = (type || 'MANUAL_ADJUSTMENT') as TreasuryTransactionType;

    const transaction = await LiquidityService.recordTreasuryTransaction(
      poolId,
      txType,
      amount,
      externalRef,
      stellarTxHash
    );

    const updatedPool = await prisma.liquidityPool.findUnique({ where: { id: poolId } });

    res.json({
      success: true,
      data: {
        transaction,
        pool: updatedPool,
      },
    });
  } catch (err) {
    next(err);
  }
});

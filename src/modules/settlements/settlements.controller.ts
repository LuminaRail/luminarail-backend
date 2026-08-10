import { Request, Response, NextFunction } from 'express';
import { SettlementService } from './settlements.service.js';
import {
  settlementIdParamSchema,
  orderIdParamSchema,
  listSettlementsQuerySchema,
} from './settlements.schemas.js';

export class SettlementController {
  public static async getSettlementById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = settlementIdParamSchema.parse(req.params);
      const userId = req.user?.id;
      const isAdmin = req.user?.role === 'ADMIN' || req.user?.role === 'SUPER_ADMIN';

      const settlement = await SettlementService.getSettlementById(id, userId, isAdmin);

      res.status(200).json({
        success: true,
        data: settlement,
      });
    } catch (err) {
      next(err);
    }
  }

  public static async getSettlementByOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { orderId } = orderIdParamSchema.parse(req.params);
      const userId = req.user?.id;
      const isAdmin = req.user?.role === 'ADMIN' || req.user?.role === 'SUPER_ADMIN';

      const settlement = await SettlementService.getSettlementByOrder(orderId, userId, isAdmin);

      res.status(200).json({
        success: true,
        data: settlement,
      });
    } catch (err) {
      next(err);
    }
  }

  public static async listPendingSettlements(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { limit, offset } = listSettlementsQuerySchema.parse(req.query);

      const result = await SettlementService.listPendingSettlements(limit, offset);

      res.status(200).json({
        success: true,
        data: result.settlements,
        pagination: {
          total: result.total,
          limit: result.limit,
          offset: result.offset,
        },
      });
    } catch (err) {
      next(err);
    }
  }
}

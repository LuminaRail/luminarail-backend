import { Router, Request, Response, NextFunction } from 'express';
import { OrderService } from './orders.service.js';
import { authenticateToken } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { createOrderSchema, orderIdParamSchema } from './orders.schemas.js';

export const ordersRouter = Router();

ordersRouter.use(authenticateToken);

ordersRouter.post(
  '/',
  validate({ body: createOrderSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const idempotencyKey =
        (req.headers['idempotency-key'] as string) || req.body.idempotencyKey;

      const { order, isDuplicate } = await OrderService.createOrder(
        req.user!.id,
        { ...req.body, idempotencyKey },
        req.ip
      );

      res.status(isDuplicate ? 200 : 201).json({
        success: true,
        data: order,
      });
    } catch (err) {
      next(err);
    }
  }
);

ordersRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const result = await OrderService.getUserOrders(req.user!.id, limit, offset);
    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

ordersRouter.get(
  '/:id',
  validate({ params: orderIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const isAdmin = req.user!.role === 'ADMIN' || req.user!.role === 'SUPER_ADMIN';
      const order = await OrderService.getOrderById(req.user!.id, req.params.id as string, isAdmin);
      res.status(200).json({
        success: true,
        data: order,
      });
    } catch (err) {
      next(err);
    }
  }
);

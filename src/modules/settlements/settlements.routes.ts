import { Router } from 'express';
import { Role } from '@prisma/client';
import { authenticateToken, requireRole } from '../../middleware/auth.js';
import { SettlementController } from './settlements.controller.js';

export const settlementsRouter = Router();

settlementsRouter.get(
  '/',
  authenticateToken,
  requireRole(Role.ADMIN, Role.SUPER_ADMIN),
  SettlementController.listPendingSettlements
);

settlementsRouter.get(
  '/:id',
  authenticateToken,
  SettlementController.getSettlementById
);

settlementsRouter.get(
  '/order/:orderId',
  authenticateToken,
  SettlementController.getSettlementByOrder
);

import { Router } from 'express';
import { authenticateToken, requireRole } from '../../middleware/auth.js';
import { Role } from '@prisma/client';
import { RefundController } from './refunds.controller.js';

export const refundsRouter = Router();

refundsRouter.use(authenticateToken);

refundsRouter.post('/', requireRole(Role.ADMIN, Role.SUPER_ADMIN), (req, res, next) => {
  RefundController.createRefund(req, res).catch(next);
});

refundsRouter.get('/:id', (req, res, next) => {
  RefundController.getRefund(req, res).catch(next);
});

refundsRouter.get('/', (req, res, next) => {
  RefundController.listRefunds(req, res).catch(next);
});

export { RefundService } from './refunds.service.js';
export { RefundStateMachine } from './refund.state-machine.js';

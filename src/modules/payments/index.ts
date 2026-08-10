import { Router } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { PaymentController } from './payments.controller.js';

export const paymentsRouter = Router();

paymentsRouter.use(authenticateToken);

paymentsRouter.post('/', (req, res, next) => {
  PaymentController.createPayment(req, res).catch(next);
});

paymentsRouter.get('/:id', (req, res, next) => {
  PaymentController.getPayment(req, res).catch(next);
});

paymentsRouter.post('/:id/verify', (req, res, next) => {
  PaymentController.verifyPayment(req, res).catch(next);
});

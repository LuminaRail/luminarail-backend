import { Router } from 'express';

export const paymentsRouter = Router();

paymentsRouter.post('/initiate', (_req, res) => {
  res.status(200).json({ message: 'Payments module initiate endpoint foundation' });
});

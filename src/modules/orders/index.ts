import { Router } from 'express';

export const ordersRouter = Router();

ordersRouter.get('/', (_req, res) => {
  res.status(200).json({ message: 'Orders module list endpoint foundation' });
});

ordersRouter.post('/', (_req, res) => {
  res.status(200).json({ message: 'Orders module create endpoint foundation' });
});

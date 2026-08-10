import { Router } from 'express';

export const merchantsRouter = Router();

merchantsRouter.get('/dashboard', (_req, res) => {
  res.status(200).json({ message: 'Merchants module dashboard endpoint foundation' });
});

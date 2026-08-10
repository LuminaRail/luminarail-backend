import { Router } from 'express';

export const walletsRouter = Router();

walletsRouter.get('/', (_req, res) => {
  res.status(200).json({ message: 'Wallets module list endpoint foundation' });
});

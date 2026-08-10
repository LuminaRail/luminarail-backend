import { Router } from 'express';

export const settlementsRouter = Router();

settlementsRouter.get('/', (_req, res) => {
  res.status(200).json({ message: 'Settlements module list endpoint foundation' });
});

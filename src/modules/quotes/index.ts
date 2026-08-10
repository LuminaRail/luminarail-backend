import { Router } from 'express';

export const quotesRouter = Router();

quotesRouter.post('/', (_req, res) => {
  res.status(200).json({ message: 'Quotes module create quote endpoint foundation' });
});

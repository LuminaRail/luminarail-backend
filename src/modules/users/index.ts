import { Router } from 'express';

export const usersRouter = Router();

usersRouter.get('/me', (_req, res) => {
  res.status(200).json({ message: 'Users module me endpoint foundation' });
});

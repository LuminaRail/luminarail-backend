import { Router } from 'express';

export const authRouter = Router();

authRouter.post('/register', (_req, res) => {
  res.status(200).json({ message: 'Auth module register endpoint foundation' });
});

authRouter.post('/login', (_req, res) => {
  res.status(200).json({ message: 'Auth module login endpoint foundation' });
});

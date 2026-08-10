import { Router } from 'express';

export const webhooksRouter = Router();

webhooksRouter.post('/provider-callback', (_req, res) => {
  res.status(200).json({ message: 'Webhooks module callback endpoint foundation' });
});

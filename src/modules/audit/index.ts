import { Router } from 'express';

export const auditRouter = Router();

auditRouter.get('/logs', (_req, res) => {
  res.status(200).json({ message: 'Audit module logs endpoint foundation' });
});

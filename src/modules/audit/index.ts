import { Router, Request, Response, NextFunction } from 'express';
import { AuditService } from './audit.service.js';
import { authenticateToken, requireRole } from '../../middleware/auth.js';

export const auditRouter = Router();

auditRouter.use(authenticateToken);
auditRouter.use(requireRole('ADMIN', 'SUPER_ADMIN'));

auditRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const result = await AuditService.listLogs(limit, offset);
    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

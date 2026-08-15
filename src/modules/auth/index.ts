import { Router, Request, Response, NextFunction } from 'express';
import { AuthService } from './auth.service.js';
import { validate } from '../../middleware/validate.js';
import { registerSchema, loginSchema } from './auth.schemas.js';

export const authRouter = Router();

authRouter.post(
  '/register',
  validate({ body: registerSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await AuthService.register(req.body, req.ip);
      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }
);

authRouter.post(
  '/login',
  validate({ body: loginSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await AuthService.login(req.body, req.ip);
      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }
);

authRouter.post('/logout', (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: 'Logged out successfully.',
  });
});

import { Router, Request, Response, NextFunction } from 'express';
import { UserService } from './users.service.js';
import { authenticateToken } from '../../middleware/auth.js';

export const usersRouter = Router();

usersRouter.get('/me', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await UserService.getUserProfile(req.user!.id);
    res.status(200).json({
      success: true,
      data: user,
    });
  } catch (err) {
    next(err);
  }
});

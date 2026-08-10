import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { config } from '../config/index.js';
import { UnauthorizedError, ForbiddenError } from '../errors/index.js';
import { AuthUserPayload } from '../types/express.js';

export function authenticateToken(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new UnauthorizedError('Authentication token is required.');
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, config.jwt.secret) as AuthUserPayload;
    if (!payload || !payload.id || !payload.role) {
      throw new UnauthorizedError('Invalid authentication token payload.');
    }
    if (payload.status === 'SUSPENDED') {
      throw new ForbiddenError('User account is suspended.');
    }
    req.user = payload;
    next();
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof UnauthorizedError) {
      next(err);
    } else {
      next(new UnauthorizedError('Invalid or expired authentication token.'));
    }
  }
}

export function requireRole(...allowedRoles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required.');
    }
    if (!allowedRoles.includes(req.user.role)) {
      throw new ForbiddenError(`Access denied. Requires one of the following roles: ${allowedRoles.join(', ')}`);
    }
    next();
  };
}

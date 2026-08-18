import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { logger } from '../utils/logger';

export const requestContextStore = new AsyncLocalStorage<{ requestId: string }>();

export const requestIdMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const startTime = Date.now();
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();

  res.setHeader('X-Request-ID', requestId);
(req as Request & { requestId?: string }).requestId = requestId;
  // Log request duration on finish
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info('HTTP Request Handled', {
      path: req.originalUrl || req.url,
      method: req.method,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
    });
  });

  requestContextStore.run({ requestId }, () => {
    next();
  });
};
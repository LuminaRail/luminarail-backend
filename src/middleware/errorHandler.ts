import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/index.js';
import { config } from '../config/index.js';
import { Prisma } from '@prisma/client';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.errorCode,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATE_ENTRY',
          message: 'A record with this unique identifier already exists.',
        },
      });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Target record not found in database.',
        },
      });
      return;
    }
    res.status(400).json({
      success: false,
      error: {
        code: 'DATABASE_ERROR',
        message: 'Database operation failed.',
      },
    });
    return;
  }

  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'Invalid JSON payload in request body.',
      },
    });
    return;
  }

  const httpStatus = (err as { statusCode?: number; status?: number }).statusCode || (err as { statusCode?: number; status?: number }).status;
  if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500) {
    res.status(httpStatus).json({
      success: false,
      error: {
        code: httpStatus === 401 ? 'UNAUTHORIZED' : httpStatus === 403 ? 'FORBIDDEN' : 'BAD_REQUEST',
        message: err.message || 'Invalid request.',
      },
    });
    return;
  }

  if (config.env !== 'test') {
    console.error('Unhandled Error:', err);
  }

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: config.env === 'production' ? 'An unexpected error occurred.' : err.message,
    },
  });
}

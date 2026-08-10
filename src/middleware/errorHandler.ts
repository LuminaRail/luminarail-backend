import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/index.js';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
    });
    return;
  }

  console.error('Unhandled Error:', err);
  res.status(500).json({
    status: 'error',
    message: 'Internal server error',
  });
}

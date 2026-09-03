import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { validate } from '../src/middleware/validate.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { AppError, ValidationError } from '../src/errors/index.js';
import { Request, Response } from 'express';

describe('Middleware Unit Tests', () => {
  describe('validate middleware', () => {
    it('should call next() when request body matches schema', async () => {
      const schema = {
        body: z.object({
          amount: z.number().positive(),
        }),
      };
      const req = { body: { amount: 100 } } as Request;
      const res = {} as Response;
      const next = vi.fn();

      const middleware = validate(schema);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.body).toEqual({ amount: 100 });
    });

    it('should throw ValidationError when request body is invalid', async () => {
      const schema = {
        body: z.object({
          amount: z.number().positive(),
        }),
      };
      const req = { body: { amount: -50 } } as Request;
      const res = {} as Response;
      const next = vi.fn();

      const middleware = validate(schema);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      const err = next.mock.calls[0][0];
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.statusCode).toBe(400);
      expect(err.details).toHaveLength(1);
    });
  });

  describe('errorHandler middleware', () => {
    it('should format AppError correctly', () => {
      const err = new AppError('Resource not found', 404, 'NOT_FOUND');
      const req = {} as Request;
      const statusFn = vi.fn().mockReturnThis();
      const jsonFn = vi.fn();
      const res = { status: statusFn, json: jsonFn } as unknown as Response;
      const next = vi.fn();

      errorHandler(err, req, res, next);

      expect(statusFn).toHaveBeenCalledWith(404);
      expect(jsonFn).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found',
        },
      });
    });

    it('should handle unhandled internal server errors', () => {
      const err = new Error('Unexpected crash');
      const req = {} as Request;
      const statusFn = vi.fn().mockReturnThis();
      const jsonFn = vi.fn();
      const res = { status: statusFn, json: jsonFn } as unknown as Response;
      const next = vi.fn();

      errorHandler(err, req, res, next);

      expect(statusFn).toHaveBeenCalledWith(500);
      expect(jsonFn).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Unexpected crash',
        },
      });
    });
  });
});

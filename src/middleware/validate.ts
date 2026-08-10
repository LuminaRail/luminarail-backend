import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { ValidationError } from '../errors/index.js';

interface RequestValidationSchema {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
  headers?: ZodSchema;
}

export function validate(schema: RequestValidationSchema) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (schema.body) {
        req.body = await schema.body.parseAsync(req.body);
      }
      if (schema.query) {
        req.query = await schema.query.parseAsync(req.query);
      }
      if (schema.params) {
        req.params = await schema.params.parseAsync(req.params);
      }
      if (schema.headers) {
        await schema.headers.parseAsync(req.headers);
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const issues = err.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        }));
        next(new ValidationError('Invalid request input data.', issues));
      } else {
        next(err);
      }
    }
  };
}

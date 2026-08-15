import { Router, Request, Response, NextFunction } from 'express';
import { QuoteService } from './quotes.service.js';
import { validate } from '../../middleware/validate.js';
import { createQuoteSchema, quoteQuerySchema, quoteIdParamSchema } from './quotes.schemas.js';

export const quotesRouter = Router();

// GET /api/v1/quotes (Query parameters) OR POST /api/v1/quotes (Body parameters)
quotesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.query.sourceCurrency && req.query.destinationAsset && req.query.amount) {
      const queryData = await quoteQuerySchema.parseAsync(req.query);
      const quote = await QuoteService.createQuote(queryData, req.user?.id, req.ip);
      res.status(200).json({
        success: true,
        data: quote,
      });
      return;
    }
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Query parameters sourceCurrency, destinationAsset, and amount are required.',
      },
    });
  } catch (err) {
    next(err);
  }
});

quotesRouter.post(
  '/',
  validate({ body: createQuoteSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const quote = await QuoteService.createQuote(req.body, req.user?.id, req.ip);
      res.status(201).json({
        success: true,
        data: quote,
      });
    } catch (err) {
      next(err);
    }
  }
);

quotesRouter.get(
  '/:id',
  validate({ params: quoteIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const quote = await QuoteService.getQuoteById(req.params.id as string);
      res.status(200).json({
        success: true,
        data: quote,
      });
    } catch (err) {
      next(err);
    }
  }
);

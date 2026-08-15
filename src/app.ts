import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import { stellarConfig, getSorobanClient } from './stellar/index.js';

import { authRouter } from './modules/auth/index.js';
import { usersRouter } from './modules/users/index.js';
import { walletsRouter } from './modules/wallets/index.js';
import { quotesRouter } from './modules/quotes/index.js';
import { ordersRouter } from './modules/orders/index.js';
import { transactionsRouter } from './modules/transactions/index.js';
import { paymentsRouter } from './modules/payments/index.js';
import { settlementsRouter } from './modules/settlements/index.js';
import { merchantsRouter } from './modules/merchants/index.js';
import { webhooksRouter } from './modules/webhooks/index.js';
import { auditRouter } from './modules/audit/index.js';
import { stellarRouter } from './stellar/routes/index.js';

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  // Rate Limiting
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per window
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests, please try again later.',
      },
    },
  });

  if (config.env !== 'test') {
    app.use(limiter);
  }

  // Extended Health Endpoint with Stellar Connectivity Status
  app.get('/health', async (_req, res) => {
    let stellarStatus = 'healthy';
    let latestLedger: number | undefined;

    try {
      if (config.env !== 'test') {
        const soroban = getSorobanClient();
        latestLedger = await soroban.getLatestLedger();
      }
    } catch {
      stellarStatus = 'unreachable';
    }

    res.status(200).json({
      status: 'ok',
      service: 'luminarail-backend',
      environment: config.env,
      timestamp: new Date().toISOString(),
      stellar: {
        network: stellarConfig.network,
        status: stellarStatus,
        ...(latestLedger !== undefined ? { latestLedger } : {}),
      },
    });
  });

  // API V1 Routes
  const api = express.Router();
  api.use('/auth', authRouter);
  api.use('/users', usersRouter);
  api.use('/wallets', walletsRouter);
  api.use('/quotes', quotesRouter);
  api.use('/orders', ordersRouter);
  api.use('/transactions', transactionsRouter);
  api.use('/payments', paymentsRouter);
  api.use('/settlements', settlementsRouter);
  api.use('/merchants', merchantsRouter);
  api.use('/webhooks', webhooksRouter);
  api.use('/audit', auditRouter);
  api.use('/stellar', stellarRouter);

  app.use(config.apiPrefix, api);

  // Centralized Error Handling Middleware
  app.use(errorHandler);

  return app;
}

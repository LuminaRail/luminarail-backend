import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/index.js';
import { errorHandler } from './middleware/errorHandler.js';

import { authRouter } from './modules/auth/index.js';
import { usersRouter } from './modules/users/index.js';
import { walletsRouter } from './modules/wallets/index.js';
import { quotesRouter } from './modules/quotes/index.js';
import { ordersRouter } from './modules/orders/index.js';
import { paymentsRouter } from './modules/payments/index.js';
import { settlementsRouter } from './modules/settlements/index.js';
import { merchantsRouter } from './modules/merchants/index.js';
import { webhooksRouter } from './modules/webhooks/index.js';
import { auditRouter } from './modules/audit/index.js';

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'luminarail-backend', timestamp: new Date().toISOString() });
  });

  const api = express.Router();
  api.use('/auth', authRouter);
  api.use('/users', usersRouter);
  api.use('/wallets', walletsRouter);
  api.use('/quotes', quotesRouter);
  api.use('/orders', ordersRouter);
  api.use('/payments', paymentsRouter);
  api.use('/settlements', settlementsRouter);
  api.use('/merchants', merchantsRouter);
  api.use('/webhooks', webhooksRouter);
  api.use('/audit', auditRouter);

  app.use(config.apiPrefix, api);

  app.use(errorHandler);

  return app;
}

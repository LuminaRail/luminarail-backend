import { Router, Request, Response } from 'express';
import { WebhookService } from './webhooks.service.js';
import { WebhookVerificationError } from '../../errors/index.js';

export const webhooksRouter = Router();

webhooksRouter.post('/:provider', (req: Request, res: Response, next) => {
  const providerParam = req.params.provider as string;
  const rawBody = req.rawBody;

  if (!rawBody || rawBody.length === 0) {
    return next(new WebhookVerificationError('Raw request body is missing for webhook verification'));
  }

  WebhookService.processWebhook(
    providerParam,
    req.headers,
    req.body,
    rawBody,
    req.ip
  )
    .then((result) => {
      res.status(200).json(result);
    })
    .catch(next);
});

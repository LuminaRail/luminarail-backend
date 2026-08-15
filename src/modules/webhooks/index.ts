import { Router, Request, Response } from 'express';
import { WebhookService } from './webhooks.service.js';

export const webhooksRouter = Router();

webhooksRouter.post('/:provider', (req: Request, res: Response, next) => {
  const providerParam = req.params.provider as string;
  const rawBody = (req as any).rawBody || JSON.stringify(req.body);

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

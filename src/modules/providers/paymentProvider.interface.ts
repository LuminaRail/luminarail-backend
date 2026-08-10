import { PaymentStatus, PaymentType } from '@prisma/client';

export interface CreatePaymentRequest {
  orderId: string;
  userId: string;
  amount: string;
  currency: string;
  type: PaymentType;
  reference: string;
  metadata?: Record<string, unknown>;
}

export interface NormalizedPaymentResponse {
  provider: string;
  providerPaymentId: string;
  status: PaymentStatus;
  amount: string;
  currency: string;
  redirectUrl?: string;
  metadata?: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
}

export interface CreatePayoutRequest {
  payoutId: string;
  userId: string;
  amount: string;
  currency: string;
  destinationAccount: string;
  destinationBankCode?: string;
  reference: string;
  metadata?: Record<string, unknown>;
}

export interface NormalizedPayoutResponse {
  provider: string;
  providerPayoutId: string;
  status: PaymentStatus;
  amount: string;
  currency: string;
  metadata?: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
}

export interface WebhookEventPayload {
  eventId: string;
  eventType: string;
  providerPaymentId: string;
  status: PaymentStatus;
  payload: Record<string, unknown>;
}

export interface IPaymentProvider {
  readonly providerId: string;
  readonly supportedCurrencies: string[];

  createPayment(request: CreatePaymentRequest): Promise<NormalizedPaymentResponse>;
  getPaymentStatus(providerPaymentId: string): Promise<NormalizedPaymentResponse>;
  verifyPayment(providerPaymentId: string, params?: Record<string, unknown>): Promise<NormalizedPaymentResponse>;
  createPayout(request: CreatePayoutRequest): Promise<NormalizedPayoutResponse>;
  getPayoutStatus(providerPayoutId: string): Promise<NormalizedPayoutResponse>;
  verifyWebhookSignature(headers: Record<string, string | string[] | undefined>, rawBody: string | Buffer): boolean;
  parseWebhookEvent(headers: Record<string, string | string[] | undefined>, body: any): WebhookEventPayload;
}

export interface PaymentRequest {
  orderId: string;
  amount: number;
  currency: string;
  customerEmail: string;
  reference: string;
}

export interface PaymentResponse {
  providerReference: string;
  status: 'pending' | 'successful' | 'failed';
  redirectUrl?: string;
  rawResponse?: Record<string, unknown>;
}

export interface PayoutRequest {
  payoutId: string;
  amount: number;
  currency: string;
  destinationAccount: string;
  destinationBankCode?: string;
  reference: string;
}

export interface PayoutResponse {
  providerReference: string;
  status: 'pending' | 'successful' | 'failed';
  rawResponse?: Record<string, unknown>;
}

export interface IPaymentProvider {
  readonly providerId: string;
  readonly supportedCurrencies: string[];

  initiatePayment(request: PaymentRequest): Promise<PaymentResponse>;
  verifyPayment(reference: string): Promise<PaymentResponse>;
  initiatePayout(request: PayoutRequest): Promise<PayoutResponse>;
}

import {
  IPaymentProvider,
  PaymentRequest,
  PaymentResponse,
  PayoutRequest,
  PayoutResponse,
} from './paymentProvider.interface.js';

export * from './paymentProvider.interface.js';

export class MockPaymentProvider implements IPaymentProvider {
  public readonly providerId = 'mock_provider';
  public readonly supportedCurrencies = ['NGN', 'USD'];

  async initiatePayment(request: PaymentRequest): Promise<PaymentResponse> {
    return {
      providerReference: `MOCK_PAY_${Date.now()}`,
      status: 'pending',
      redirectUrl: `https://checkout.mockprovider.local/pay/${request.reference}`,
    };
  }

  async verifyPayment(reference: string): Promise<PaymentResponse> {
    return {
      providerReference: `MOCK_VERIFY_${reference}`,
      status: 'successful',
    };
  }

  async initiatePayout(request: PayoutRequest): Promise<PayoutResponse> {
    return {
      providerReference: `MOCK_OUT_${request.reference}`,
      status: 'successful',
    };
  }
}

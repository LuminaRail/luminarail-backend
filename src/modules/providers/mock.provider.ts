import { PaymentStatus } from '@prisma/client';
import {
  IPaymentProvider,
  CreatePaymentRequest,
  NormalizedPaymentResponse,
  CreatePayoutRequest,
  NormalizedPayoutResponse,
  WebhookEventPayload,
} from './paymentProvider.interface.js';
import { WebhookVerificationError } from '../../errors/index.js';

/**
 * MockPaymentProvider — SANDBOX & TEST ONLY PAYMENT PROVIDER
 *
 * Deterministic mock implementation used for local development and testing.
 * Maintains an in-memory test-only store to preserve created payment amounts/currencies
 * and enforce provider-side idempotency for duplicate references.
 *
 * NEVER connects to external payment APIs or real-money networks.
 */
export class MockPaymentProvider implements IPaymentProvider {
  public readonly providerId = 'MOCK';
  public readonly supportedCurrencies = ['NGN', 'USD'];

  // Test-only in-memory store mapping reference and providerPaymentId to normalized payment details
  private static mockStoreByReference: Map<string, NormalizedPaymentResponse> = new Map();
  private static mockStoreById: Map<string, NormalizedPaymentResponse> = new Map();

  /**
   * Clears the in-memory sandbox store. Suitable for test cleanup.
   */
  public static clearMockStore(): void {
    this.mockStoreByReference.clear();
    this.mockStoreById.clear();
  }

  public async createPayment(request: CreatePaymentRequest): Promise<NormalizedPaymentResponse> {
    // Check provider-side idempotency by reference
    if (MockPaymentProvider.mockStoreByReference.has(request.reference)) {
      return MockPaymentProvider.mockStoreByReference.get(request.reference)!;
    }

    const isSimulatedFailure = request.reference.includes('fail_');
    const status: PaymentStatus = isSimulatedFailure ? PaymentStatus.FAILED : PaymentStatus.PENDING;
    const providerPaymentId = `mock_pay_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const response: NormalizedPaymentResponse = {
      provider: this.providerId,
      providerPaymentId,
      status,
      amount: request.amount,
      currency: request.currency,
      instructions: {
        bankName: 'LuminaRail Test Bank (Providus)',
        accountNumber: '9982014821',
        accountName: 'LuminaRail Sandbox Vault',
        reference: request.reference,
        amount: request.amount,
        currency: request.currency,
        instructions: 'Transfer exact amount to the virtual account number provided.',
      },
      redirectUrl: `https://checkout.mockprovider.local/pay/${request.reference}`,
      metadata: {
        sandbox: true,
        testMode: true,
        reference: request.reference,
      },
      rawResponse: {
        mockStatus: status,
        mockProviderId: providerPaymentId,
      },
    };

    MockPaymentProvider.mockStoreByReference.set(request.reference, response);
    MockPaymentProvider.mockStoreById.set(providerPaymentId, response);

    return response;
  }

  public async getPaymentStatus(providerPaymentId: string): Promise<NormalizedPaymentResponse> {
    const stored = MockPaymentProvider.mockStoreById.get(providerPaymentId) ||
      MockPaymentProvider.mockStoreByReference.get(providerPaymentId);

    const isSimulatedFailure = providerPaymentId.includes('fail_');
    const status: PaymentStatus = stored?.status === PaymentStatus.FAILED || isSimulatedFailure
      ? PaymentStatus.FAILED
      : PaymentStatus.SUCCEEDED;

    return {
      provider: this.providerId,
      providerPaymentId,
      status,
      amount: stored?.amount || '0.0000',
      currency: stored?.currency || 'NGN',
      metadata: { sandbox: true },
    };
  }

  public async verifyPayment(
    providerPaymentId: string,
    _params?: Record<string, unknown>
  ): Promise<NormalizedPaymentResponse> {
    const stored = MockPaymentProvider.mockStoreById.get(providerPaymentId) ||
      MockPaymentProvider.mockStoreByReference.get(providerPaymentId);

    const isSimulatedFailure = providerPaymentId.includes('fail_') || stored?.status === PaymentStatus.FAILED;
    const status: PaymentStatus = isSimulatedFailure ? PaymentStatus.FAILED : PaymentStatus.SUCCEEDED;

    return {
      provider: this.providerId,
      providerPaymentId,
      status,
      amount: stored?.amount || '0.0000',
      currency: stored?.currency || 'NGN',
      metadata: { verified: true, sandbox: true },
      rawResponse: { verifiedAt: new Date().toISOString() },
    };
  }

  public async createPayout(request: CreatePayoutRequest): Promise<NormalizedPayoutResponse> {
    const isSimulatedFailure = request.reference.includes('fail_');
    const status: PaymentStatus = isSimulatedFailure ? PaymentStatus.FAILED : PaymentStatus.PROCESSING;
    const providerPayoutId = `mock_out_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    return {
      provider: this.providerId,
      providerPayoutId,
      status,
      amount: request.amount,
      currency: request.currency,
      metadata: { sandbox: true, reference: request.reference },
      rawResponse: { mockPayoutId: providerPayoutId },
    };
  }

  public async getPayoutStatus(providerPayoutId: string): Promise<NormalizedPayoutResponse> {
    return {
      provider: this.providerId,
      providerPayoutId,
      status: PaymentStatus.SUCCEEDED,
      amount: '0.0000',
      currency: 'NGN',
    };
  }

  public verifyWebhookSignature(
    headers: Record<string, string | string[] | undefined>,
    _rawBody: string | Buffer
  ): boolean {
    const sigHeader = headers['x-mock-signature'] || headers['X-Mock-Signature'];
    if (!sigHeader) {
      return false;
    }
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    return signature === 'mock_valid_signature' || signature === 'valid_mock_sig';
  }

  public parseWebhookEvent(
    headers: Record<string, string | string[] | undefined>,
    body: any
  ): WebhookEventPayload {
    if (!this.verifyWebhookSignature(headers, JSON.stringify(body))) {
      throw new WebhookVerificationError('Invalid mock webhook signature header');
    }

    const eventId = body?.event_id || body?.eventId || `evt_${Date.now()}`;
    const eventType = body?.event_type || body?.eventType || 'payment.updated';
    const providerPaymentId = body?.data?.provider_payment_id || body?.data?.providerPaymentId || body?.providerPaymentId;
    const status: PaymentStatus =
      body?.data?.status === 'SUCCEEDED' || body?.status === 'SUCCEEDED'
        ? PaymentStatus.SUCCEEDED
        : body?.data?.status === 'FAILED' || body?.status === 'FAILED'
          ? PaymentStatus.FAILED
          : PaymentStatus.PENDING;

    return {
      eventId,
      eventType,
      providerPaymentId,
      status,
      payload: body,
    };
  }
}

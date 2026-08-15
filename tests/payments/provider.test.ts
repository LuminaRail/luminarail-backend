import { describe, it, expect } from 'vitest';
import {
  PaymentProviderRegistry,
  MockPaymentProvider,
  IPaymentProvider,
} from '../../src/modules/providers/index.js';
import { NotFoundError } from '../../src/errors/index.js';

describe('Payment Provider Abstraction & Registry', () => {
  it('should resolve default MockPaymentProvider', () => {
    const provider = PaymentProviderRegistry.get('MOCK');
    expect(provider).toBeDefined();
    expect(provider.providerId).toBe('MOCK');
    expect(provider.supportedCurrencies).toContain('NGN');
  });

  it('should throw NotFoundError for unregistered provider', () => {
    expect(() => PaymentProviderRegistry.get('UNKNOWN_PROVIDER')).toThrow(NotFoundError);
  });

  it('should register and retrieve a custom provider', () => {
    const dummyProvider: IPaymentProvider = {
      providerId: 'DUMMY',
      supportedCurrencies: ['NGN'],
      createPayment: async () => ({
        provider: 'DUMMY',
        providerPaymentId: 'dummy_123',
        status: 'PENDING' as any,
        amount: '100.0000',
        currency: 'NGN',
      }),
      getPaymentStatus: async () => ({
        provider: 'DUMMY',
        providerPaymentId: 'dummy_123',
        status: 'SUCCEEDED' as any,
        amount: '100.0000',
        currency: 'NGN',
      }),
      verifyPayment: async () => ({
        provider: 'DUMMY',
        providerPaymentId: 'dummy_123',
        status: 'SUCCEEDED' as any,
        amount: '100.0000',
        currency: 'NGN',
      }),
      createPayout: async () => ({
        provider: 'DUMMY',
        providerPayoutId: 'out_123',
        status: 'SUCCEEDED' as any,
        amount: '100.0000',
        currency: 'NGN',
      }),
      getPayoutStatus: async () => ({
        provider: 'DUMMY',
        providerPayoutId: 'out_123',
        status: 'SUCCEEDED' as any,
        amount: '100.0000',
        currency: 'NGN',
      }),
      verifyWebhookSignature: () => true,
      parseWebhookEvent: () => ({
        eventId: 'evt_1',
        eventType: 'test',
        providerPaymentId: 'dummy_123',
        status: 'SUCCEEDED' as any,
        payload: {},
      }),
    };

    PaymentProviderRegistry.register(dummyProvider);
    const resolved = PaymentProviderRegistry.get('DUMMY');
    expect(resolved.providerId).toBe('DUMMY');
  });
});

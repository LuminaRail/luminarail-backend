import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { PaystackClient } from '../../src/services/paystack.client.js';
import { PaystackNgnPaymentProvider } from '../../src/modules/providers/paystack.provider.js';
import { PaymentProviderRegistry } from '../../src/modules/providers/provider.registry.js';
import { NgnPaymentProvider } from '../../src/modules/providers/ngn.provider.js';
import { PaymentStatus } from '@prisma/client';
import { ProviderError, WebhookVerificationError, BadRequestError } from '../../src/errors/index.js';
import { envSchema } from '../../src/config/index.js';

describe('Paystack TEST MODE Payment Provider Suite', () => {
  const secretKey = 'sk_test_mock_secret_key_123';
  let client: PaystackClient;
  let provider: PaystackNgnPaymentProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new PaystackClient(secretKey, 'https://api.paystack.co');
    provider = new PaystackNgnPaymentProvider(client, secretKey);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('A. Configuration & Provider Selection', () => {
    it('resolves NgnPaymentProvider when NGN_PROVIDER=sandbox', () => {
      // Default sandbox provider
      const resolved = PaymentProviderRegistry.get('NGN');
      expect(resolved).toBeDefined();
    });

    it('resolves PaystackNgnPaymentProvider when provider is PAYSTACK', () => {
      const resolved = PaymentProviderRegistry.get('PAYSTACK');
      expect(resolved.providerId).toBe('PAYSTACK_NGN_BANK_TRANSFER');
    });

    it('fails configuration validation when NGN_PROVIDER=paystack and PAYSTACK_SECRET_KEY is empty', () => {
      const invalidEnv = {
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        STELLAR_USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        NGN_PROVIDER: 'paystack',
        PAYSTACK_SECRET_KEY: '',
      };

      const result = envSchema.safeParse(invalidEnv);
      expect(result.success).toBe(false);
      if (!result.success) {
        const secretKeyIssue = result.error.issues.find((i) => i.path.includes('PAYSTACK_SECRET_KEY'));
        expect(secretKeyIssue).toBeDefined();
        expect(secretKeyIssue?.message).toContain('PAYSTACK_SECRET_KEY environment variable is required');
      }
    });

    it('passes configuration validation when NGN_PROVIDER=paystack and PAYSTACK_SECRET_KEY is provided', () => {
      const validEnv = {
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        STELLAR_USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        NGN_PROVIDER: 'paystack',
        PAYSTACK_SECRET_KEY: 'sk_test_valid_key',
      };

      const result = envSchema.safeParse(validEnv);
      expect(result.success).toBe(true);
    });
  });

  describe('B. Paystack API Initialization (createPayment)', () => {
    it('successfully initializes transaction via Paystack TEST API and converts NGN to kobo', async () => {
      const mockPaystackResponse = {
        status: true,
        message: 'Authorization URL created',
        data: {
          authorization_url: 'https://checkout.paystack.com/test_access_code_123',
          access_code: 'test_access_code_123',
          reference: 'PAY_TEST_REF_100',
        },
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockPaystackResponse,
      } as Response);

      const request = {
        orderId: 'ord_100',
        userId: 'usr_100',
        amount: '50000.00',
        currency: 'NGN',
        type: 'DEPOSIT',
        reference: 'PAY_TEST_REF_100',
      };

      const res = await provider.createPayment(request);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.paystack.co/transaction/initialize',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${secretKey}`,
          }),
          body: JSON.stringify({
            amount: 5000000, // 50,000 NGN in kobo
            email: 'customer@luminarail.com',
            reference: 'PAY_TEST_REF_100',
            currency: 'NGN',
            channels: ['bank_transfer', 'card'],
          }),
        })
      );

      expect(res.provider).toBe('PAYSTACK_NGN_BANK_TRANSFER');
      expect(res.status).toBe(PaymentStatus.PENDING);
      expect(res.instructions?.paymentUrl).toBe('https://checkout.paystack.com/test_access_code_123');
      expect(res.instructions?.reference).toBe('PAY_TEST_REF_100');
    });

    it('throws BadRequestError if non-NGN currency is passed to Paystack provider', async () => {
      const request = {
        orderId: 'ord_100',
        userId: 'usr_100',
        amount: '100.00',
        currency: 'USD',
        type: 'DEPOSIT',
        reference: 'PAY_USD_REF',
      };

      await expect(provider.createPayment(request)).rejects.toThrow(BadRequestError);
    });
  });

  describe('C. Paystack API Failure Handling (400, 401, 404, 500, Network Timeout)', () => {
    it('handles HTTP 400 Bad Request error cleanly', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ status: false, message: 'Invalid currency or amount parameter' }),
      } as Response);

      await expect(
        client.initializeTransaction({ amountInKobo: 5000, email: 'e@test.com', reference: 'ref1' })
      ).rejects.toThrow(ProviderError);
    });

    it('handles HTTP 401 Unauthorized error cleanly', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ status: false, message: 'Invalid API secret key' }),
      } as Response);

      await expect(
        client.initializeTransaction({ amountInKobo: 5000, email: 'e@test.com', reference: 'ref1' })
      ).rejects.toThrow(ProviderError);
    });

    it('handles HTTP 404 Reference Not Found error cleanly', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ status: false, message: 'Transaction reference not found' }),
      } as Response);

      await expect(client.verifyTransaction('non_existent_ref')).rejects.toThrow(ProviderError);
    });

    it('handles HTTP 500 Server Error cleanly', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ status: false, message: 'Internal Paystack gateway error' }),
      } as Response);

      await expect(client.verifyTransaction('ref_500')).rejects.toThrow(ProviderError);
    });

    it('handles network fetch exception cleanly', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ETIMEDOUT Network Timeout'));

      await expect(client.verifyTransaction('ref_timeout')).rejects.toThrow(ProviderError);
    });
  });

  describe('D. Paystack Payment Verification (verifyPayment)', () => {
    it('verifies successful payment status when Paystack returns status=success', async () => {
      const mockVerifyResponse = {
        status: true,
        message: 'Verification successful',
        data: {
          id: 998811,
          status: 'success',
          reference: 'PAY_TEST_REF_100',
          amount: 5000000, // 50,000 NGN in kobo
          currency: 'NGN',
          channel: 'bank_transfer',
          customer: { email: 'user@example.com' },
          paid_at: '2026-08-15T12:00:00Z',
        },
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockVerifyResponse,
      } as Response);

      const res = await provider.verifyPayment('PAY_TEST_REF_100', { expectedAmount: '50000.00' });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.paystack.co/transaction/verify/PAY_TEST_REF_100',
        expect.objectContaining({ method: 'GET' })
      );

      expect(res.status).toBe(PaymentStatus.SUCCEEDED);
      expect(res.amount).toBe('50000.0000');
      expect(res.currency).toBe('NGN');
    });

    it('marks status as FAILED when Paystack reports transaction status=failed', async () => {
      const mockVerifyResponse = {
        status: true,
        message: 'Verification successful',
        data: {
          id: 998812,
          status: 'failed',
          reference: 'PAY_FAILED_REF',
          amount: 5000000,
          currency: 'NGN',
        },
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockVerifyResponse,
      } as Response);

      const res = await provider.verifyPayment('PAY_FAILED_REF');
      expect(res.status).toBe(PaymentStatus.FAILED);
    });

    it('rejects verification if paid amount does not match expected amount (e.g. ₦50,000 expected vs ₦10,000 paid)', async () => {
      const mockVerifyResponse = {
        status: true,
        message: 'Verification successful',
        data: {
          id: 998813,
          status: 'success',
          reference: 'PAY_PARTIAL_REF',
          amount: 1000000, // 10,000 NGN in kobo
          currency: 'NGN',
        },
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockVerifyResponse,
      } as Response);

      // Expected amount is 50,000 NGN, but Paystack returned 10,000 NGN
      const res = await provider.verifyPayment('PAY_PARTIAL_REF', { expectedAmount: '50000.00' });

      expect(res.status).toBe(PaymentStatus.FAILED);
    });

    it('rejects verification if currency is not NGN', async () => {
      const mockVerifyResponse = {
        status: true,
        message: 'Verification successful',
        data: {
          id: 998814,
          status: 'success',
          reference: 'PAY_WRONG_CURRENCY',
          amount: 5000000,
          currency: 'USD',
        },
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockVerifyResponse,
      } as Response);

      const res = await provider.verifyPayment('PAY_WRONG_CURRENCY');
      expect(res.status).toBe(PaymentStatus.FAILED);
    });
  });

  describe('E. Paystack Webhook Signature & Event Parsing', () => {
    it('verifies valid HMAC-SHA512 Paystack webhook signature header', () => {
      const payloadString = JSON.stringify({ event: 'charge.success', data: { reference: 'PAY_WH_1' } });
      const computedSignature = crypto
        .createHmac('sha512', secretKey)
        .update(payloadString)
        .digest('hex');

      const headers = { 'x-paystack-signature': computedSignature };
      const isValid = provider.verifyWebhookSignature(headers, payloadString);

      expect(isValid).toBe(true);
    });

    it('rejects invalid Paystack webhook signature header', () => {
      const payloadString = JSON.stringify({ event: 'charge.success', data: { reference: 'PAY_WH_1' } });
      const headers = { 'x-paystack-signature': 'invalid_forged_signature_123' };

      const isValid = provider.verifyWebhookSignature(headers, payloadString);
      expect(isValid).toBe(false);
    });

    it('throws WebhookVerificationError when parsing event with invalid signature', () => {
      const payload = { event: 'charge.success', data: { reference: 'PAY_WH_1' } };
      const headers = { 'x-paystack-signature': 'invalid_signature' };

      expect(() => provider.parseWebhookEvent(headers, payload)).toThrow(WebhookVerificationError);
    });

    it('successfully parses valid Paystack charge.success webhook event', () => {
      const payload = {
        event: 'charge.success',
        id: 'evt_pstk_9988',
        data: {
          id: 112233,
          status: 'success',
          reference: 'PAY_WH_SUCCESS',
          amount: 2500000,
          currency: 'NGN',
        },
      };

      const rawPayload = JSON.stringify(payload);
      const computedSignature = crypto
        .createHmac('sha512', secretKey)
        .update(rawPayload)
        .digest('hex');

      const headers = { 'x-paystack-signature': computedSignature };
      const parsed = provider.parseWebhookEvent(headers, payload);

      expect(parsed.eventId).toBe('evt_pstk_9988');
      expect(parsed.eventType).toBe('charge.success');
      expect(parsed.providerPaymentId).toBe('PAY_WH_SUCCESS');
      expect(parsed.status).toBe(PaymentStatus.SUCCEEDED);
    });
  });
});

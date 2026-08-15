import { describe, it, expect } from 'vitest';
import { MockPaymentProvider } from '../../src/modules/providers/mock.provider.js';
import { PaymentStatus, PaymentType } from '@prisma/client';

describe('MockPaymentProvider (Sandbox Workflow)', () => {
  const provider = new MockPaymentProvider();

  it('should create deterministic sandbox payment', async () => {
    const res = await provider.createPayment({
      orderId: '00000000-0000-0000-0000-000000000000',
      userId: '00000000-0000-0000-0000-000000000000',
      amount: '5000.0000',
      currency: 'NGN',
      type: PaymentType.DEPOSIT,
      reference: 'PAY_MOCK_123',
    });

    expect(res.provider).toBe('MOCK');
    expect(res.providerPaymentId).toMatch(/^mock_pay_/);
    expect(res.status).toBe(PaymentStatus.PENDING);
    expect(res.amount).toBe('5000.0000');
    expect(res.currency).toBe('NGN');
  });

  it('should simulate failure when reference contains fail_', async () => {
    const res = await provider.createPayment({
      orderId: '00000000-0000-0000-0000-000000000000',
      userId: '00000000-0000-0000-0000-000000000000',
      amount: '5000.0000',
      currency: 'NGN',
      type: PaymentType.DEPOSIT,
      reference: 'PAY_fail_123',
    });

    expect(res.status).toBe(PaymentStatus.FAILED);
  });

  it('should verify payment successfully', async () => {
    const res = await provider.verifyPayment('mock_pay_123');
    expect(res.status).toBe(PaymentStatus.SUCCEEDED);
  });

  it('should verify payment failure when providerPaymentId contains fail_', async () => {
    const res = await provider.verifyPayment('mock_pay_fail_123');
    expect(res.status).toBe(PaymentStatus.FAILED);
  });

  it('should create and verify sandbox payout', async () => {
    const payout = await provider.createPayout({
      payoutId: 'pout_123',
      userId: 'user_123',
      amount: '2000.0000',
      currency: 'NGN',
      destinationAccount: '0123456789',
      reference: 'POUT_123',
    });

    expect(payout.providerPayoutId).toMatch(/^mock_out_/);
    expect(payout.status).toBe(PaymentStatus.PROCESSING);
  });
});

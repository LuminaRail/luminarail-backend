import { describe, it, expect } from 'vitest';
import { PaymentStatus } from '@prisma/client';
import { PaymentStateMachine } from '../../src/modules/payments/payment.state-machine.js';
import { InvalidPaymentStateError } from '../../src/errors/index.js';

describe('Payment State Machine', () => {
  it('should allow valid transitions', () => {
    expect(PaymentStateMachine.canTransition(PaymentStatus.CREATED, PaymentStatus.PENDING)).toBe(true);
    expect(PaymentStateMachine.canTransition(PaymentStatus.PENDING, PaymentStatus.SUCCEEDED)).toBe(true);
    expect(PaymentStateMachine.canTransition(PaymentStatus.PENDING, PaymentStatus.FAILED)).toBe(true);
    expect(PaymentStateMachine.canTransition(PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDED)).toBe(true);
  });

  it('should reject invalid transitions', () => {
    expect(PaymentStateMachine.canTransition(PaymentStatus.SUCCEEDED, PaymentStatus.PENDING)).toBe(false);
    expect(PaymentStateMachine.canTransition(PaymentStatus.FAILED, PaymentStatus.SUCCEEDED)).toBe(false);
    expect(PaymentStateMachine.canTransition(PaymentStatus.CANCELLED, PaymentStatus.PROCESSING)).toBe(false);

    expect(() =>
      PaymentStateMachine.validateTransition(PaymentStatus.SUCCEEDED, PaymentStatus.PENDING)
    ).toThrow(InvalidPaymentStateError);
  });
});

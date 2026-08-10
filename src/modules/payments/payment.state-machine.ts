import { PaymentStatus } from '@prisma/client';
import { InvalidPaymentStateError } from '../../errors/index.js';

export class PaymentStateMachine {
  private static allowedTransitions: Record<PaymentStatus, PaymentStatus[]> = {
    [PaymentStatus.CREATED]: [
      PaymentStatus.PENDING,
      PaymentStatus.PROCESSING,
      PaymentStatus.SUCCEEDED,
      PaymentStatus.FAILED,
      PaymentStatus.CANCELLED,
      PaymentStatus.EXPIRED,
    ],
    [PaymentStatus.PENDING]: [
      PaymentStatus.PROCESSING,
      PaymentStatus.SUCCEEDED,
      PaymentStatus.FAILED,
      PaymentStatus.CANCELLED,
      PaymentStatus.EXPIRED,
    ],
    [PaymentStatus.PROCESSING]: [
      PaymentStatus.SUCCEEDED,
      PaymentStatus.FAILED,
      PaymentStatus.CANCELLED,
      PaymentStatus.EXPIRED,
    ],
    [PaymentStatus.SUCCEEDED]: [PaymentStatus.REFUNDED],
    [PaymentStatus.FAILED]: [],
    [PaymentStatus.CANCELLED]: [],
    [PaymentStatus.EXPIRED]: [],
    [PaymentStatus.REFUNDED]: [],
  };

  public static canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
    if (from === to) {
      return true;
    }
    const allowed = this.allowedTransitions[from] || [];
    return allowed.includes(to);
  }

  public static validateTransition(from: PaymentStatus, to: PaymentStatus): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidPaymentStateError(
        `Invalid payment state transition from '${from}' to '${to}'.`
      );
    }
  }
}

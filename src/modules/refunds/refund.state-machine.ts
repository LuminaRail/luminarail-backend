import { RefundStatus } from '@prisma/client';
import { InvalidRefundStateError } from '../../errors/index.js';

export class RefundStateMachine {
  private static readonly allowedTransitions: Record<RefundStatus, RefundStatus[]> = {
    [RefundStatus.PENDING]: [
      RefundStatus.PENDING,
      RefundStatus.PROCESSING,
      RefundStatus.CANCELLED,
    ],
    [RefundStatus.PROCESSING]: [
      RefundStatus.PROCESSING,
      RefundStatus.SUCCEEDED,
      RefundStatus.FAILED,
    ],
    [RefundStatus.SUCCEEDED]: [RefundStatus.SUCCEEDED],
    [RefundStatus.FAILED]: [RefundStatus.FAILED],
    [RefundStatus.CANCELLED]: [RefundStatus.CANCELLED],
  };

  public static canTransition(current: RefundStatus, target: RefundStatus): boolean {
    if (current === target) {
      return true;
    }
    const allowed = this.allowedTransitions[current] || [];
    return allowed.includes(target);
  }

  public static validateTransition(current: RefundStatus, target: RefundStatus): void {
    if (!this.canTransition(current, target)) {
      throw new InvalidRefundStateError(
        `Invalid refund status transition from '${current}' to '${target}'.`
      );
    }
  }

  public static isTerminal(status: RefundStatus): boolean {
    return (
      status === RefundStatus.SUCCEEDED ||
      status === RefundStatus.FAILED ||
      status === RefundStatus.CANCELLED
    );
  }
}

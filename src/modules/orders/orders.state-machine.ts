import { OrderStatus } from '@prisma/client';
import { BadRequestError } from '../../errors/index.js';

export class OrderStateMachine {
  private static readonly allowedTransitions: Record<OrderStatus, OrderStatus[]> = {
    [OrderStatus.CREATED]: [
      OrderStatus.CREATED,
      OrderStatus.AWAITING_PAYMENT,
      OrderStatus.CANCELLED,
      OrderStatus.EXPIRED,
    ],
    [OrderStatus.AWAITING_PAYMENT]: [
      OrderStatus.AWAITING_PAYMENT,
      OrderStatus.PAYMENT_DETECTED,
      OrderStatus.PAYMENT_CONFIRMED,
      OrderStatus.SETTLEMENT_PENDING,
      OrderStatus.FAILED,
      OrderStatus.CANCELLED,
      OrderStatus.EXPIRED,
      OrderStatus.REFUND_PENDING,
      OrderStatus.REFUNDED,
    ],
    [OrderStatus.PAYMENT_DETECTED]: [
      OrderStatus.PAYMENT_DETECTED,
      OrderStatus.PAYMENT_CONFIRMED,
      OrderStatus.SETTLEMENT_PENDING,
      OrderStatus.FAILED,
      OrderStatus.CANCELLED,
      OrderStatus.REFUND_PENDING,
      OrderStatus.REFUNDED,
    ],
    [OrderStatus.PAYMENT_CONFIRMED]: [
      OrderStatus.PAYMENT_CONFIRMED,
      OrderStatus.SETTLEMENT_PENDING,
      OrderStatus.FAILED,
      OrderStatus.CANCELLED,
      OrderStatus.REFUND_PENDING,
      OrderStatus.REFUNDED,
    ],
    [OrderStatus.SETTLEMENT_PENDING]: [
      OrderStatus.SETTLEMENT_PENDING,
      OrderStatus.SETTLEMENT_COMPLETED,
      OrderStatus.COMPLETED,
      OrderStatus.FAILED,
      OrderStatus.CANCELLED,
      OrderStatus.REFUND_PENDING,
      OrderStatus.REFUNDED,
    ],
    [OrderStatus.SETTLEMENT_COMPLETED]: [
      OrderStatus.SETTLEMENT_COMPLETED,
      OrderStatus.COMPLETED,
    ],
    [OrderStatus.COMPLETED]: [OrderStatus.COMPLETED],
    [OrderStatus.FAILED]: [
      OrderStatus.FAILED,
      OrderStatus.REFUND_PENDING,
      OrderStatus.REFUNDED,
    ],
    [OrderStatus.CANCELLED]: [
      OrderStatus.CANCELLED,
      OrderStatus.REFUND_PENDING,
      OrderStatus.REFUNDED,
    ],
    [OrderStatus.REFUND_PENDING]: [
      OrderStatus.REFUND_PENDING,
      OrderStatus.REFUNDED,
      OrderStatus.REFUND_FAILED,
    ],
    [OrderStatus.REFUNDED]: [OrderStatus.REFUNDED],
    [OrderStatus.REFUND_FAILED]: [
      OrderStatus.REFUND_FAILED,
      OrderStatus.REFUND_PENDING,
      OrderStatus.REFUNDED,
    ],
    [OrderStatus.EXPIRED]: [
      OrderStatus.EXPIRED,
      OrderStatus.REFUND_PENDING,
      OrderStatus.REFUNDED,
    ],
  };

  public static canTransition(current: OrderStatus, target: OrderStatus): boolean {
    if (current === target) {
      return true;
    }

    // Terminal order states that MUST NEVER regress to active execution
    if (current === OrderStatus.REFUNDED) {
      return target === OrderStatus.REFUNDED;
    }
    if (current === OrderStatus.COMPLETED || current === OrderStatus.SETTLEMENT_COMPLETED) {
      if (target === OrderStatus.SETTLEMENT_PENDING || target === OrderStatus.REFUND_PENDING) {
        return false;
      }
    }

    const allowed = this.allowedTransitions[current] || [];
    return allowed.includes(target);
  }

  public static validateTransition(current: OrderStatus, target: OrderStatus): void {
    if (!this.canTransition(current, target)) {
      throw new BadRequestError(
        `Invalid Order status transition from '${current}' to '${target}'. Order cannot enter settlement or active state after refund.`
      );
    }
  }
}

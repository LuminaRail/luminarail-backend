import { SettlementStatus } from '@prisma/client';
import { InvalidSettlementStateError } from '../../errors/index.js';

export class SettlementStateMachine {
  private static allowedTransitions: Record<SettlementStatus, SettlementStatus[]> = {
    [SettlementStatus.PENDING]: [
      SettlementStatus.SUBMITTING,
      SettlementStatus.FAILED,
    ],
    [SettlementStatus.SUBMITTING]: [
      SettlementStatus.SUBMITTED,
      SettlementStatus.FAILED,
      SettlementStatus.REQUIRES_RECONCILIATION,
    ],
    [SettlementStatus.SUBMITTED]: [
      SettlementStatus.CONFIRMING,
      SettlementStatus.REQUIRES_RECONCILIATION,
    ],
    [SettlementStatus.CONFIRMING]: [
      SettlementStatus.COMPLETED,
      SettlementStatus.REQUIRES_RECONCILIATION,
    ],
    [SettlementStatus.COMPLETED]: [],
    [SettlementStatus.FAILED]: [],
    [SettlementStatus.REQUIRES_RECONCILIATION]: [],
  };

  public static canTransition(from: SettlementStatus, to: SettlementStatus): boolean {
    if (from === to) {
      return true;
    }
    const allowed = this.allowedTransitions[from] || [];
    return allowed.includes(to);
  }

  public static validateTransition(from: SettlementStatus, to: SettlementStatus): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidSettlementStateError(
        `Invalid settlement state transition from '${from}' to '${to}'.`
      );
    }
  }
}

import { describe, it, expect } from 'vitest';
import { SettlementStatus } from '@prisma/client';
import { SettlementStateMachine } from '../../src/modules/settlements/settlements.state-machine.js';
import { InvalidSettlementStateError } from '../../src/errors/index.js';

describe('Settlement State Machine', () => {
  it('should allow valid transitions', () => {
    expect(SettlementStateMachine.canTransition(SettlementStatus.PENDING, SettlementStatus.SUBMITTING)).toBe(true);
    expect(SettlementStateMachine.canTransition(SettlementStatus.PENDING, SettlementStatus.FAILED)).toBe(true);

    expect(SettlementStateMachine.canTransition(SettlementStatus.SUBMITTING, SettlementStatus.SUBMITTED)).toBe(true);
    expect(SettlementStateMachine.canTransition(SettlementStatus.SUBMITTING, SettlementStatus.FAILED)).toBe(true);
    expect(SettlementStateMachine.canTransition(SettlementStatus.SUBMITTING, SettlementStatus.REQUIRES_RECONCILIATION)).toBe(true);

    expect(SettlementStateMachine.canTransition(SettlementStatus.SUBMITTED, SettlementStatus.CONFIRMING)).toBe(true);
    expect(SettlementStateMachine.canTransition(SettlementStatus.SUBMITTED, SettlementStatus.REQUIRES_RECONCILIATION)).toBe(true);

    expect(SettlementStateMachine.canTransition(SettlementStatus.CONFIRMING, SettlementStatus.COMPLETED)).toBe(true);
    expect(SettlementStateMachine.canTransition(SettlementStatus.CONFIRMING, SettlementStatus.REQUIRES_RECONCILIATION)).toBe(true);
  });

  it('should allow self transitions', () => {
    expect(SettlementStateMachine.canTransition(SettlementStatus.PENDING, SettlementStatus.PENDING)).toBe(true);
    expect(SettlementStateMachine.canTransition(SettlementStatus.SUBMITTING, SettlementStatus.SUBMITTING)).toBe(true);
    expect(SettlementStateMachine.canTransition(SettlementStatus.COMPLETED, SettlementStatus.COMPLETED)).toBe(true);
  });

  it('should reject invalid transitions and throw InvalidSettlementStateError', () => {
    expect(SettlementStateMachine.canTransition(SettlementStatus.COMPLETED, SettlementStatus.PENDING)).toBe(false);
    expect(SettlementStateMachine.canTransition(SettlementStatus.FAILED, SettlementStatus.COMPLETED)).toBe(false);
    expect(SettlementStateMachine.canTransition(SettlementStatus.SUBMITTED, SettlementStatus.SUBMITTING)).toBe(false);
    expect(SettlementStateMachine.canTransition(SettlementStatus.REQUIRES_RECONCILIATION, SettlementStatus.COMPLETED)).toBe(false);

    expect(() =>
      SettlementStateMachine.validateTransition(SettlementStatus.COMPLETED, SettlementStatus.PENDING)
    ).toThrow(InvalidSettlementStateError);

    expect(() =>
      SettlementStateMachine.validateTransition(SettlementStatus.FAILED, SettlementStatus.SUBMITTED)
    ).toThrow(InvalidSettlementStateError);
  });
});

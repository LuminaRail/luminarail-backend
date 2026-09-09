import { LiquidityPool } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { config } from '../../config/index.js';

export type TreasuryAlertState = 'HEALTHY' | 'WARNING' | 'CRITICAL';

export interface PoolBalanceEvaluationResult {
  poolId: string;
  asset: string;
  availableBalance: number;
  reservedBalance: number;
  totalBalance: number;
  warnThreshold: number;
  criticalThreshold: number;
  previousState: TreasuryAlertState;
  newState: TreasuryAlertState;
  stateChanged: boolean;
  actionTaken?: 'EMITTED_WARN' | 'EMITTED_CRITICAL' | 'EMITTED_RECOVERED' | 'NO_CHANGE';
}

export class TreasuryTelemetryService {
  private static poolStates = new Map<string, TreasuryAlertState>();

  /**
   * Resets alert state map (useful for test isolation).
   */
  public static resetState(): void {
    TreasuryTelemetryService.poolStates.clear();
  }

  /**
   * Evaluates pool available balance against warning & critical thresholds.
   * Emits structured audit logs ONLY on state transitions to prevent alert spam.
   */
  public static async evaluatePoolBalance(
    pool: LiquidityPool,
    options?: {
      warnThreshold?: number;
      criticalThreshold?: number;
      workerId?: string;
    }
  ): Promise<PoolBalanceEvaluationResult> {
    const available = pool.availableBalance.toNumber();
    const reserved = pool.reservedBalance.toNumber();
    const total = pool.totalBalance.toNumber();

    const warnThreshold =
      options?.warnThreshold ?? config.treasury.warnThresholdUsdc;
    const criticalThreshold =
      options?.criticalThreshold ?? config.treasury.criticalThresholdUsdc;

    const previousState =
      TreasuryTelemetryService.poolStates.get(pool.id) || 'HEALTHY';

    let newState: TreasuryAlertState = 'HEALTHY';

    if (available <= criticalThreshold) {
      newState = 'CRITICAL';
    } else if (available <= warnThreshold) {
      newState = 'WARNING';
    } else {
      newState = 'HEALTHY';
    }

    const stateChanged = previousState !== newState;
    let actionTaken: PoolBalanceEvaluationResult['actionTaken'] = 'NO_CHANGE';

    if (stateChanged) {
      TreasuryTelemetryService.poolStates.set(pool.id, newState);

      const metadata = {
        poolId: pool.id,
        asset: pool.asset,
        network: pool.network,
        availableBalance: available,
        reservedBalance: reserved,
        totalBalance: total,
        warnThreshold,
        criticalThreshold,
        previousState,
        newState,
        environment: config.env,
        workerId: options?.workerId || 'system-telemetry',
        timestamp: new Date().toISOString(),
      };

      if (newState === 'CRITICAL') {
        actionTaken = 'EMITTED_CRITICAL';
        await AuditService.log({
          actor: options?.workerId || 'system-telemetry',
          action: 'TREASURY_LOW_BALANCE_CRITICAL',
          resource: 'LiquidityPool',
          details: metadata,
        });
      } else if (newState === 'WARNING') {
        actionTaken = 'EMITTED_WARN';
        await AuditService.log({
          actor: options?.workerId || 'system-telemetry',
          action: 'TREASURY_LOW_BALANCE_WARN',
          resource: 'LiquidityPool',
          details: metadata,
        });
      } else if (newState === 'HEALTHY' && (previousState === 'WARNING' || previousState === 'CRITICAL')) {
        actionTaken = 'EMITTED_RECOVERED';
        await AuditService.log({
          actor: options?.workerId || 'system-telemetry',
          action: 'TREASURY_BALANCE_RECOVERED',
          resource: 'LiquidityPool',
          details: metadata,
        });
      }
    }

    return {
      poolId: pool.id,
      asset: pool.asset,
      availableBalance: available,
      reservedBalance: reserved,
      totalBalance: total,
      warnThreshold,
      criticalThreshold,
      previousState,
      newState,
      stateChanged,
      actionTaken,
    };
  }
}

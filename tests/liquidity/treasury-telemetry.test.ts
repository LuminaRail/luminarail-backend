import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  TreasuryTelemetryService,
} from '../../src/modules/liquidity/treasury-telemetry.service.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { envSchema } from '../../src/config/index.js';

describe('Treasury Low-Balance Telemetry & Alert Debouncing (MAINNET-07 Part 1)', () => {
  beforeEach(() => {
    TreasuryTelemetryService.resetState();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    TreasuryTelemetryService.resetState();
    vi.restoreAllMocks();
  });

  it('Healthy pool state does not emit alert logs', async () => {
    const auditSpy = vi.spyOn(AuditService, 'log');

    const pool = {
      id: 'pool_healthy_1',
      asset: 'USDC',
      network: 'testnet',
      totalBalance: new Prisma.Decimal(10000),
      reservedBalance: new Prisma.Decimal(1000),
      availableBalance: new Prisma.Decimal(9000),
      minThreshold: new Prisma.Decimal(1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const res = await TreasuryTelemetryService.evaluatePoolBalance(pool, {
      warnThreshold: 5000,
      criticalThreshold: 1000,
    });

    expect(res.newState).toBe('HEALTHY');
    expect(res.actionTaken).toBe('NO_CHANGE');
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('Emits TREASURY_LOW_BALANCE_WARN on HEALTHY -> WARNING transition', async () => {
    const auditSpy = vi.spyOn(AuditService, 'log');

    const pool = {
      id: 'pool_warn_1',
      asset: 'USDC',
      network: 'testnet',
      totalBalance: new Prisma.Decimal(10000),
      reservedBalance: new Prisma.Decimal(6000),
      availableBalance: new Prisma.Decimal(4000),
      minThreshold: new Prisma.Decimal(1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const res = await TreasuryTelemetryService.evaluatePoolBalance(pool, {
      warnThreshold: 5000,
      criticalThreshold: 1000,
    });

    expect(res.newState).toBe('WARNING');
    expect(res.actionTaken).toBe('EMITTED_WARN');
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TREASURY_LOW_BALANCE_WARN',
        details: expect.objectContaining({
          availableBalance: 4000,
          previousState: 'HEALTHY',
          newState: 'WARNING',
        }),
      })
    );
  });

  it('Emits TREASURY_LOW_BALANCE_CRITICAL on WARNING -> CRITICAL transition', async () => {
    const auditSpy = vi.spyOn(AuditService, 'log');

    const poolWarning = {
      id: 'pool_crit_1',
      asset: 'USDC',
      network: 'testnet',
      totalBalance: new Prisma.Decimal(10000),
      reservedBalance: new Prisma.Decimal(6000),
      availableBalance: new Prisma.Decimal(4000),
      minThreshold: new Prisma.Decimal(1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // First transition: HEALTHY -> WARNING
    await TreasuryTelemetryService.evaluatePoolBalance(poolWarning, {
      warnThreshold: 5000,
      criticalThreshold: 1000,
    });

    const poolCritical = {
      ...poolWarning,
      reservedBalance: new Prisma.Decimal(9500),
      availableBalance: new Prisma.Decimal(500),
    };

    // Second transition: WARNING -> CRITICAL
    const res = await TreasuryTelemetryService.evaluatePoolBalance(poolCritical, {
      warnThreshold: 5000,
      criticalThreshold: 1000,
    });

    expect(res.newState).toBe('CRITICAL');
    expect(res.actionTaken).toBe('EMITTED_CRITICAL');
    expect(auditSpy).toHaveBeenCalledTimes(2); // 1 for warn, 1 for critical
  });

  it('Emits TREASURY_BALANCE_RECOVERED on CRITICAL -> HEALTHY transition', async () => {
    const auditSpy = vi.spyOn(AuditService, 'log');

    const pool = {
      id: 'pool_rec_1',
      asset: 'USDC',
      network: 'testnet',
      totalBalance: new Prisma.Decimal(10000),
      reservedBalance: new Prisma.Decimal(9500),
      availableBalance: new Prisma.Decimal(500),
      minThreshold: new Prisma.Decimal(1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Set state to CRITICAL
    await TreasuryTelemetryService.evaluatePoolBalance(pool, {
      warnThreshold: 5000,
      criticalThreshold: 1000,
    });

    // Pool replenished: available balance recovers to 8000
    const poolRecovered = {
      ...pool,
      reservedBalance: new Prisma.Decimal(2000),
      availableBalance: new Prisma.Decimal(8000),
    };

    const res = await TreasuryTelemetryService.evaluatePoolBalance(poolRecovered, {
      warnThreshold: 5000,
      criticalThreshold: 1000,
    });

    expect(res.newState).toBe('HEALTHY');
    expect(res.actionTaken).toBe('EMITTED_RECOVERED');
    expect(auditSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'TREASURY_BALANCE_RECOVERED',
      })
    );
  });

  it('Anti-spam: Repeated evaluations in the same state produce NO_CHANGE and zero new alerts', async () => {
    const auditSpy = vi.spyOn(AuditService, 'log');

    const pool = {
      id: 'pool_spam_1',
      asset: 'USDC',
      network: 'testnet',
      totalBalance: new Prisma.Decimal(10000),
      reservedBalance: new Prisma.Decimal(7000),
      availableBalance: new Prisma.Decimal(3000),
      minThreshold: new Prisma.Decimal(1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // First call: HEALTHY -> WARNING
    const res1 = await TreasuryTelemetryService.evaluatePoolBalance(pool, {
      warnThreshold: 5000,
      criticalThreshold: 1000,
    });
    expect(res1.actionTaken).toBe('EMITTED_WARN');
    expect(auditSpy).toHaveBeenCalledTimes(1);

    // Repeated call 1: WARNING -> WARNING (same state)
    const res2 = await TreasuryTelemetryService.evaluatePoolBalance(pool, {
      warnThreshold: 5000,
      criticalThreshold: 1000,
    });
    expect(res2.actionTaken).toBe('NO_CHANGE');
    expect(auditSpy).toHaveBeenCalledTimes(1);

    // Repeated call 2: WARNING -> WARNING (same state)
    const res3 = await TreasuryTelemetryService.evaluatePoolBalance(pool, {
      warnThreshold: 5000,
      criticalThreshold: 1000,
    });
    expect(res3.actionTaken).toBe('NO_CHANGE');
    expect(auditSpy).toHaveBeenCalledTimes(1);
  });

  it('Zod env validation rejects malformed threshold configuration (critical > warn)', () => {
    const invalidEnv = {
      DATABASE_URL: 'postgresql://localhost:5432/db',
      STELLAR_USDC_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      TREASURY_WARN_THRESHOLD_USDC: '1000',
      TREASURY_CRITICAL_THRESHOLD_USDC: '5000', // Invalid: critical > warn
    };

    const parseResult = envSchema.safeParse(invalidEnv);
    expect(parseResult.success).toBe(false);
  });
});

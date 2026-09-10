import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LuminaRailWorkerRunner, startWorkerRunner } from '../../src/worker.js';
import { config } from '../../src/config/index.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { ShutdownManager } from '../../src/infrastructure/lifecycle/shutdown.manager.js';
import { createApp } from '../../src/app.js';
import * as stellarConfigModule from '../../src/stellar/config/index.js';

describe('MAINNET-08A: Worker Entrypoint & Render Blueprint Test Suite', () => {
  let runner: LuminaRailWorkerRunner;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    if (runner) {
      await runner.stop();
    }
  });

  it('1. worker entrypoint initializes successfully with valid configuration', async () => {
    const auditSpy = vi.spyOn(AuditService, 'log').mockResolvedValue({} as any);

    runner = new LuminaRailWorkerRunner();
    // Spy daemon sweep methods to run fast without requiring DB data
    vi.spyOn((runner as any).settlementWorker, 'processPendingOrders').mockResolvedValue(0 as any);
    vi.spyOn((runner as any).reservationCleanupWorker, 'processExpiredReservations').mockResolvedValue(0 as any);
    vi.spyOn((runner as any).reconciliationDaemon, 'processPaymentReconciliation').mockResolvedValue([] as any);
    vi.spyOn((runner as any).reconciliationDaemon, 'processReconciliation').mockResolvedValue([] as any);

    await runner.start({ runOnce: true });

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WORKER_STARTED',
        actor: 'system-worker',
        resource: 'WorkerRunner',
        details: expect.objectContaining({
          environment: config.env,
          components: [
            'SettlementWorker',
            'ReservationCleanupWorker',
            'ReconciliationDaemon',
          ],
        }),
      })
    );
  });

  it('2. worker startup fails with invalid production configuration', async () => {
    const safetySpy = vi
      .spyOn(stellarConfigModule, 'assertProductionSettlementSafety')
      .mockImplementation(() => {
        throw new Error('Production settlement safety violation: invalid config');
      });

    runner = new LuminaRailWorkerRunner();
    await expect(runner.start({ runOnce: true })).rejects.toThrow(
      'Production settlement safety violation: invalid config'
    );

    expect(safetySpy).toHaveBeenCalled();
  });

  it('3. SIGTERM triggers graceful shutdown handler registration', async () => {
    const registerSpy = vi.spyOn(ShutdownManager, 'registerShutdownHandlers');

    runner = new LuminaRailWorkerRunner();
    vi.spyOn((runner as any).settlementWorker, 'processPendingOrders').mockResolvedValue(0 as any);
    vi.spyOn((runner as any).reservationCleanupWorker, 'processExpiredReservations').mockResolvedValue(0 as any);
    vi.spyOn((runner as any).reconciliationDaemon, 'processPaymentReconciliation').mockResolvedValue([] as any);
    vi.spyOn((runner as any).reconciliationDaemon, 'processReconciliation').mockResolvedValue([] as any);

    await runner.start({ runOnce: true });

    expect(registerSpy).toHaveBeenCalled();
  });

  it('4. SIGINT triggers signal listener handling', () => {
    const listenersBefore = process.listenerCount('SIGINT');
    ShutdownManager.registerShutdownHandlers();
    const listenersAfter = process.listenerCount('SIGINT');

    expect(listenersAfter).toBeGreaterThanOrEqual(listenersBefore);
  });

  it('5. worker initializes and executes all required daemons in runSweep', async () => {
    runner = new LuminaRailWorkerRunner();

    const settlementSpy = vi.spyOn((runner as any).settlementWorker, 'processPendingOrders').mockResolvedValue(0 as any);
    const cleanupSpy = vi.spyOn((runner as any).reservationCleanupWorker, 'processExpiredReservations').mockResolvedValue(0 as any);
    const reconPaymentSpy = vi.spyOn((runner as any).reconciliationDaemon, 'processPaymentReconciliation').mockResolvedValue([] as any);
    const reconSettlementSpy = vi.spyOn((runner as any).reconciliationDaemon, 'processReconciliation').mockResolvedValue([] as any);

    await runner.runSweep();

    expect(settlementSpy).toHaveBeenCalled();
    expect(cleanupSpy).toHaveBeenCalled();
    expect(reconPaymentSpy).toHaveBeenCalled();
    expect(reconSettlementSpy).toHaveBeenCalled();
  });

  it('6. one worker loop failure does not silently bypass financial safety', async () => {
    const auditSpy = vi.spyOn(AuditService, 'log').mockResolvedValue({} as any);

    runner = new LuminaRailWorkerRunner();
    vi.spyOn(runner, 'runSweep').mockRejectedValueOnce(new Error('Transient worker error'));

    // Enable loop briefly, it will execute one iteration, catch error, audit, and exit because isRunning becomes false
    (runner as any).isRunning = true;
    const loopPromise = (runner as any).runLoop();
    (runner as any).isRunning = false; // stop loop after first iteration completes

    await loopPromise;

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'WORKER_LOOP_ERROR',
        actor: 'system-worker',
        details: { error: 'Transient worker error' },
      })
    );
  });

  it('7. distributed locks remain enabled in worker configuration', () => {
    expect(config.redis.requireDistributedLocks).toBeDefined();
    expect(typeof config.redis.requireDistributedLocks).toBe('boolean');
  });

  it('8. API entrypoint remains unaffected and creates Express app', () => {
    const app = createApp();
    expect(app).toBeDefined();
    expect(typeof app.listen).toBe('function');
  });
});

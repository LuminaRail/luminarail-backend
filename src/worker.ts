import { config } from './config/index.js';
import { assertProductionSettlementSafety, assertContractGovernanceReadiness } from './stellar/config/index.js';
import { SettlementWorker } from './workers/settlement.worker.js';
import { ReservationCleanupWorker } from './workers/reservation-cleanup.worker.js';
import { ReconciliationDaemon } from './workers/reconciliation.daemon.js';
import { AuditService } from './modules/audit/audit.service.js';
import { DistributedLockService } from './infrastructure/locks/distributed-lock.service.js';
import { ShutdownManager } from './infrastructure/lifecycle/shutdown.manager.js';

export interface WorkerRunnerOptions {
  intervalMs?: number;
  runOnce?: boolean;
}

export class LuminaRailWorkerRunner {
  private settlementWorker: SettlementWorker;
  private reservationCleanupWorker: ReservationCleanupWorker;
  private reconciliationDaemon: ReconciliationDaemon;
  private isRunning = false;
  private intervalMs: number;

  constructor() {
    this.settlementWorker = new SettlementWorker();
    this.reservationCleanupWorker = new ReservationCleanupWorker();
    this.reconciliationDaemon = new ReconciliationDaemon();
    this.intervalMs = 5000;
  }

  /**
   * Asserts production configuration readiness and starts the background worker process.
   */
  public async start(options: WorkerRunnerOptions = {}): Promise<void> {
    if (options.intervalMs && options.intervalMs > 0) {
      this.intervalMs = options.intervalMs;
    }

    // Strict Production Configuration & Governance Guard Checks
    assertProductionSettlementSafety();
    assertContractGovernanceReadiness();

    // Register process shutdown handlers (SIGTERM / SIGINT)
    ShutdownManager.registerShutdownHandlers();

    this.isRunning = true;

    // Structured Safe Operational Telemetry (Zero Secrets)
    await AuditService.log({
      actor: 'system-worker',
      action: 'WORKER_STARTED',
      resource: 'WorkerRunner',
      resourceId: `pid-${process.pid}`,
      details: {
        environment: config.env,
        stellarNetwork: config.stellar.network,
        workerPid: process.pid,
        requireDistributedLocks: config.redis.requireDistributedLocks,
        components: [
          'SettlementWorker',
          'ReservationCleanupWorker',
          'ReconciliationDaemon',
        ],
        pollIntervalMs: this.intervalMs,
      },
    });

    if (options.runOnce) {
      await this.runSweep();
      this.isRunning = false;
      return;
    }

    this.runLoop();
  }

  /**
   * Main background polling loop.
   */
  private async runLoop(): Promise<void> {
    while (this.isRunning && !ShutdownManager.isShuttingDown()) {
      try {
        await this.runSweep();
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown worker loop error';
        await AuditService.log({
          actor: 'system-worker',
          action: 'WORKER_LOOP_ERROR',
          resource: 'WorkerRunner',
          details: { error: errorMsg },
        });
      }

      if (!this.isRunning || ShutdownManager.isShuttingDown()) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, this.intervalMs));
    }
  }

  /**
   * Executes a single sweep across all worker daemons.
   */
  public async runSweep(): Promise<void> {
    if (ShutdownManager.isShuttingDown()) {
      return;
    }

    ShutdownManager.incrementActiveJobs();
    try {
      // 1. Process settlement queue (PENDING -> SUBMITTING -> SUBMITTED -> CONFIRMING -> COMPLETED)
      await this.settlementWorker.processPendingOrders();

      // 2. Process expired liquidity reservations
      await this.reservationCleanupWorker.processExpiredReservations();

      // 3. Process payment reconciliation for missed webhooks
      await this.reconciliationDaemon.processPaymentReconciliation();

      // 4. Process settlement reconciliation
      await this.reconciliationDaemon.processReconciliation();
    } finally {
      ShutdownManager.decrementActiveJobs();
    }
  }

  /**
   * Stops the worker polling loop.
   */
  public async stop(): Promise<void> {
    this.isRunning = false;
  }
}

export async function startWorkerRunner(options?: WorkerRunnerOptions): Promise<LuminaRailWorkerRunner> {
  const runner = new LuminaRailWorkerRunner();
  await runner.start(options);
  return runner;
}

// Auto-execute if invoked as entrypoint script
if (process.argv[1] && (process.argv[1].endsWith('worker.js') || process.argv[1].endsWith('worker.ts'))) {
  startWorkerRunner().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ Fatal error starting LuminaRail Worker process:', message);
    process.exit(1);
  });
}

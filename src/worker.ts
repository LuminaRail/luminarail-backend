import { config } from './config/index.js';
import { assertProductionSettlementSafety, assertContractGovernanceReadiness } from './stellar/config/index.js';
import { SorobanSignerConfigError } from './errors/index.js';
import { SettlementWorker } from './workers/settlement.worker.js';
import { ReservationCleanupWorker } from './workers/reservation-cleanup.worker.js';
import { ReconciliationDaemon } from './workers/reconciliation.daemon.js';
import { AuditService } from './modules/audit/audit.service.js';
import { DistributedLockService } from './infrastructure/locks/distributed-lock.service.js';
import { ShutdownManager } from './infrastructure/lifecycle/shutdown.manager.js';
import { WorkerHealthTelemetryService } from './infrastructure/telemetry/worker-health-telemetry.service.js';
import { WorkerLivenessServer } from './infrastructure/telemetry/worker-liveness.server.js';

export interface WorkerRunnerOptions {
  intervalMs?: number;
  runOnce?: boolean;
  /** Overrides WORKER_LIVENESS_ENABLED for this runner instance. */
  livenessEnabled?: boolean;
  /** Overrides WORKER_LIVENESS_PORT for this runner instance. */
  livenessPort?: number;
}

export class LuminaRailWorkerRunner {
  private settlementWorker: SettlementWorker;
  private reservationCleanupWorker: ReservationCleanupWorker;
  private reconciliationDaemon: ReconciliationDaemon;
  private isRunning = false;
  private intervalMs: number;
  private livenessServer: WorkerLivenessServer | null = null;

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

    if (config.env === 'production') {
      if (!config.redisUrl || config.redisUrl.trim() === '') {
        throw new Error('REDIS_URL environment variable is required for production worker process.');
      }
      if (config.stellar.signerProvider === 'testnet_local') {
        throw new SorobanSignerConfigError(
          'FATAL SECURITY VIOLATION: Local testnet signer (testnet_local) is strictly forbidden for production worker execution.'
        );
      }
      if (config.stellar.signerProvider === 'aws_kms' && (!config.stellar.kmsKeyArn || config.stellar.kmsKeyArn.trim() === '')) {
        throw new SorobanSignerConfigError(
          'FATAL SECURITY VIOLATION: STELLAR_KMS_KEY_ARN or AWS_KMS_SIGNING_KEY_ID is required when STELLAR_SIGNER_PROVIDER is "aws_kms".'
        );
      }
    }

    // Register process shutdown handlers (SIGTERM / SIGINT)
    ShutdownManager.registerShutdownHandlers();

    // Record worker lifecycle heartbeat (startup)
    WorkerHealthTelemetryService.markStarted();

    // Start liveness HTTP endpoint for orchestrator health probes (e.g. Render)
    const livenessEnabled = options.livenessEnabled ?? config.worker?.livenessEnabled ?? true;
    if (livenessEnabled) {
      const livenessPort = options.livenessPort ?? config.worker?.livenessPort ?? 4001;
      this.livenessServer = new WorkerLivenessServer({ port: livenessPort });
      try {
        await this.livenessServer.start();
        console.log(`✅ [WorkerRunner] Liveness endpoint listening on port ${this.livenessServer.getPort()} (GET /health)`);
      } catch (err: unknown) {
        // A liveness port conflict must never prevent the worker from settling payments.
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`⚠️ [WorkerRunner] Failed to start liveness endpoint: ${errMsg}`);
        this.livenessServer = null;
      }
    }

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
   * Executes a single sweep across all worker daemons and records liveness
   * sweep heartbeats for each daemon that completes.
   */
  public async runSweep(): Promise<void> {
    if (ShutdownManager.isShuttingDown()) {
      return;
    }

    ShutdownManager.incrementActiveJobs();
    WorkerHealthTelemetryService.incrementActiveJobs();
    const errors: string[] = [];
    try {
      // 1. Process settlement queue (PENDING -> SUBMITTING -> SUBMITTED -> CONFIRMING -> COMPLETED)
      try {
        const processed = await this.settlementWorker.processPendingOrders();
        WorkerHealthTelemetryService.recordSweep('settlement', processed.length);
      } catch (err: unknown) {
        errors.push(err instanceof Error ? err.message : 'Settlement sweep error');
      }

      // 2. Process expired liquidity reservations
      try {
        const processed = await this.reservationCleanupWorker.processExpiredReservations();
        WorkerHealthTelemetryService.recordSweep('reservationCleanup', processed.length);
      } catch (err: unknown) {
        errors.push(err instanceof Error ? err.message : 'Reservation cleanup sweep error');
      }

      // 3. Process payment reconciliation for missed webhooks
      try {
        const processed = await this.reconciliationDaemon.processPaymentReconciliation();
        WorkerHealthTelemetryService.recordSweep('paymentReconciliation', processed.length);
      } catch (err: unknown) {
        errors.push(err instanceof Error ? err.message : 'Payment reconciliation sweep error');
      }

      // 4. Process settlement reconciliation
      try {
        const processed = await this.reconciliationDaemon.processReconciliation();
        WorkerHealthTelemetryService.recordSweep('reconciliation', processed.length);
      } catch (err: unknown) {
        errors.push(err instanceof Error ? err.message : 'Reconciliation sweep error');
      }
    } finally {
      WorkerHealthTelemetryService.decrementActiveJobs();
      ShutdownManager.decrementActiveJobs();
    }

    // Surface aggregated sweep failures so the polling loop keeps auditing
    // them (WORKER_LOOP_ERROR) without skipping the remaining daemons.
    if (errors.length > 0) {
      throw new Error(errors.join('; '));
    }
  }

  /**
   * Stops the worker polling loop and records the shutdown lifecycle heartbeat.
   */
  public async stop(): Promise<void> {
    this.isRunning = false;
    WorkerHealthTelemetryService.markStopped();
    if (this.livenessServer) {
      await this.livenessServer.stop();
      this.livenessServer = null;
    }
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

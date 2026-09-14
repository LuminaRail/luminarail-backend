import { config } from '../../config/index.js';

export type WorkerLivenessState = 'NOT_STARTED' | 'RUNNING' | 'STOPPED';

export type WorkerHealthState = 'HEALTHY' | 'STALLED' | 'NOT_STARTED' | 'STOPPED';

export interface WorkerSweepHeartbeat {
  lastSweepAt: string;
  lastSweepCount: number;
}

export interface WorkerHealthSnapshot {
  /** Aggregate health state used to derive the HTTP status code. */
  state: WorkerHealthState;
  /** ISO timestamp of the moment the snapshot was taken. */
  timestamp: string;
  /** Process uptime in seconds (diagnostic only, no secrets). */
  uptimeSeconds: number;
  /** Worker process id (diagnostic only, no secrets). */
  pid: number;
  /** Lifecycle heartbeat for the worker process itself. */
  lifecycle: {
    state: WorkerLivenessState;
    startedAt: string | null;
    stoppedAt: string | null;
  };
  /** True once the worker has completed at least one full sweep. */
  hasCompletedSweep: boolean;
  /** Per-daemon last sweep heartbeats keyed by sweep type. */
  sweeps: {
    settlement: WorkerSweepHeartbeat | null;
    reconciliation: WorkerSweepHeartbeat | null;
    paymentReconciliation: WorkerSweepHeartbeat | null;
    reservationCleanup: WorkerSweepHeartbeat | null;
  };
  /** Number of currently active (in-flight) jobs. */
  activeJobs: number;
  /** Cumulative distributed-lock acquisition failures observed by this process. */
  lockAcquisitionFailures: number;
  /** Reason the worker is considered stalled (present only when state === 'STALLED'). */
  stallReason?: string;
}

type SweepType = keyof WorkerHealthSnapshot['sweeps'];

/**
 * Central in-process liveness telemetry for background worker daemons.
 *
 * Tracks worker lifecycle (startup/shutdown), per-daemon sweep heartbeats,
 * active job count, and distributed-lock acquisition failures so that a
 * container orchestrator (e.g. Render) can detect stalled or deadlocked
 * workers via the liveness HTTP endpoint.
 *
 * The snapshot payload intentionally contains NO secrets or credentials —
 * only booleans, counters, timestamps, and the OS process id.
 */
export class WorkerHealthTelemetryService {
  private static lifecycleState: WorkerLivenessState = 'NOT_STARTED';
  private static startedAt: string | null = null;
  private static stoppedAt: string | null = null;
  private static processStartedAtMs = Date.now();

  private static sweepHeartbeats: Record<SweepType, WorkerSweepHeartbeat | null> = {
    settlement: null,
    reconciliation: null,
    paymentReconciliation: null,
    reservationCleanup: null,
  };

  private static activeJobsCount = 0;
  private static lockAcquisitionFailuresCount = 0;

  /**
   * Resets all telemetry state (useful for test isolation).
   */
  public static resetState(): void {
    WorkerHealthTelemetryService.lifecycleState = 'NOT_STARTED';
    WorkerHealthTelemetryService.startedAt = null;
    WorkerHealthTelemetryService.stoppedAt = null;
    WorkerHealthTelemetryService.processStartedAtMs = Date.now();
    WorkerHealthTelemetryService.sweepHeartbeats = {
      settlement: null,
      reconciliation: null,
      paymentReconciliation: null,
      reservationCleanup: null,
    };
    WorkerHealthTelemetryService.activeJobsCount = 0;
    WorkerHealthTelemetryService.lockAcquisitionFailuresCount = 0;
  }

  /**
   * Records worker startup (lifecycle heartbeat).
   */
  public static markStarted(): void {
    WorkerHealthTelemetryService.lifecycleState = 'RUNNING';
    WorkerHealthTelemetryService.startedAt = new Date().toISOString();
    WorkerHealthTelemetryService.stoppedAt = null;
    WorkerHealthTelemetryService.processStartedAtMs = Date.now();
  }

  /**
   * Records worker shutdown (lifecycle heartbeat).
   */
  public static markStopped(): void {
    WorkerHealthTelemetryService.lifecycleState = 'STOPPED';
    WorkerHealthTelemetryService.stoppedAt = new Date().toISOString();
  }

  /**
   * Records the completion of a sweep for a daemon (sweep heartbeat).
   *
   * @param sweepType Daemon sweep identifier (settlement, reconciliation, ...)
   * @param processedCount Number of items processed during the sweep.
   */
  public static recordSweep(sweepType: SweepType, processedCount: number): void {
    WorkerHealthTelemetryService.sweepHeartbeats[sweepType] = {
      lastSweepAt: new Date().toISOString(),
      lastSweepCount: processedCount,
    };
  }

  public static incrementActiveJobs(): void {
    WorkerHealthTelemetryService.activeJobsCount++;
  }

  public static decrementActiveJobs(): void {
    if (WorkerHealthTelemetryService.activeJobsCount > 0) {
      WorkerHealthTelemetryService.activeJobsCount--;
    }
  }

  /**
   * Records a distributed-lock acquisition failure so liveness telemetry can
   * surface repeated lock contention or Redis unavailability.
   */
  public static recordLockAcquisitionFailure(key?: string): void {
    WorkerHealthTelemetryService.lockAcquisitionFailuresCount++;
    if (key) {
      console.warn(
        `⚠️ [WorkerHealthTelemetry] Distributed lock acquisition failure recorded (key=${key}, total=${WorkerHealthTelemetryService.lockAcquisitionFailuresCount})`
      );
    }
  }

  /**
   * True when at least one daemon sweep heartbeat is considered fresh.
   * A healthy IDLE worker (nothing to process, sweeps return 0 items) still
   * produces fresh heartbeats on every sweep, so this distinguishes an idle
   * worker from a stalled/deadlocked one.
   */
  private static hasFreshSweep(maxSweepAgeMs: number): boolean {
    const now = Date.now();
    return Object.values(WorkerHealthTelemetryService.sweepHeartbeats).some((heartbeat) => {
      if (!heartbeat) {
        return false;
      }
      return now - new Date(heartbeat.lastSweepAt).getTime() <= maxSweepAgeMs;
    });
  }

  /**
   * Builds a secret-free snapshot of the worker health state and classifies
   * it as HEALTHY or STALLED based on sweep freshness.
   */
  public static getHealthSnapshot(): WorkerHealthSnapshot {
    const maxSweepAgeMs = config.worker?.livenessMaxSweepAgeMs ?? 120000;

    const snapshot: WorkerHealthSnapshot = {
      state: 'NOT_STARTED',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - WorkerHealthTelemetryService.processStartedAtMs) / 1000),
      pid: process.pid,
      lifecycle: {
        state: WorkerHealthTelemetryService.lifecycleState,
        startedAt: WorkerHealthTelemetryService.startedAt,
        stoppedAt: WorkerHealthTelemetryService.stoppedAt,
      },
      hasCompletedSweep: Object.values(WorkerHealthTelemetryService.sweepHeartbeats).some(
        (heartbeat) => heartbeat !== null
      ),
      sweeps: { ...WorkerHealthTelemetryService.sweepHeartbeats },
      activeJobs: WorkerHealthTelemetryService.activeJobsCount,
      lockAcquisitionFailures: WorkerHealthTelemetryService.lockAcquisitionFailuresCount,
    };

    if (WorkerHealthTelemetryService.lifecycleState === 'RUNNING') {
      if (WorkerHealthTelemetryService.hasFreshSweep(maxSweepAgeMs)) {
        snapshot.state = 'HEALTHY';
      } else {
        snapshot.state = 'STALLED';
        snapshot.stallReason = `No fresh sweep heartbeat within the last ${maxSweepAgeMs}ms.`;
      }
    } else if (WorkerHealthTelemetryService.lifecycleState === 'STOPPED') {
      snapshot.state = 'STOPPED';
    }

    return snapshot;
  }
}

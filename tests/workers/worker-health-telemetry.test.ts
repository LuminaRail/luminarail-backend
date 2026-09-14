import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { WorkerHealthTelemetryService } from '../../src/infrastructure/telemetry/worker-health-telemetry.service.js';
import { WorkerLivenessServer, WORKER_LIVENESS_PATH } from '../../src/infrastructure/telemetry/worker-liveness.server.js';
import { config } from '../../src/config/index.js';

function getJson(url: string): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode || 0, body: JSON.parse(raw) });
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

describe('Worker Health & Liveness Telemetry (Issue #43)', () => {
  let server: WorkerLivenessServer;
  const serversToClose: WorkerLivenessServer[] = [];

  beforeEach(() => {
    WorkerHealthTelemetryService.resetState();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined as any;
    }
    for (const s of serversToClose.splice(0)) {
      await s.stop();
    }
  });

  afterAll(async () => {
    for (const s of serversToClose.splice(0)) {
      await s.stop();
    }
  });

  describe('Telemetry state machine (sweep freshness transitions)', () => {
    it('reports NOT_STARTED (503) before worker startup', () => {
      const snapshot = WorkerHealthTelemetryService.getHealthSnapshot();

      expect(snapshot.state).toBe('NOT_STARTED');
      expect(snapshot.lifecycle.state).toBe('NOT_STARTED');
      expect(snapshot.hasCompletedSweep).toBe(false);
    });

    it('reports STALLED immediately after startup, before any sweep heartbeat', () => {
      WorkerHealthTelemetryService.markStarted();

      const snapshot = WorkerHealthTelemetryService.getHealthSnapshot();

      expect(snapshot.state).toBe('STALLED');
      expect(snapshot.lifecycle.state).toBe('RUNNING');
      expect(snapshot.lifecycle.startedAt).not.toBeNull();
      expect(snapshot.stallReason).toBeDefined();
    });

    it('transitions STALLED -> HEALTHY once a fresh sweep heartbeat is recorded', () => {
      WorkerHealthTelemetryService.markStarted();

      const stalled = WorkerHealthTelemetryService.getHealthSnapshot();
      expect(stalled.state).toBe('STALLED');

      WorkerHealthTelemetryService.recordSweep('settlement', 3);

      const healthy = WorkerHealthTelemetryService.getHealthSnapshot();
      expect(healthy.state).toBe('HEALTHY');
      expect(healthy.hasCompletedSweep).toBe(true);
      expect(healthy.sweeps.settlement).not.toBeNull();
      expect(healthy.sweeps.settlement?.lastSweepCount).toBe(3);
    });

    it('treats a healthy IDLE worker (sweeps returning 0 items) as HEALTHY', () => {
      WorkerHealthTelemetryService.markStarted();
      WorkerHealthTelemetryService.recordSweep('settlement', 0);
      WorkerHealthTelemetryService.recordSweep('reservationCleanup', 0);
      WorkerHealthTelemetryService.recordSweep('paymentReconciliation', 0);
      WorkerHealthTelemetryService.recordSweep('reconciliation', 0);

      const snapshot = WorkerHealthTelemetryService.getHealthSnapshot();

      // Acceptance criteria: distinguish a healthy idle worker from a stalled one.
      expect(snapshot.state).toBe('HEALTHY');
      expect(snapshot.sweeps.settlement?.lastSweepCount).toBe(0);
    });

    it('goes STALLED again when all sweep heartbeats exceed the max sweep age', async () => {
      WorkerHealthTelemetryService.markStarted();
      WorkerHealthTelemetryService.recordSweep('settlement', 1);

      // Age the heartbeat beyond the configured max sweep age.
      const originalMaxAge = config.worker.livenessMaxSweepAgeMs;
      (config.worker as any).livenessMaxSweepAgeMs = 50;

      try {
        await new Promise((resolve) => setTimeout(resolve, 80));
        const snapshot = WorkerHealthTelemetryService.getHealthSnapshot();
        expect(snapshot.state).toBe('STALLED');
        expect(snapshot.stallReason).toContain('50');
      } finally {
        (config.worker as any).livenessMaxSweepAgeMs = originalMaxAge;
      }
    });

    it('records sweep heartbeats for every daemon sweep type', () => {
      WorkerHealthTelemetryService.markStarted();
      WorkerHealthTelemetryService.recordSweep('settlement', 2);
      WorkerHealthTelemetryService.recordSweep('reservationCleanup', 5);
      WorkerHealthTelemetryService.recordSweep('paymentReconciliation', 1);
      WorkerHealthTelemetryService.recordSweep('reconciliation', 0);

      const snapshot = WorkerHealthTelemetryService.getHealthSnapshot();

      expect(snapshot.sweeps.settlement?.lastSweepCount).toBe(2);
      expect(snapshot.sweeps.reservationCleanup?.lastSweepCount).toBe(5);
      expect(snapshot.sweeps.paymentReconciliation?.lastSweepCount).toBe(1);
      expect(snapshot.sweeps.reconciliation?.lastSweepCount).toBe(0);
      expect(new Date(snapshot.sweeps.settlement!.lastSweepAt).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('reports STOPPED after shutdown lifecycle heartbeat', async () => {
      WorkerHealthTelemetryService.markStarted();
      WorkerHealthTelemetryService.recordSweep('settlement', 1);
      WorkerHealthTelemetryService.markStopped();

      const snapshot = WorkerHealthTelemetryService.getHealthSnapshot();

      expect(snapshot.state).toBe('STOPPED');
      expect(snapshot.lifecycle.state).toBe('STOPPED');
      expect(snapshot.lifecycle.startedAt).not.toBeNull();
      expect(snapshot.lifecycle.stoppedAt).not.toBeNull();
    });

    it('tracks active jobs count with safe decrement floor at zero', () => {
      expect(WorkerHealthTelemetryService.getHealthSnapshot().activeJobs).toBe(0);

      WorkerHealthTelemetryService.incrementActiveJobs();
      WorkerHealthTelemetryService.incrementActiveJobs();
      expect(WorkerHealthTelemetryService.getHealthSnapshot().activeJobs).toBe(2);

      WorkerHealthTelemetryService.decrementActiveJobs();
      expect(WorkerHealthTelemetryService.getHealthSnapshot().activeJobs).toBe(1);

      WorkerHealthTelemetryService.decrementActiveJobs();
      WorkerHealthTelemetryService.decrementActiveJobs();
      WorkerHealthTelemetryService.decrementActiveJobs(); // extra decrement must not go negative
      expect(WorkerHealthTelemetryService.getHealthSnapshot().activeJobs).toBe(0);
    });

    it('counts distributed-lock acquisition failures in telemetry', () => {
      WorkerHealthTelemetryService.recordLockAcquisitionFailure('lock:worker:settlement-sweep');
      WorkerHealthTelemetryService.recordLockAcquisitionFailure('lock:worker:settlement-sweep');

      const snapshot = WorkerHealthTelemetryService.getHealthSnapshot();
      expect(snapshot.lockAcquisitionFailures).toBe(2);
    });

    it('exposes a secret-free payload (no credentials in snapshot)', () => {
      WorkerHealthTelemetryService.markStarted();
      WorkerHealthTelemetryService.recordSweep('settlement', 1);
      WorkerHealthTelemetryService.recordLockAcquisitionFailure();

      const snapshot = WorkerHealthTelemetryService.getHealthSnapshot() as Record<string, unknown>;
      const serialized = JSON.stringify(snapshot).toLowerCase();

      for (const forbidden of ['secret', 'password', 'token', 'seed', 'apikey', 'api_key', 'private']) {
        expect(serialized).not.toContain(forbidden);
      }

      // Only allowlisted diagnostic keys are present.
      expect(Object.keys(snapshot).sort()).toEqual(
        [
          'activeJobs',
          'hasCompletedSweep',
          'lifecycle',
          'lockAcquisitionFailures',
          'pid',
          'state',
          'sweeps',
          'timestamp',
          'uptimeSeconds',
          // 'stallReason' only present when stalled
        ].sort()
      );
    });
  });

  describe('Liveness HTTP endpoint', () => {
    it('returns 200 HEALTHY when worker is running with fresh sweep heartbeats', async () => {
      server = new WorkerLivenessServer({ port: 0 });
      await server.start();
      const port = server.getPort()!;

      WorkerHealthTelemetryService.markStarted();
      WorkerHealthTelemetryService.recordSweep('settlement', 1);

      const res = await getJson(`http://127.0.0.1:${port}${WORKER_LIVENESS_PATH}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.state).toBe('HEALTHY');
      expect(res.body.lifecycle.state).toBe('RUNNING');
    });

    it('returns 503 STALLED when worker is running without fresh sweeps', async () => {
      server = new WorkerLivenessServer({ port: 0 });
      await server.start();
      const port = server.getPort()!;

      WorkerHealthTelemetryService.markStarted();
      // No sweep heartbeat recorded -> stalled.

      const res = await getJson(`http://127.0.0.1:${port}${WORKER_LIVENESS_PATH}`);
      expect(res.statusCode).toBe(503);
      expect(res.body.state).toBe('STALLED');
      expect(res.body.stallReason).toBeDefined();
    });

    it('returns 503 NOT_STARTED before worker startup', async () => {
      server = new WorkerLivenessServer({ port: 0 });
      await server.start();
      const port = server.getPort()!;

      const res = await getJson(`http://127.0.0.1:${port}${WORKER_LIVENESS_PATH}`);
      expect(res.statusCode).toBe(503);
      expect(res.body.state).toBe('NOT_STARTED');
    });

    it('returns 503 STOPPED after worker shutdown', async () => {
      server = new WorkerLivenessServer({ port: 0 });
      await server.start();
      const port = server.getPort()!;

      WorkerHealthTelemetryService.markStarted();
      WorkerHealthTelemetryService.recordSweep('settlement', 1);
      WorkerHealthTelemetryService.markStopped();

      const res = await getJson(`http://127.0.0.1:${port}${WORKER_LIVENESS_PATH}`);
      expect(res.statusCode).toBe(503);
      expect(res.body.state).toBe('STOPPED');
    });

    it('returns 404 for unknown paths and rejects non-GET methods', async () => {
      server = new WorkerLivenessServer({ port: 0 });
      await server.start();
      const port = server.getPort()!;

      const missing = await getJson(`http://127.0.0.1:${port}/nope`);
      expect(missing.statusCode).toBe(404);

      const status: number = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: WORKER_LIVENESS_PATH, method: 'POST' },
          (res) => {
            res.resume();
            resolve(res.statusCode || 0);
          }
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(404);
    });

    it('supports concurrent probes', async () => {
      server = new WorkerLivenessServer({ port: 0 });
      await server.start();
      const port = server.getPort()!;

      WorkerHealthTelemetryService.markStarted();
      WorkerHealthTelemetryService.recordSweep('reconciliation', 4);

      const responses = await Promise.all([
        getJson(`http://127.0.0.1:${port}${WORKER_LIVENESS_PATH}`),
        getJson(`http://127.0.0.1:${port}${WORKER_LIVENESS_PATH}`),
        getJson(`http://127.0.0.1:${port}${WORKER_LIVENESS_PATH}`),
      ]);

      expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    });
  });

  describe('Worker runner integration', () => {
    it('runner records sweep heartbeats and lifecycle transitions through runSweep/stop', async () => {
      const { LuminaRailWorkerRunner } = await import('../../src/worker.js');
      const { AuditService } = await import('../../src/modules/audit/audit.service.js');

      const auditSpy = vi.spyOn(AuditService, 'log').mockResolvedValue({} as any);
      const runner = new LuminaRailWorkerRunner();
      vi.spyOn((runner as any).settlementWorker, 'processPendingOrders').mockResolvedValue([1, 2] as any);
      vi.spyOn((runner as any).reservationCleanupWorker, 'processExpiredReservations').mockResolvedValue([] as any);
      vi.spyOn((runner as any).reconciliationDaemon, 'processPaymentReconciliation').mockResolvedValue([] as any);
      vi.spyOn((runner as any).reconciliationDaemon, 'processReconciliation').mockResolvedValue([] as any);

      try {
        await runner.runSweep();

        const snapshot = WorkerHealthTelemetryService.getHealthSnapshot();
        expect(snapshot.sweeps.settlement?.lastSweepCount).toBe(2);
        expect(snapshot.sweeps.reservationCleanup?.lastSweepCount).toBe(0);
        expect(snapshot.sweeps.paymentReconciliation?.lastSweepCount).toBe(0);
        expect(snapshot.sweeps.reconciliation?.lastSweepCount).toBe(0);
        expect(snapshot.activeJobs).toBe(0);

        await runner.stop();
        const stopped = WorkerHealthTelemetryService.getHealthSnapshot();
        expect(stopped.lifecycle.state).toBe('STOPPED');
      } finally {
        auditSpy.mockRestore();
      }
    });

    it('runner start/stop records lifecycle and starts liveness server when enabled', async () => {
      const { LuminaRailWorkerRunner } = await import('../../src/worker.js');
      const { AuditService } = await import('../../src/modules/audit/audit.service.js');

      const auditSpy = vi.spyOn(AuditService, 'log').mockResolvedValue({} as any);
      const runner = new LuminaRailWorkerRunner();

      vi.spyOn((runner as any).settlementWorker, 'processPendingOrders').mockResolvedValue([] as any);
      vi.spyOn((runner as any).reservationCleanupWorker, 'processExpiredReservations').mockResolvedValue([] as any);
      vi.spyOn((runner as any).reconciliationDaemon, 'processPaymentReconciliation').mockResolvedValue([] as any);
      vi.spyOn((runner as any).reconciliationDaemon, 'processReconciliation').mockResolvedValue([] as any);

      try {
        await runner.start({ runOnce: true, livenessEnabled: true, livenessPort: 0 });
        const running = WorkerHealthTelemetryService.getHealthSnapshot();
        expect(running.lifecycle.state).toBe('RUNNING');
        // runOnce sweep completed -> fresh heartbeat -> HEALTHY
        expect(running.state).toBe('HEALTHY');

        const livenessServer = (runner as any).livenessServer as WorkerLivenessServer | null;
        expect(livenessServer).not.toBeNull();
        expect(livenessServer!.getPort()).not.toBeNull();

        await runner.stop();
        const stopped = WorkerHealthTelemetryService.getHealthSnapshot();
        expect(stopped.lifecycle.state).toBe('STOPPED');
        expect(((runner as any).livenessServer as WorkerLivenessServer | null)).toBeNull();
      } finally {
        auditSpy.mockRestore();
      }
    });
  });
});

import http from 'http';
import type { AddressInfo } from 'net';
import { WorkerHealthTelemetryService } from './worker-health-telemetry.service.js';

export const WORKER_LIVENESS_PATH = '/health';

/**
 * Minimal standalone HTTP liveness server for the background worker process.
 *
 * Exposes a single endpoint `GET /health` returning:
 * - `200` with a secret-free health snapshot when the worker is healthy
 *   (including a healthy idle worker with fresh sweep heartbeats),
 * - `503` with a secret-free health snapshot when the worker is stalled,
 *   stopped, or not started.
 *
 * Runs in-process alongside the worker loop so container orchestrators
 * (e.g. Render worker services with a health check path) can probe liveness.
 */
export class WorkerLivenessServer {
  private server: http.Server | null = null;
  private port: number;
  private readonly path: string;

  constructor(options: { port?: number; path?: string } = {}) {
    this.port = options.port ?? 4001;
    this.path = options.path ?? WORKER_LIVENESS_PATH;
  }

  public getPort(): number | null {
    if (!this.server) {
      return null;
    }
    const address = this.server.address() as AddressInfo | null;
    if (address && typeof address === 'object') {
      return address.port;
    }
    return null;
  }

  public async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = http.createServer((req, res) => {
      // Only the liveness path is exposed; anything else is a bare 404.
      if (req.method !== 'GET' || !req.url || req.url.split('?')[0] !== this.path) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND' }));
        return;
      }

      const snapshot = WorkerHealthTelemetryService.getHealthSnapshot();
      const statusCode = snapshot.state === 'HEALTHY' ? 200 : 503;

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
    });

    // Liveness probing must never be broken by keep-alive connections lingering.
    server.keepAliveTimeout = 1000;

    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.close();
        reject(err);
      };
      server.once('error', onError);
      server.listen(this.port, () => {
        server.off('error', onError);
        const boundPort = this.getPort();
        if (boundPort !== null && boundPort !== undefined) {
          this.port = boundPort;
        }
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

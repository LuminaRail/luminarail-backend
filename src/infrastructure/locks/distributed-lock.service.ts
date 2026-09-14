import crypto from 'crypto';
import { RedisService } from '../redis/redis.service.js';
import { config } from '../../config/index.js';
import { AuditService } from '../../modules/audit/audit.service.js';
import { WorkerHealthTelemetryService } from '../telemetry/worker-health-telemetry.service.js';

export interface LockOptions {
  ttlMs?: number;
  heartbeatMs?: number;
  workerId?: string;
  onLockLost?: (key: string, ownerToken: string) => void | Promise<void>;
}

export class DistributedLock {
  public readonly key: string;
  public readonly ownerToken: string;
  public readonly ttlMs: number;
  private owned: boolean = true;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly onLockLost?: (key: string, ownerToken: string) => void | Promise<void>;

  constructor(
    key: string,
    ownerToken: string,
    ttlMs: number,
    onLockLost?: (key: string, ownerToken: string) => void | Promise<void>
  ) {
    this.key = key;
    this.ownerToken = ownerToken;
    this.ttlMs = ttlMs;
    this.onLockLost = onLockLost;
  }

  public isOwned(): boolean {
    return this.owned;
  }

  public markLost(): void {
    if (this.owned) {
      this.owned = false;
      this.stopHeartbeat();
      if (this.onLockLost) {
        try {
          this.onLockLost(this.key, this.ownerToken);
        } catch (err) {
          console.error(`❌ Error in onLockLost callback for key ${this.key}:`, err);
        }
      }
    }
  }

  public startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      if (!this.owned) {
        this.stopHeartbeat();
        return;
      }
      const renewed = await DistributedLockService.renew(this);
      if (!renewed) {
        console.warn(`⚠️ [DistributedLock] Lock renewal failed for key ${this.key}. Ownership token lost.`);
        this.markLost();
      }
    }, intervalMs);
  }

  public stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

export class DistributedLockService {
  private static workerProcessId = `worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

  public static getWorkerProcessId(): string {
    return DistributedLockService.workerProcessId;
  }

  /**
   * Generates a unique ownership token per acquisition.
   */
  public static generateOwnerToken(workerId?: string): string {
    const prefix = workerId || DistributedLockService.workerProcessId;
    return `${prefix}:${crypto.randomUUID()}`;
  }

  /**
   * Attempts to acquire an atomic distributed lock via Redis SET key ownerToken NX PX ttlMs.
   */
  public static async acquire(
    key: string,
    options: LockOptions = {}
  ): Promise<DistributedLock | null> {
    const ttlMs = options.ttlMs || config.redis?.lockTtlMs || 15000;
    const heartbeatMs = options.heartbeatMs || config.redis?.lockHeartbeatMs || Math.floor(ttlMs / 3);
    const ownerToken = DistributedLockService.generateOwnerToken(options.workerId);

    try {
      const client = RedisService.getClient();
      const result = await client.set(key, ownerToken, 'PX', ttlMs, 'NX');

      if (result !== 'OK' && result !== 1) {
        return null; // Lock already held by another worker process
      }

      const lock = new DistributedLock(key, ownerToken, ttlMs, options.onLockLost);
      lock.startHeartbeat(heartbeatMs);

      await AuditService.log({
        actor: options.workerId || DistributedLockService.workerProcessId,
        action: 'DISTRIBUTED_LOCK_ACQUIRED',
        resource: 'DistributedLock',
        details: { key, ownerToken, ttlMs },
      });

      return lock;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Redis error';
      console.warn(`⚠️ [DistributedLockService] Redis lock acquisition error for key ${key}: ${errMsg}`);

      // Record lock acquisition failure for worker liveness telemetry.
      WorkerHealthTelemetryService.recordLockAcquisitionFailure(key);

      if (config.redis?.requireDistributedLocks || config.env === 'production') {
        throw new Error(`Distributed lock required but unavailable for key ${key}: ${errMsg}`);
      }

      return null;
    }
  }

  /**
   * Atomically renews lock TTL only if key value matches ownerToken (Lua script).
   */
  public static async renew(lock: DistributedLock): Promise<boolean> {
    if (!lock.isOwned()) {
      return false;
    }

    const luaRenewScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    try {
      const client = RedisService.getClient();
      const result = await client.eval(luaRenewScript, 1, lock.key, lock.ownerToken, lock.ttlMs);
      const isRenewed = result === 1 || result === '1';

      if (!isRenewed) {
        lock.markLost();
      }

      return isRenewed;
    } catch (err) {
      console.warn(`⚠️ [DistributedLockService] Lock renewal exception for ${lock.key}:`, err);
      lock.markLost();
      return false;
    }
  }

  /**
   * Atomically releases lock only if key value matches ownerToken (Lua script).
   * NEVER uses unconditional DEL.
   */
  public static async release(lock: DistributedLock | null): Promise<boolean> {
    if (!lock) {
      return false;
    }

    lock.stopHeartbeat();

    if (!lock.isOwned()) {
      return false;
    }

    const luaReleaseScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    try {
      const client = RedisService.getClient();
      const result = await client.eval(luaReleaseScript, 1, lock.key, lock.ownerToken);
      const released = result === 1 || result === '1';

      lock.markLost(); // Stop heartbeat and mark inactive

      await AuditService.log({
        actor: DistributedLockService.workerProcessId,
        action: 'DISTRIBUTED_LOCK_RELEASED',
        resource: 'DistributedLock',
        details: { key: lock.key, ownerToken: lock.ownerToken, released },
      });

      return released;
    } catch (err) {
      console.warn(`⚠️ [DistributedLockService] Lock release error for ${lock.key}:`, err);
      lock.markLost();
      return false;
    }
  }

  /**
   * High-level helper that executes fn inside an acquired lock context and releases in finally.
   */
  public static async withLock<T>(
    key: string,
    options: LockOptions,
    fn: (lock: DistributedLock) => Promise<T>
  ): Promise<T | null> {
    const lock = await DistributedLockService.acquire(key, options);
    if (!lock) {
      return null;
    }

    try {
      return await fn(lock);
    } finally {
      await DistributedLockService.release(lock);
    }
  }
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryMockRedis } from '../../src/infrastructure/redis/redis.mock.js';
import { RedisService } from '../../src/infrastructure/redis/redis.service.js';
import { DistributedLockService, DistributedLock } from '../../src/infrastructure/locks/distributed-lock.service.js';

describe('DistributedLockService', () => {
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = new InMemoryMockRedis();
    RedisService.setMockClient(mockRedis);
  });

  afterEach(async () => {
    await mockRedis.flushall();
    await RedisService.close();
  });

  it('1. Successfully acquires an unheld lock', async () => {
    const lock = await DistributedLockService.acquire('test-lock-1', { ttlMs: 5000 });
    expect(lock).not.toBeNull();
    expect(lock?.isOwned()).toBe(true);
    expect(lock?.key).toBe('test-lock-1');
    expect(lock?.ownerToken).toBeDefined();

    if (lock) {
      await DistributedLockService.release(lock);
    }
  });

  it('2. Prevents second worker from acquiring the same lock while held (Scenario A)', async () => {
    const lock1 = await DistributedLockService.acquire('test-lock-2', { ttlMs: 5000 });
    const lock2 = await DistributedLockService.acquire('test-lock-2', { ttlMs: 5000 });

    expect(lock1).not.toBeNull();
    expect(lock2).toBeNull();

    if (lock1) {
      await DistributedLockService.release(lock1);
    }
  });

  it('3. Ownership release check: Worker B cannot release Worker A lock (Scenario C)', async () => {
    const lockA = await DistributedLockService.acquire('test-lock-3', { ttlMs: 5000 });
    const fakeLockB = new DistributedLock('test-lock-3', 'fake-token-b', 5000);

    const releasedByB = await DistributedLockService.release(fakeLockB);
    expect(releasedByB).toBe(false);

    // Verify key still exists in Redis under Worker A's ownership
    const valInRedis = await mockRedis.get('test-lock-3');
    expect(valInRedis).toBe(lockA?.ownerToken);

    if (lockA) {
      await DistributedLockService.release(lockA);
    }
  });

  it('4. Allows acquisition after previous lock expires (Scenario D & N)', async () => {
    const lock1 = await DistributedLockService.acquire('test-lock-4', { ttlMs: 100 });
    expect(lock1).not.toBeNull();

    // Fast-forward or wait past TTL
    await new Promise((resolve) => setTimeout(resolve, 150));

    const lock2 = await DistributedLockService.acquire('test-lock-4', { ttlMs: 5000 });
    expect(lock2).not.toBeNull();

    if (lock2) {
      await DistributedLockService.release(lock2);
    }
  });

  it('5. Lock renewal extends TTL for active lock (Scenario F)', async () => {
    const lock = await DistributedLockService.acquire('test-lock-5', { ttlMs: 1000 });
    expect(lock).not.toBeNull();

    const renewed = await DistributedLockService.renew(lock!);
    expect(renewed).toBe(true);

    if (lock) {
      await DistributedLockService.release(lock);
    }
  });

  it('6. Renewal fails safely after ownership loss (Scenario G)', async () => {
    const lock = await DistributedLockService.acquire('test-lock-6', { ttlMs: 5000 });
    expect(lock).not.toBeNull();

    // Manually overwrite token in Redis simulating lock theft/expiry
    await mockRedis.set('test-lock-6', 'stolen-token');

    const renewed = await DistributedLockService.renew(lock!);
    expect(renewed).toBe(false);
    expect(lock?.isOwned()).toBe(false);
  });

  it('7. Invokes onLockLost callback when lock is lost (Scenario E & T)', async () => {
    const lostCallback = vi.fn();
    const lock = await DistributedLockService.acquire('test-lock-7', {
      ttlMs: 5000,
      onLockLost: lostCallback,
    });

    lock?.markLost();

    expect(lock?.isOwned()).toBe(false);
    expect(lostCallback).toHaveBeenCalledWith('test-lock-7', lock?.ownerToken);
  });

  it('8. withLock helper executes callback and safely releases lock', async () => {
    const executed = await DistributedLockService.withLock(
      'test-lock-8',
      { ttlMs: 5000 },
      async (lock) => {
        expect(lock.isOwned()).toBe(true);
        return 'SUCCESS';
      }
    );

    expect(executed).toBe('SUCCESS');

    // Key should be deleted after withLock finishes
    const valInRedis = await mockRedis.get('test-lock-8');
    expect(valInRedis).toBeNull();
  });
});

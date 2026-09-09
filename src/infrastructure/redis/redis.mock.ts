import { EventEmitter } from 'events';

export class InMemoryMockRedis extends EventEmitter {
  private store: Map<string, { value: string; expiresAt?: number }> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();

  public async set(
    key: string,
    value: string,
    mode1?: string,
    durationMs?: number,
    mode2?: string
  ): Promise<string | null> {
    this.cleanExpired(key);

    const isNx = mode1 === 'NX' || mode2 === 'NX';
    const hasTtl = mode1 === 'PX' || mode2 === 'PX';
    const ttl = durationMs || (typeof mode1 === 'number' ? mode1 : undefined);

    if (isNx && this.store.has(key)) {
      return null;
    }

    const expiresAt = hasTtl && ttl ? Date.now() + ttl : undefined;
    this.store.set(key, { value, expiresAt });

    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key)!);
      this.timers.delete(key);
    }

    if (hasTtl && ttl) {
      const timer = setTimeout(() => {
        this.store.delete(key);
        this.timers.delete(key);
      }, ttl);
      this.timers.set(key, timer);
    }

    return 'OK';
  }

  public async get(key: string): Promise<string | null> {
    this.cleanExpired(key);
    const item = this.store.get(key);
    return item ? item.value : null;
  }

  public async del(...keys: string[]): Promise<number> {
    let deletedCount = 0;
    for (const key of keys) {
      this.cleanExpired(key);
      if (this.timers.has(key)) {
        clearTimeout(this.timers.get(key)!);
        this.timers.delete(key);
      }
      if (this.store.delete(key)) {
        deletedCount++;
      }
    }
    return deletedCount;
  }

  public async pexpire(key: string, ttlMs: number): Promise<number> {
    this.cleanExpired(key);
    const item = this.store.get(key);
    if (!item) {
      return 0;
    }

    item.expiresAt = Date.now() + ttlMs;
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key)!);
    }
    const timer = setTimeout(() => {
      this.store.delete(key);
      this.timers.delete(key);
    }, ttlMs);
    this.timers.set(key, timer);

    return 1;
  }

  public async eval(script: string, numKeys: number, ...args: any[]): Promise<number> {
    const key = args[0];
    const val = args[1];
    const ttl = args[2] ? parseInt(args[2], 10) : undefined;

    this.cleanExpired(key);
    const currentVal = await this.get(key);

    if (script.includes('pexpire')) {
      if (currentVal === val) {
        if (ttl) {
          await this.pexpire(key, ttl);
        }
        return 1;
      }
      return 0;
    }

    if (script.includes('del')) {
      if (currentVal === val) {
        await this.del(key);
        return 1;
      }
      return 0;
    }

    return 0;
  }

  public async flushall(): Promise<'OK'> {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.store.clear();
    return 'OK';
  }

  public async quit(): Promise<'OK'> {
    return this.flushall();
  }

  public disconnect(): void {
    this.flushall();
  }

  private cleanExpired(key: string): void {
    const item = this.store.get(key);
    if (item && item.expiresAt && item.expiresAt <= Date.now()) {
      this.store.delete(key);
      if (this.timers.has(key)) {
        clearTimeout(this.timers.get(key)!);
        this.timers.delete(key);
      }
    }
  }
}

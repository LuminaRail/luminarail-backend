export interface IStellarCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

interface CacheItem<T> {
  value: T;
  expiresAt: number;
}

export class InMemoryStellarCache implements IStellarCache {
  private store = new Map<string, CacheItem<any>>();

  async get<T>(key: string): Promise<T | null> {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds = 15): Promise<void> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

let stellarCacheInstance: IStellarCache | null = null;

export function getStellarCache(): IStellarCache {
  if (!stellarCacheInstance) {
    stellarCacheInstance = new InMemoryStellarCache();
  }
  return stellarCacheInstance;
}

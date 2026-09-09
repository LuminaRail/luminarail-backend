import Redis, { Redis as RedisClient } from 'ioredis';
import { config } from '../../config/index.js';
import { InMemoryMockRedis } from './redis.mock.js';

export class RedisService {
  private static instance: RedisClient | null = null;
  private static mockInstance: any = null;

  public static setMockClient(mockClient: any): void {
    RedisService.mockInstance = mockClient;
  }

  public static getClient(): RedisClient | any {
    if (RedisService.mockInstance) {
      return RedisService.mockInstance;
    }

    if (config.env === 'test') {
      if (!RedisService.mockInstance) {
        RedisService.mockInstance = new InMemoryMockRedis();
      }
      return RedisService.mockInstance;
    }

    if (!RedisService.instance) {
      const redisUrl = config.redis?.url || process.env.REDIS_URL || 'redis://localhost:6379';
      RedisService.instance = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          if (times > 3) {
            return null; // Stop retrying after 3 attempts
          }
          return Math.min(times * 100, 2000);
        },
      });

      // Handle unhandled error events to avoid crashing the node process silently
      RedisService.instance.on('error', (err) => {
        if (config.env !== 'test') {
          console.warn('⚠️ [RedisService] Redis client connection warning/error:', err.message);
        }
      });
    }

    return RedisService.instance;
  }

  public static async close(): Promise<void> {
    if (RedisService.instance) {
      try {
        await RedisService.instance.quit();
      } catch {
        RedisService.instance.disconnect();
      }
      RedisService.instance = null;
    }
    if (RedisService.mockInstance) {
      try {
        if (typeof RedisService.mockInstance.quit === 'function') {
          await RedisService.mockInstance.quit();
        }
      } catch {
        // ignore shutdown error in test mock
      }
      RedisService.mockInstance = null;
    }
  }
}

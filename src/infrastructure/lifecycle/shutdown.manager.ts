import { RedisService } from '../redis/redis.service.js';
import { prisma } from '../../db/prisma.js';

export class ShutdownManager {
  private static registered = false;
  private static activeJobsCount = 0;
  private static shuttingDown = false;

  public static isShuttingDown(): boolean {
    return ShutdownManager.shuttingDown;
  }

  public static registerShutdownHandlers(): void {
    if (ShutdownManager.registered) {
      return;
    }
    ShutdownManager.registered = true;

    const handleSignal = async (signal: string) => {
      console.log(`\n🛑 [ShutdownManager] Received ${signal}. Initiating graceful shutdown...`);
      ShutdownManager.shuttingDown = true;

      const shutdownTimeout = setTimeout(() => {
        console.warn('⚠️ [ShutdownManager] Shutdown timeout reached (10s). Forcing process exit.');
        process.exit(1);
      }, 10000);

      try {
        // Wait briefly for active worker tasks to finish
        let waitAttempts = 0;
        while (ShutdownManager.activeJobsCount > 0 && waitAttempts < 20) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          waitAttempts++;
        }

        // Close Redis and Prisma connections cleanly
        await RedisService.close();
        await prisma.$disconnect();

        clearTimeout(shutdownTimeout);
        console.log('✅ [ShutdownManager] Graceful shutdown complete.');
        process.exit(0);
      } catch (err) {
        console.error('❌ [ShutdownManager] Error during graceful shutdown:', err);
        clearTimeout(shutdownTimeout);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => handleSignal('SIGTERM'));
    process.on('SIGINT', () => handleSignal('SIGINT'));
  }

  public static incrementActiveJobs(): void {
    ShutdownManager.activeJobsCount++;
  }

  public static decrementActiveJobs(): void {
    if (ShutdownManager.activeJobsCount > 0) {
      ShutdownManager.activeJobsCount--;
    }
  }
}

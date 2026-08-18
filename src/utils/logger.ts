import { requestContextStore } from '../middleware/request-id';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  requestId?: string;
  message: string;
  path?: string;
  duration?: number | string;
  [key: string]: any;
}

class Logger {
  private formatLog(
    level: LogLevel,
    message: string,
    meta: Record<string, any> = {}
  ): string {
    const store = requestContextStore.getStore();

    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      ...(store?.requestId && { requestId: store.requestId }),
      message,
      ...meta,
    };

    return JSON.stringify(logEntry);
  }

  info(message: string, meta?: Record<string, any>): void {
    console.log(this.formatLog('info', message, meta));
  }

  warn(message: string, meta?: Record<string, any>): void {
    console.warn(this.formatLog('warn', message, meta));
  }

  error(message: string, meta?: Record<string, any>): void {
    console.error(this.formatLog('error', message, meta));
  }

  debug(message: string, meta?: Record<string, any>): void {
    console.debug(this.formatLog('debug', message, meta));
  }
}

export const logger = new Logger();
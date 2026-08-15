import { prisma } from '../../db/prisma.js';

export interface CreateAuditLogParams {
  actor?: string;
  userId?: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, unknown> | string;
  ipAddress?: string;
}

const SENSITIVE_KEYS = [
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'secret',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'seed',
  'seedphrase',
  'seed_phrase',
];

function sanitizeDetails(details: unknown): string | undefined {
  if (!details) return undefined;
  if (typeof details === 'string') return details;
  try {
    const cleaned = JSON.parse(JSON.stringify(details), (key, value) => {
      if (SENSITIVE_KEYS.includes(key.toLowerCase())) {
        return '[REDACTED]';
      }
      return value;
    });
    return JSON.stringify(cleaned);
  } catch {
    return undefined;
  }
}

export class AuditService {
  static async log(params: CreateAuditLogParams) {
    try {
      const sanitizedDetails = sanitizeDetails(params.details);
      return await prisma.auditLog.create({
        data: {
          actor: params.actor || params.userId || 'system',
          userId: params.userId,
          action: params.action,
          resource: params.resource,
          resourceId: params.resourceId,
          details: sanitizedDetails,
          ipAddress: params.ipAddress,
        },
      });
    } catch (err) {
      console.error('Failed to write audit log:', err);
    }
  }

  static async listLogs(limit = 50, offset = 0) {
    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.auditLog.count(),
    ]);
    return { logs, total, limit, offset };
  }
}

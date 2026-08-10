import { SettlementStatus } from '@prisma/client';

export interface CreateSettlementOptions {
  orderId: string;
  actorId?: string;
  ipAddress?: string;
}

export interface ListSettlementsQuery {
  limit?: number;
  offset?: number;
  status?: SettlementStatus;
}

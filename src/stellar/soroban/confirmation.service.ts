import { rpc } from '@stellar/stellar-sdk';
import { getSorobanClient, StellarSorobanClient } from './client.js';
import { SorobanConfirmationError } from '../../errors/index.js';
import { SettlementConfirmationResult, SettlementStatusResult } from '../settlement.executor.js';

export interface ConfirmationOptions {
  maxAttempts?: number;
  intervalMs?: number;
}

export class SorobanConfirmationService {
  private clientInstance: StellarSorobanClient | null = null;

  constructor(client?: StellarSorobanClient) {
    if (client) {
      this.clientInstance = client;
    }
  }

  private get sorobanClient(): StellarSorobanClient {
    if (!this.clientInstance) {
      this.clientInstance = getSorobanClient();
    }
    return this.clientInstance;
  }

  public async getTransactionStatus(txHash: string): Promise<SettlementStatusResult> {
    try {
      const response = await this.sorobanClient.getTransaction(txHash);

      if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return {
          status: 'SUCCESS',
          ledger: response.ledger,
        };
      }

      if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
        return {
          status: 'FAILED',
          ledger: response.ledger,
          error: 'Transaction failed during on-chain execution.',
        };
      }

      if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
        return {
          status: 'NOT_FOUND',
        };
      }

      return {
        status: 'PENDING',
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown RPC error fetching transaction status';
      return {
        status: 'FAILED',
        error: message,
      };
    }
  }

  public async confirmTransaction(
    txHash: string,
    options: ConfirmationOptions = {}
  ): Promise<SettlementConfirmationResult> {
    const maxAttempts = options.maxAttempts || 10;
    const intervalMs = options.intervalMs || 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const statusResult = await this.getTransactionStatus(txHash);

        if (statusResult.status === 'SUCCESS') {
          return {
            confirmed: true,
            ledger: statusResult.ledger,
          };
        }

        if (statusResult.status === 'FAILED') {
          return {
            confirmed: false,
            error: statusResult.error || 'Transaction execution failed on Stellar network.',
          };
        }
      } catch (err: unknown) {
        if (attempt === maxAttempts) {
          throw new SorobanConfirmationError(
            `Failed to confirm transaction ${txHash} after ${maxAttempts} attempts.`,
            err
          );
        }
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    return {
      confirmed: false,
      error: `Transaction confirmation timed out after ${maxAttempts} attempts.`,
    };
  }
}

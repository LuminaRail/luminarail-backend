import { getHorizonClient } from '../horizon/client.js';
import { StellarError, BadRequestError } from '../../errors/index.js';

export interface NormalizedStellarTransaction {
  hash: string;
  ledger: number;
  successful: boolean;
  createdAt: string;
  sourceAccount: string;
  feePaid: string;
  operationCount: number;
  memo?: string;
  memoType?: string;
}

export class StellarTransactionService {
  public validateHash(hash: string): boolean {
    if (!hash || typeof hash !== 'string') return false;
    const hexPattern = /^[0-9a-fA-F]{64}$/;
    return hexPattern.test(hash.trim());
  }

  public async getTransaction(hash: string): Promise<NormalizedStellarTransaction> {
    const cleanHash = (hash || '').trim();
    if (!this.validateHash(cleanHash)) {
      throw new BadRequestError('Invalid Stellar transaction hash format. Expected 64-char hex string.');
    }

    const horizon = getHorizonClient();
    const txRecord = await horizon.fetchTransaction(cleanHash);

    return {
      hash: txRecord.hash,
      ledger: txRecord.ledger_attr,
      successful: txRecord.successful,
      createdAt: txRecord.created_at,
      sourceAccount: txRecord.source_account,
      feePaid: String(txRecord.fee_charged),
      operationCount: txRecord.operation_count,
      memo: txRecord.memo,
      memoType: txRecord.memo_type,
    };
  }

  public async getTransactionStatus(hash: string): Promise<{ hash: string; successful: boolean; ledger: number }> {
    const tx = await this.getTransaction(hash);
    return {
      hash: tx.hash,
      successful: tx.successful,
      ledger: tx.ledger,
    };
  }

  public async verifyTransaction(txHash: string): Promise<boolean> {
    try {
      const tx = await this.getTransaction(txHash);
      return tx.successful;
    } catch {
      return false;
    }
  }
}

let transactionServiceInstance: StellarTransactionService | null = null;

export function getStellarTransactionService(): StellarTransactionService {
  if (!transactionServiceInstance) {
    transactionServiceInstance = new StellarTransactionService();
  }
  return transactionServiceInstance;
}

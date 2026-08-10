export interface SubmitSettlementParams {
  settlementId: string;
  orderId: string;
  source: string;
  destination: string;
  amount: string;
  asset: string;
  contractAddress?: string | null;
}

export interface SettlementExecutionResult {
  submitted: boolean;
  transactionHash?: string;
  error?: string;
}

export interface SettlementStatusResult {
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
  ledger?: number;
  error?: string;
}

export interface SettlementConfirmationResult {
  confirmed: boolean;
  ledger?: number;
  error?: string;
}

export interface SettlementExecutor {
  submitSettlement(params: SubmitSettlementParams): Promise<SettlementExecutionResult>;
  getSettlementStatus(txHash: string): Promise<SettlementStatusResult>;
  confirmSettlement(txHash: string): Promise<SettlementConfirmationResult>;
}

/**
 * TEST / MOCK IMPLEMENTATION ONLY (Phase 5A)
 * Does NOT submit live Soroban or Stellar transactions.
 * Does NOT handle or require secret keys.
 * Clearly marked as test/mock implementation boundary.
 */
export class MockSettlementExecutor implements SettlementExecutor {
  private shouldFailSubmission = false;
  private shouldFailConfirmation = false;

  public setSubmissionFailure(fail: boolean): void {
    this.shouldFailSubmission = fail;
  }

  public setConfirmationFailure(fail: boolean): void {
    this.shouldFailConfirmation = fail;
  }

  public async submitSettlement(params: SubmitSettlementParams): Promise<SettlementExecutionResult> {
    if (this.shouldFailSubmission) {
      return {
        submitted: false,
        error: 'Simulated submission failure on Stellar Testnet boundary',
      };
    }

    const transactionHash = `MOCK_TX_HASH_${params.settlementId}`;
    return {
      submitted: true,
      transactionHash,
    };
  }

  public async getSettlementStatus(_txHash: string): Promise<SettlementStatusResult> {
    if (this.shouldFailConfirmation) {
      return {
        status: 'FAILED',
        error: 'Simulated status failure on Stellar Testnet boundary',
      };
    }
    return {
      status: 'SUCCESS',
      ledger: 12345678,
    };
  }

  public async confirmSettlement(_txHash: string): Promise<SettlementConfirmationResult> {
    if (this.shouldFailConfirmation) {
      return {
        confirmed: false,
        error: 'Simulated confirmation failure on Stellar Testnet boundary',
      };
    }

    return {
      confirmed: true,
      ledger: 12345678,
    };
  }
}

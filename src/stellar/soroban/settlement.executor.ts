import {
  SettlementExecutor,
  SubmitSettlementParams,
  SettlementExecutionResult,
  SettlementStatusResult,
  SettlementConfirmationResult,
} from '../settlement.executor.js';
import { SorobanTransactionService } from './transaction.service.js';
import { SorobanConfirmationService } from './confirmation.service.js';
import { assertLiveSettlementTestnetSafety } from '../config/index.js';

export class SorobanSettlementExecutor implements SettlementExecutor {
  private transactionService: SorobanTransactionService;
  private confirmationService: SorobanConfirmationService;

  constructor(
    transactionService?: SorobanTransactionService,
    confirmationService?: SorobanConfirmationService
  ) {
    this.transactionService = transactionService || new SorobanTransactionService();
    this.confirmationService = confirmationService || new SorobanConfirmationService();
  }

  public async submitSettlement(params: SubmitSettlementParams): Promise<SettlementExecutionResult> {
    try {
      assertLiveSettlementTestnetSafety();

      const { transactionHash } = await this.transactionService.buildAndSubmitSettlementTransaction(params);

      return {
        submitted: true,
        transactionHash,
      };
    } catch (err: unknown) {
      const sanitizedErrorMessage = err instanceof Error ? err.message : 'Soroban settlement submission error';
      return {
        submitted: false,
        error: sanitizedErrorMessage,
      };
    }
  }

  public async getSettlementStatus(txHash: string): Promise<SettlementStatusResult> {
    return this.confirmationService.getTransactionStatus(txHash);
  }

  public async confirmSettlement(
    txHash: string,
    options?: { maxAttempts?: number; intervalMs?: number }
  ): Promise<SettlementConfirmationResult> {
    return this.confirmationService.confirmTransaction(txHash, options);
  }
}

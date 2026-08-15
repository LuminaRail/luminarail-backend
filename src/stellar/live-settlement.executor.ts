import {
  SettlementExecutor,
  SubmitSettlementParams,
  SettlementExecutionResult,
  SettlementStatusResult,
  SettlementConfirmationResult,
} from './settlement.executor.js';
import { SorobanTransactionService } from './soroban/transaction.service.js';
import { SorobanConfirmationService } from './soroban/confirmation.service.js';

export class LiveSettlementExecutor implements SettlementExecutor {
  private readonly transactionService: SorobanTransactionService;
  private readonly confirmationService: SorobanConfirmationService;

  constructor(
    transactionService?: SorobanTransactionService,
    confirmationService?: SorobanConfirmationService
  ) {
    this.transactionService =
      transactionService || new SorobanTransactionService();

    this.confirmationService =
      confirmationService || new SorobanConfirmationService();
  }

  public async submitSettlement(
    params: SubmitSettlementParams
  ): Promise<SettlementExecutionResult> {
    try {
      const result =
        await this.transactionService.buildAndSubmitSettlementTransaction(
          params
        );

      return {
        submitted: true,
        transactionHash: result.transactionHash,
      };
    } catch (err: unknown) {
      return {
        submitted: false,
        error: err instanceof Error ? err.message : 'Settlement submission failed.',
      };
    }
  }

  public async getSettlementStatus(
    txHash: string
  ): Promise<SettlementStatusResult> {
    return this.confirmationService.getTransactionStatus(txHash);
  }

  public async confirmSettlement(
    txHash: string
  ): Promise<SettlementConfirmationResult> {
    return this.confirmationService.confirmTransaction(txHash);
  }
}

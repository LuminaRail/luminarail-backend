import { SignTransactionRequest } from '../signer/types.js';

export interface ISettlementPolicyEngine {
  validateAndApprove(request: SignTransactionRequest): Promise<void>;
}

import { SignerIdentity, SignTransactionRequest, SignTransactionResponse, SignerHealthResult } from './types.js';

export interface ITransactionSigner {
  getIdentity(): Promise<SignerIdentity>;
  signTransaction(request: SignTransactionRequest): Promise<SignTransactionResponse>;
  healthCheck(): Promise<SignerHealthResult>;
  verifyReadiness(expectedPublicKey?: string, expectedNetworkPassphrase?: string): Promise<void>;
}

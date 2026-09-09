import { SignerIdentity, SignTransactionRequest, SignTransactionResponse } from './types.js';

export interface ITransactionSigner {
  getIdentity(): Promise<SignerIdentity>;
  signTransaction(request: SignTransactionRequest): Promise<SignTransactionResponse>;
}

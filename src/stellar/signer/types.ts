export interface SignerIdentity {
  publicKey: string;
  keyId: string;
  providerType: 'TESTNET_LOCAL' | 'AWS_KMS' | 'GCP_KMS' | 'FIREBLOCKS';
  networkPassphrase: string;
}

export interface AuthorizationPolicyContext {
  settlementId: string;
  orderId: string;
  liquidityReservationId?: string;
  expectedSource: string;
  expectedDestination: string;
  expectedAmountStroops: bigint;
  expectedAssetContract: string;
  expectedVaultContract: string;
}

export interface SignTransactionRequest {
  unsignedTransactionXdr: string;
  context: AuthorizationPolicyContext;
}

export interface SignTransactionResponse {
  signedTransactionXdr: string;
  transactionHash: string;
  signerPublicKey: string;
  signedAt: Date;
  auditMetadata: {
    signerId: string;
    algorithm: string;
    keyArn?: string;
  };
}

import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { config } from '../../config/index.js';
import { stellarConfig, assertLiveSettlementTestnetSafety } from '../config/index.js';
import { SorobanSignerConfigError } from '../../errors/index.js';
import { ITransactionSigner } from './signer.interface.js';
import { SignerIdentity, SignTransactionRequest, SignTransactionResponse } from './types.js';
import { ISettlementPolicyEngine } from '../policy/policy.interface.js';
import { SettlementPolicyEngine } from '../policy/settlement-policy.engine.js';
import { AuditService } from '../../modules/audit/audit.service.js';

export class TestnetLocalSigner implements ITransactionSigner {
  private readonly secretKey: string;
  private readonly keypair: Keypair;
  private readonly policyEngine: ISettlementPolicyEngine;

  constructor(secretKey?: string, policyEngine?: ISettlementPolicyEngine) {
    if (config.env === 'production') {
      throw new SorobanSignerConfigError(
        'FATAL SECURITY VIOLATION: Local testnet signer is strictly forbidden in production mode.'
      );
    }

    assertLiveSettlementTestnetSafety();

    const rawSecret = secretKey || config.stellar.signerSecretKey;
    if (!rawSecret) {
      throw new SorobanSignerConfigError('STELLAR_SETTLEMENT_SIGNER_SECRET_KEY is not configured.');
    }

    this.secretKey = rawSecret;
    try {
      this.keypair = Keypair.fromSecret(this.secretKey);
    } catch (err) {
      throw new SorobanSignerConfigError('Invalid Stellar settlement signer secret key format.');
    }

    if (config.stellar.signerPublicKey && config.stellar.signerPublicKey !== this.keypair.publicKey()) {
      throw new SorobanSignerConfigError(
        'Configured STELLAR_SETTLEMENT_SIGNER_PUBLIC_KEY does not match secret key.'
      );
    }

    this.policyEngine = policyEngine || new SettlementPolicyEngine();
  }

  public async getIdentity(): Promise<SignerIdentity> {
    return {
      publicKey: this.keypair.publicKey(),
      keyId: 'TESTNET_LOCAL_KEY',
      providerType: 'TESTNET_LOCAL',
      networkPassphrase: stellarConfig.passphrase,
    };
  }

  public async signTransaction(request: SignTransactionRequest): Promise<SignTransactionResponse> {
    // 1. Authoritative Policy Engine Assertion Check
    await this.policyEngine.validateAndApprove(request);

    // 2. Parse Unsigned XDR
    const tx = TransactionBuilder.fromXDR(request.unsignedTransactionXdr, stellarConfig.passphrase);

    // 3. Cryptographic In-Memory Signing
    tx.sign(this.keypair);

    const signedTransactionXdr = tx.toXDR();
    const transactionHash = tx.hash().toString('hex');
    const signedAt = new Date();

    // 4. Audit Log Registration
    await AuditService.log({
      actor: 'system-signer',
      action: 'TRANSACTION_SIGNED',
      resource: 'Settlement',
      resourceId: request.context.settlementId,
      details: {
        settlementId: request.context.settlementId,
        orderId: request.context.orderId,
        signerPublicKey: this.keypair.publicKey(),
        transactionHash,
        providerType: 'TESTNET_LOCAL',
      },
    });

    return {
      signedTransactionXdr,
      transactionHash,
      signerPublicKey: this.keypair.publicKey(),
      signedAt,
      auditMetadata: {
        signerId: 'TESTNET_LOCAL_KEY',
        algorithm: 'Ed25519',
      },
    };
  }
}

/**
 * Resolver function to instantiate the correct signer based on environment configuration.
 */
export function resolveTransactionSigner(signer?: ITransactionSigner): ITransactionSigner {
  if (signer) return signer;

  const provider = config.stellar.signerProvider || 'testnet_local';

  if (config.env === 'production' && provider === 'testnet_local') {
    throw new SorobanSignerConfigError(
      'FATAL: Local testnet signer cannot be used in production environment.'
    );
  }

  switch (provider) {
    case 'aws_kms':
    case 'gcp_kms':
    case 'fireblocks':
      throw new SorobanSignerConfigError(
        `Provider '${provider}' is not yet implemented. Production KMS/Custody SDK integration is deferred.`
      );
    case 'testnet_local':
    default:
      return new TestnetLocalSigner();
  }
}

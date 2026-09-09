import { KMSClient, GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { Keypair, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { config } from '../../config/index.js';
import { stellarConfig } from '../config/index.js';
import { SorobanSignerConfigError, SorobanSubmissionError } from '../../errors/index.js';
import { ITransactionSigner } from './signer.interface.js';
import { SignerIdentity, SignTransactionRequest, SignTransactionResponse, SignerHealthResult } from './types.js';
import { ISettlementPolicyEngine } from '../policy/policy.interface.js';
import { SettlementPolicyEngine } from '../policy/settlement-policy.engine.js';
import { AuditService } from '../../modules/audit/audit.service.js';

export class KmsTransactionSigner implements ITransactionSigner {
  private readonly kmsClient: KMSClient;
  private readonly keyArn: string;
  private readonly policyEngine: ISettlementPolicyEngine;
  private cachedPublicKey: string | null = null;

  constructor(
    kmsClient?: KMSClient,
    keyArn?: string,
    policyEngine?: ISettlementPolicyEngine
  ) {
    this.keyArn = keyArn || config.stellar.kmsKeyArn || '';
    if (!this.keyArn || this.keyArn.trim() === '') {
      throw new SorobanSignerConfigError(
        'FATAL: STELLAR_KMS_KEY_ARN or AWS_KMS_SIGNING_KEY_ID is not configured for AWS KMS signer provider.'
      );
    }

    const region = config.stellar.awsRegion || 'us-east-1';
    this.kmsClient = kmsClient || new KMSClient({ region });
    this.policyEngine = policyEngine || new SettlementPolicyEngine();
  }

  public async getPublicKey(): Promise<string> {
    if (this.cachedPublicKey) {
      return this.cachedPublicKey;
    }

    let response;
    try {
      response = await this.kmsClient.send(new GetPublicKeyCommand({ KeyId: this.keyArn }));
    } catch (err: unknown) {
      throw new SorobanSignerConfigError(
        `KMS GetPublicKey failed for KeyId '${this.keyArn}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!response.PublicKey) {
      throw new SorobanSignerConfigError(`KMS GetPublicKey returned an empty PublicKey payload for KeyId '${this.keyArn}'.`);
    }

    const keySpec = response.KeySpec?.toUpperCase();
    if (keySpec && keySpec !== 'ECC_ED25519' && keySpec !== 'ED25519') {
      throw new SorobanSignerConfigError(
        `KMS key specification mismatch: Expected 'ECC_ED25519', got '${response.KeySpec}' for KeyId '${this.keyArn}'.`
      );
    }

    if (response.KeyUsage && response.KeyUsage !== 'SIGN_VERIFY') {
      throw new SorobanSignerConfigError(
        `KMS key usage mismatch: Expected 'SIGN_VERIFY', got '${response.KeyUsage}' for KeyId '${this.keyArn}'.`
      );
    }

    if ((response as any).Enabled === false) {
      throw new SorobanSignerConfigError(`KMS key is disabled for KeyId '${this.keyArn}'.`);
    }

    const rawPubKeyBuffer = Buffer.from(response.PublicKey);
    let rawEd25519Key: Buffer;

    if (rawPubKeyBuffer.length === 44) {
      // Standard DER SubjectPublicKeyInfo for Ed25519 (12-byte header + 32-byte raw key)
      rawEd25519Key = rawPubKeyBuffer.subarray(12);
    } else if (rawPubKeyBuffer.length === 32) {
      rawEd25519Key = rawPubKeyBuffer;
    } else {
      throw new SorobanSignerConfigError(
        `Invalid KMS Ed25519 public key byte length (${rawPubKeyBuffer.length} bytes, expected 32 or 44 bytes).`
      );
    }

    if (rawEd25519Key.length !== 32) {
      throw new SorobanSignerConfigError('Failed to extract 32-byte raw Ed25519 public key from KMS payload.');
    }

    const stellarPublicKey = StrKey.encodeEd25519PublicKey(rawEd25519Key);
    if (!StrKey.isValidEd25519PublicKey(stellarPublicKey)) {
      throw new SorobanSignerConfigError(`Extracted KMS public key is not a valid Stellar G-address: ${stellarPublicKey}`);
    }

    this.cachedPublicKey = stellarPublicKey;
    return this.cachedPublicKey;
  }

  public async getIdentity(): Promise<SignerIdentity> {
    const publicKey = await this.getPublicKey();
    return {
      publicKey,
      keyId: this.keyArn,
      providerType: 'AWS_KMS',
      networkPassphrase: stellarConfig.passphrase,
      expectedSourceAccount: config.stellar.signerPublicKey || publicKey,
    };
  }

  public async verifyReadiness(expectedPublicKey?: string, expectedNetworkPassphrase?: string): Promise<void> {
    const identity = await this.getIdentity();

    if (expectedNetworkPassphrase && identity.networkPassphrase !== expectedNetworkPassphrase) {
      throw new SorobanSignerConfigError(
        `FATAL SIGNER MISMATCH: Signer network passphrase (${identity.networkPassphrase}) does not match expected (${expectedNetworkPassphrase}).`
      );
    }

    if (identity.networkPassphrase !== stellarConfig.passphrase) {
      throw new SorobanSignerConfigError(
        `FATAL SIGNER MISMATCH: Signer network passphrase (${identity.networkPassphrase}) does not match configured system network (${stellarConfig.passphrase}).`
      );
    }

    const targetExpectedPublic = expectedPublicKey || config.stellar.signerPublicKey;
    if (targetExpectedPublic && identity.publicKey !== targetExpectedPublic) {
      throw new SorobanSignerConfigError(
        `FATAL SIGNER MISMATCH: KMS public key (${identity.publicKey}) does not match configured STELLAR_SETTLEMENT_SIGNER_PUBLIC_KEY (${targetExpectedPublic}).`
      );
    }
  }

  public async healthCheck(): Promise<SignerHealthResult> {
    const startMs = Date.now();
    try {
      const publicKey = await this.getPublicKey();
      return {
        healthy: true,
        providerType: 'AWS_KMS',
        publicKey,
        keyArnOrId: this.keyArn,
        latencyMs: Date.now() - startMs,
      };
    } catch (err: unknown) {
      return {
        healthy: false,
        providerType: 'AWS_KMS',
        publicKey: '',
        keyArnOrId: this.keyArn,
        latencyMs: Date.now() - startMs,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public async signTransaction(request: SignTransactionRequest): Promise<SignTransactionResponse> {
    // 1. Mandatory Settlement Policy Authorization Boundary
    await this.policyEngine.validateAndApprove(request);

    // 2. Parse Unsigned Transaction XDR
    let tx;
    try {
      tx = TransactionBuilder.fromXDR(request.unsignedTransactionXdr, stellarConfig.passphrase);
    } catch (err) {
      throw new SorobanSubmissionError('Failed to parse unsigned transaction XDR envelope.', err);
    }

    // 3. Extract 32-Byte SHA-256 Transaction Hash
    const txHash = tx.hash();
    if (!Buffer.isBuffer(txHash) && !((txHash as unknown) instanceof Uint8Array)) {
      throw new SorobanSignerConfigError('Transaction hash must be a Buffer or Uint8Array.');
    }
    if (txHash.length !== 32) {
      throw new SorobanSignerConfigError(`Invalid transaction hash length (${txHash.length} bytes, expected exactly 32 bytes).`);
    }

    // 4. Retrieve Verified KMS Signer Public Key
    const signerPublicKey = await this.getPublicKey();

    // 5. Invoke AWS KMS Hardware Signing (MessageType: RAW, SigningAlgorithm: ED25519)
    let kmsResponse;
    try {
      kmsResponse = await this.kmsClient.send(
        new SignCommand({
          KeyId: this.keyArn,
          Message: txHash,
          MessageType: 'RAW',
          SigningAlgorithm: 'ED25519' as any,
        })
      );
    } catch (err: unknown) {
      throw new SorobanSubmissionError(
        `AWS KMS SignCommand failed for KeyId '${this.keyArn}': ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    if (!kmsResponse.Signature) {
      throw new SorobanSignerConfigError('AWS KMS SignCommand returned an empty signature payload.');
    }

    const signatureBuffer = Buffer.from(kmsResponse.Signature);

    // 6. Strict Signature Length Assertions (Must be exactly 64 bytes for Ed25519)
    if (signatureBuffer.length !== 64) {
      throw new SorobanSignerConfigError(
        `KMS returned invalid signature byte length (${signatureBuffer.length} bytes, expected exactly 64 bytes for Ed25519).`
      );
    }

    // 7. Cryptographic Signature Verification Against Signer Public Key
    const keypair = Keypair.fromPublicKey(signerPublicKey);
    const isCryptoValid = keypair.verify(txHash, signatureBuffer);
    if (!isCryptoValid) {
      throw new SorobanSignerConfigError('FATAL: KMS signature failed local cryptographic verification against public key.');
    }

    // 8. Assemble Stellar DecoratedSignature Envelope
    const hint = keypair.signatureHint();
    const decoratedSig = new xdr.DecoratedSignature({
      hint,
      signature: signatureBuffer,
    });

    tx.signatures.push(decoratedSig);

    const signedTransactionXdr = tx.toXDR();
    const transactionHashHex = txHash.toString('hex');
    const signedAt = new Date();

    // 9. Redacted Audit Trail Registration
    await AuditService.log({
      actor: 'system-signer-kms',
      action: 'TRANSACTION_SIGNED',
      resource: 'Settlement',
      resourceId: request.context.settlementId,
      details: {
        settlementId: request.context.settlementId,
        orderId: request.context.orderId,
        signerPublicKey,
        transactionHash: transactionHashHex,
        providerType: 'AWS_KMS',
        keyArn: this.keyArn,
      },
    });

    return {
      signedTransactionXdr,
      transactionHash: transactionHashHex,
      signerPublicKey,
      signedAt,
      auditMetadata: {
        signerId: this.keyArn,
        algorithm: 'ED25519',
        keyArn: this.keyArn,
      },
    };
  }
}

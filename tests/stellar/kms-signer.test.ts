import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KMSClient, GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { Keypair, TransactionBuilder, Account, Operation, Asset, StrKey, Networks } from '@stellar/stellar-sdk';
import { KmsTransactionSigner } from '../../src/stellar/signer/kms-transaction.signer.js';
import { SignTransactionRequest, AuthorizationPolicyContext } from '../../src/stellar/signer/types.js';
import { ISettlementPolicyEngine } from '../../src/stellar/policy/policy.interface.js';
import { SorobanSignerConfigError, SorobanSubmissionError } from '../../src/errors/index.js';
import { config } from '../../src/config/index.js';
import { stellarConfig } from '../../src/stellar/config/index.js';
import * as ed from '@noble/ed25519';

describe('KmsTransactionSigner (MAINNET-06B)', () => {
  let mockKmsClient: KMSClient;
  let testKeypair: Keypair;
  let testRawPubKey: Buffer;
  let testDerPubKey: Buffer;
  let mockPolicyEngine: ISettlementPolicyEngine;
  const mockKeyArn = 'arn:aws:kms:us-east-1:123456789012:key/test-kms-ed25519-key-id';

  beforeEach(() => {
    testKeypair = Keypair.random();
    testRawPubKey = Buffer.from(testKeypair.rawPublicKey());
    // DER SPKI 12-byte header + 32-byte raw Ed25519 public key
    const derHeader = Buffer.from('302a300506032b6570032100', 'hex');
    testDerPubKey = Buffer.concat([derHeader, testRawPubKey]);

    mockKmsClient = {
      send: vi.fn(),
    } as unknown as KMSClient;

    mockPolicyEngine = {
      validateAndApprove: vi.fn().mockResolvedValue(undefined),
    };
  });

  function createUnsignedTxXdr(): { unsignedXdr: string; txHash: Buffer; sourceAddress: string } {
    const sourceAccount = testKeypair.publicKey();
    const account = new Account(sourceAccount, '1000');
    const tx = new TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: stellarConfig.passphrase,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: '10',
        })
      )
      .setTimeout(30)
      .build();

    return {
      unsignedXdr: tx.toXDR(),
      txHash: tx.hash(),
      sourceAddress: sourceAccount,
    };
  }

  function createRequestContext(unsignedXdr: string, sourceAddress: string): SignTransactionRequest {
    return {
      unsignedTransactionXdr: unsignedXdr,
      context: {
        settlementId: 'SETTLE_TEST_123',
        orderId: 'ORDER_TEST_456',
        expectedSource: sourceAddress,
        expectedDestination: Keypair.random().publicKey(),
        expectedAmountStroops: 100000000n,
        expectedAssetContract: 'CBIELTK6YBZJU5UP2WWHLRHJB4EBHVGQZ22VJ2J53AEX4H5MHRG5U6PE',
        expectedVaultContract: 'CBIELTK6YBZJU5UP2WWHLRHJB4EBHVGQZ22VJ2J53AEX4H5MHRG5U6PE',
      },
    };
  }

  // --- A. Successful KMS signing ---
  it('A. signs transaction successfully using mock KMS client', async () => {
    (mockKmsClient.send as any).mockImplementation(async (command: any) => {
      if (command instanceof GetPublicKeyCommand) {
        return {
          PublicKey: testDerPubKey,
          KeySpec: 'ECC_ED25519',
          KeyUsage: 'SIGN_VERIFY',
          Enabled: true,
        };
      }
      if (command instanceof SignCommand) {
        const msg = command.input.Message;
        const sig = await ed.sign(msg, testKeypair.rawSecretKey());
        return { Signature: Buffer.from(sig) };
      }
    });

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);
    const { unsignedXdr, sourceAddress } = createUnsignedTxXdr();
    const request = createRequestContext(unsignedXdr, sourceAddress);

    const response = await signer.signTransaction(request);
    expect(response.signedTransactionXdr).toBeDefined();
    expect(response.signerPublicKey).toBe(testKeypair.publicKey());
    expect(response.auditMetadata.signerId).toBe(mockKeyArn);
    expect(response.auditMetadata.algorithm).toBe('ED25519');
  });

  // --- B, C, D. Exact tx.hash(), RAW MessageType, ED25519 SigningAlgorithm ---
  it('B, C, D. asserts exact tx.hash() length 32, MessageType RAW, and ED25519 algorithm are passed to KMS', async () => {
    let capturedSignInput: any = null;

    (mockKmsClient.send as any).mockImplementation(async (command: any) => {
      if (command instanceof GetPublicKeyCommand) {
        return {
          PublicKey: testDerPubKey,
          KeySpec: 'ECC_ED25519',
          KeyUsage: 'SIGN_VERIFY',
          Enabled: true,
        };
      }
      if (command instanceof SignCommand) {
        capturedSignInput = command.input;
        const sig = await ed.sign(command.input.Message, testKeypair.rawSecretKey());
        return { Signature: Buffer.from(sig) };
      }
    });

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);
    const { unsignedXdr, txHash, sourceAddress } = createUnsignedTxXdr();
    const request = createRequestContext(unsignedXdr, sourceAddress);

    await signer.signTransaction(request);

    expect(capturedSignInput).not.toBeNull();
    expect(capturedSignInput.KeyId).toBe(mockKeyArn);
    expect(capturedSignInput.MessageType).toBe('RAW');
    expect(capturedSignInput.SigningAlgorithm).toBe('ED25519');
    expect(Buffer.isBuffer(capturedSignInput.Message) || capturedSignInput.Message instanceof Uint8Array).toBe(true);
    expect(capturedSignInput.Message.length).toBe(32);
    expect(Buffer.from(capturedSignInput.Message).equals(txHash)).toBe(true);
  });

  // --- E & F. 64-byte signature validation & DecoratedSignature creation ---
  it('E & F. validates exactly 64-byte signature and constructs valid DecoratedSignature', async () => {
    (mockKmsClient.send as any).mockImplementation(async (command: any) => {
      if (command instanceof GetPublicKeyCommand) {
        return { PublicKey: testDerPubKey, KeySpec: 'ECC_ED25519', KeyUsage: 'SIGN_VERIFY', Enabled: true };
      }
      if (command instanceof SignCommand) {
        const sig = await ed.sign(command.input.Message, testKeypair.rawSecretKey());
        return { Signature: Buffer.from(sig) };
      }
    });

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);
    const { unsignedXdr, sourceAddress } = createUnsignedTxXdr();
    const request = createRequestContext(unsignedXdr, sourceAddress);

    const response = await signer.signTransaction(request);
    const parsedTx = TransactionBuilder.fromXDR(response.signedTransactionXdr, stellarConfig.passphrase);

    expect(parsedTx.signatures.length).toBe(1);
    expect(parsedTx.signatures[0].signature().length).toBe(64);
  });

  // --- G. Public-key verification ---
  it('G. extracts and verifies public key address from KMS DER SPKI payload', async () => {
    (mockKmsClient.send as any).mockResolvedValue({
      PublicKey: testDerPubKey,
      KeySpec: 'ECC_ED25519',
      KeyUsage: 'SIGN_VERIFY',
      Enabled: true,
    });

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);
    const pubKey = await signer.getPublicKey();
    expect(pubKey).toBe(testKeypair.publicKey());
    expect(StrKey.isValidEd25519PublicKey(pubKey)).toBe(true);
  });

  // --- H. Wrong public-key rejection ---
  it('H. fails readiness verification if KMS public key does not match expected signer public key', async () => {
    (mockKmsClient.send as any).mockResolvedValue({
      PublicKey: testDerPubKey,
      KeySpec: 'ECC_ED25519',
      KeyUsage: 'SIGN_VERIFY',
      Enabled: true,
    });

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);
    const wrongPubKey = Keypair.random().publicKey();

    await expect(signer.verifyReadiness(wrongPubKey)).rejects.toThrow(SorobanSignerConfigError);
  });

  // --- I. Wrong network rejection ---
  it('I. fails readiness verification if network passphrase mismatches', async () => {
    (mockKmsClient.send as any).mockResolvedValue({
      PublicKey: testDerPubKey,
      KeySpec: 'ECC_ED25519',
      KeyUsage: 'SIGN_VERIFY',
      Enabled: true,
    });

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);

    await expect(signer.verifyReadiness(undefined, 'WRONG_NETWORK_PASSPHRASE')).rejects.toThrow(
      SorobanSignerConfigError
    );
  });

  // --- J. Wrong key algorithm rejection ---
  it('J. rejects KMS keys with incompatible key specs (e.g. RSA / ECDSA)', async () => {
    (mockKmsClient.send as any).mockResolvedValue({
      PublicKey: testDerPubKey,
      KeySpec: 'RSA_4096',
      KeyUsage: 'SIGN_VERIFY',
      Enabled: true,
    });

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);

    await expect(signer.getPublicKey()).rejects.toThrow(/KMS key specification mismatch/);
  });

  // --- K. Disabled KMS key rejection ---
  it('K. rejects KMS key if Enabled is false', async () => {
    (mockKmsClient.send as any).mockResolvedValue({
      PublicKey: testDerPubKey,
      KeySpec: 'ECC_ED25519',
      KeyUsage: 'SIGN_VERIFY',
      Enabled: false,
    });

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);

    await expect(signer.getPublicKey()).rejects.toThrow(/KMS key is disabled/);
  });

  // --- L. KMS AccessDenied handling ---
  it('L. handles KMS AccessDenied exception safely', async () => {
    const accessDeniedErr = new Error('User is not authorized to perform: kms:Sign');
    accessDeniedErr.name = 'AccessDeniedException';

    (mockKmsClient.send as any).mockImplementation(async (command: any) => {
      if (command instanceof GetPublicKeyCommand) {
        return { PublicKey: testDerPubKey, KeySpec: 'ECC_ED25519', KeyUsage: 'SIGN_VERIFY', Enabled: true };
      }
      throw accessDeniedErr;
    });

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);
    const { unsignedXdr, sourceAddress } = createUnsignedTxXdr();
    const request = createRequestContext(unsignedXdr, sourceAddress);

    await expect(signer.signTransaction(request)).rejects.toThrow(SorobanSubmissionError);
  });

  // --- M. KMS timeout handling ---
  it('M. handles KMS timeout gracefully without swallowing errors', async () => {
    (mockKmsClient.send as any).mockImplementation(async (command: any) => {
      if (command instanceof GetPublicKeyCommand) {
        return { PublicKey: testDerPubKey, KeySpec: 'ECC_ED25519', KeyUsage: 'SIGN_VERIFY', Enabled: true };
      }
      throw new Error('KMS Request timed out after 5000ms');
    });

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);
    const { unsignedXdr, sourceAddress } = createUnsignedTxXdr();
    const request = createRequestContext(unsignedXdr, sourceAddress);

    await expect(signer.signTransaction(request)).rejects.toThrow(/timed out/);
  });

  // --- N. KMS throttling handling ---
  it('N. handles KMS ThrottlingException cleanly', async () => {
    const throttleErr = new Error('Rate exceeded');
    throttleErr.name = 'KMSInternalException';

    (mockKmsClient.send as any).mockImplementation(async (command: any) => {
      if (command instanceof GetPublicKeyCommand) {
        return { PublicKey: testDerPubKey, KeySpec: 'ECC_ED25519', KeyUsage: 'SIGN_VERIFY', Enabled: true };
      }
      throw throttleErr;
    });

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);
    const { unsignedXdr, sourceAddress } = createUnsignedTxXdr();
    const request = createRequestContext(unsignedXdr, sourceAddress);

    await expect(signer.signTransaction(request)).rejects.toThrow(SorobanSubmissionError);
  });

  // --- O. Malformed signature handling ---
  it('O. fails closed if KMS returns invalid signature length (!= 64 bytes)', async () => {
    (mockKmsClient.send as any).mockImplementation(async (command: any) => {
      if (command instanceof GetPublicKeyCommand) {
        return { PublicKey: testDerPubKey, KeySpec: 'ECC_ED25519', KeyUsage: 'SIGN_VERIFY', Enabled: true };
      }
      if (command instanceof SignCommand) {
        return { Signature: Buffer.alloc(32) }; // Invalid 32 bytes
      }
    });

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);
    const { unsignedXdr, sourceAddress } = createUnsignedTxXdr();
    const request = createRequestContext(unsignedXdr, sourceAddress);

    await expect(signer.signTransaction(request)).rejects.toThrow(/invalid signature byte length/);
  });

  // --- P. Signer readiness failure ---
  it('P. healthCheck returns unhealthy status when KMS call fails', async () => {
    (mockKmsClient.send as any).mockRejectedValue(new Error('KMS unavailable'));

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);
    const health = await signer.healthCheck();

    expect(health.healthy).toBe(false);
    expect(health.error).toContain('KMS unavailable');
    expect(health.providerType).toBe('AWS_KMS');
  });

  // --- Q. Policy rejection before KMS invocation (CRITICAL ASSERTION) ---
  it('Q. CRITICAL: Asserts KMS SignCommand is NEVER called if SettlementPolicyEngine rejects', async () => {
    const policyRejectEngine: ISettlementPolicyEngine = {
      validateAndApprove: vi.fn().mockRejectedValue(new Error('Policy Violation: Emergency Global Pause')),
    };

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, policyRejectEngine);
    const { unsignedXdr, sourceAddress } = createUnsignedTxXdr();
    const request = createRequestContext(unsignedXdr, sourceAddress);

    await expect(signer.signTransaction(request)).rejects.toThrow(/Emergency Global Pause/);

    // Verify SignCommand was NEVER sent to KMS
    const signCalls = (mockKmsClient.send as any).mock.calls.filter((call: any[]) => call[0] instanceof SignCommand);
    expect(signCalls.length).toBe(0);
  });

  // --- R & SECURITY TEST. Arbitrary transaction/XDR rejection ---
  it('R & SECURITY TEST. Rejects malformed or unauthorized raw XDR payloads without executing KMS sign', async () => {
    const malformedXdr = 'NOT_A_VALID_BASE64_XDR';
    const request: SignTransactionRequest = {
      unsignedTransactionXdr: malformedXdr,
      context: {
        settlementId: 'SETTLE_BAD',
        orderId: 'ORDER_BAD',
        expectedSource: testKeypair.publicKey(),
        expectedDestination: testKeypair.publicKey(),
        expectedAmountStroops: 100n,
        expectedAssetContract: 'CBIELTK6YBZJU5UP2WWHLRHJB4EBHVGQZ22VJ2J53AEX4H5MHRG5U6PE',
        expectedVaultContract: 'CBIELTK6YBZJU5UP2WWHLRHJB4EBHVGQZ22VJ2J53AEX4H5MHRG5U6PE',
      },
    };

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);
    await expect(signer.signTransaction(request)).rejects.toThrow();

    const signCalls = (mockKmsClient.send as any).mock.calls.filter((call: any[]) => call[0] instanceof SignCommand);
    expect(signCalls.length).toBe(0);
  });

  // --- S. Transaction mutation detection ---
  it('S. detects local signature cryptographic mismatch if signature is tampered', async () => {
    (mockKmsClient.send as any).mockImplementation(async (command: any) => {
      if (command instanceof GetPublicKeyCommand) {
        return { PublicKey: testDerPubKey, KeySpec: 'ECC_ED25519', KeyUsage: 'SIGN_VERIFY', Enabled: true };
      }
      if (command instanceof SignCommand) {
        // Return 64 bytes of random noise (invalid signature)
        return { Signature: Buffer.alloc(64, 0xff) };
      }
    });

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);
    const { unsignedXdr, sourceAddress } = createUnsignedTxXdr();
    const request = createRequestContext(unsignedXdr, sourceAddress);

    await expect(signer.signTransaction(request)).rejects.toThrow(/failed local cryptographic verification/);
  });

  // --- W. No private key exists in signer configuration ---
  it('W. verifies KmsTransactionSigner holds zero private key material in memory', () => {
    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);
    const signerObj = signer as any;

    expect(signerObj.secretKey).toBeUndefined();
    expect(signerObj.privateKey).toBeUndefined();
    expect(signerObj.seed).toBeUndefined();
    expect(signerObj.keypair).toBeUndefined();
  });

  // --- X. No secret/private-key leakage in logs/errors ---
  it('X. asserts error messages contain zero private key seeds or authorization tokens', async () => {
    (mockKmsClient.send as any).mockImplementation(async (command: any) => {
      if (command instanceof GetPublicKeyCommand) {
        return { PublicKey: testDerPubKey, KeySpec: 'ECC_ED25519', KeyUsage: 'SIGN_VERIFY', Enabled: true };
      }
      throw new Error('KMS Internal Execution Error on key arn:aws:kms:us-east-1:123456789012:key/test-kms-ed25519-key-id');
    });

    const signer = new KmsTransactionSigner(mockKmsClient, mockKeyArn, mockPolicyEngine);
    const { unsignedXdr, sourceAddress } = createUnsignedTxXdr();
    const request = createRequestContext(unsignedXdr, sourceAddress);

    try {
      await signer.signTransaction(request);
      expect.fail('Expected exception');
    } catch (err: any) {
      const errMsg = err.message || '';
      expect(errMsg).not.toMatch(/S[A-Z0-9]{55}/); // Stellar seed pattern
      expect(errMsg).not.toMatch(/sk_live_[A-Za-z0-9]+/); // Secret key pattern
    }
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { TestnetLocalSigner, resolveTransactionSigner } from '../../src/stellar/signer/testnet-local.signer.js';
import { config } from '../../src/config/index.js';

describe('MAINNET-04: Signer Abstraction & TestnetLocalSigner Test Suite', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalSignerSecret = config.stellar.signerSecretKey;

  beforeEach(() => {
    config.env = 'test';
    const validKeypair = Keypair.random();
    (config.stellar as any).signerSecretKey = validKeypair.secret();
    (config.stellar as any).signerPublicKey = validKeypair.publicKey();
    (config.stellar as any).signerProvider = 'testnet_local';
  });

  afterEach(() => {
    config.env = originalEnv;
    (config.stellar as any).signerSecretKey = originalSignerSecret;
  });

  it('1. TestnetLocalSigner provides identity exposing publicKey but no secret', async () => {
    const signer = new TestnetLocalSigner();
    const identity = await signer.getIdentity();

    expect(identity.providerType).toBe('TESTNET_LOCAL');
    expect(identity.publicKey).toBe(config.stellar.signerPublicKey);
    expect((identity as any).secretKey).toBeUndefined();
    expect((identity as any).secret).toBeUndefined();
  });

  it('2. Fails closed when NODE_ENV is production and local signer is instantiated', () => {
    config.env = 'production';
    expect(() => new TestnetLocalSigner()).toThrow(
      'Local testnet signer is strictly forbidden in production mode'
    );
  });

  it('3. resolveTransactionSigner throws fatal error in production when local signer configured', () => {
    config.env = 'production';
    (config.stellar as any).signerProvider = 'testnet_local';
    expect(() => resolveTransactionSigner()).toThrow('cannot be used in production environment');
  });

  it('4. resolveTransactionSigner throws unimplemented error for production KMS providers', () => {
    (config.stellar as any).signerProvider = 'aws_kms';
    expect(() => resolveTransactionSigner()).toThrow("Provider 'aws_kms' is not yet implemented");
  });

  it('5. Secret key is never logged or printed in string representation of identity', async () => {
    const signer = new TestnetLocalSigner();
    const identity = await signer.getIdentity();
    const jsonString = JSON.stringify(identity);

    expect(jsonString).not.toContain(config.stellar.signerSecretKey);
    expect(jsonString).toContain(config.stellar.signerPublicKey);
  });
});

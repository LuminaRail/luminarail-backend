import { describe, it, expect } from 'vitest';
import { Networks, Keypair } from '@stellar/stellar-sdk';
import { getNetworkPassphrase, assertTestnetSafety } from '../../src/stellar/config/index.js';
import { envSchema } from '../../src/config/index.js';

describe('Stellar Network Safety & Configuration', () => {
  it('should map network names to official Stellar network passphrases', () => {
    expect(getNetworkPassphrase('testnet')).toBe(Networks.TESTNET);
    expect(getNetworkPassphrase('public')).toBe(Networks.PUBLIC);
    expect(getNetworkPassphrase('mainnet')).toBe(Networks.PUBLIC);
    expect(getNetworkPassphrase('futurenet')).toBe(Networks.FUTURENET);
  });

  it('should pass testnet safety check when configured for testnet', () => {
    expect(() => assertTestnetSafety()).not.toThrow();
  });

  it('should validate STELLAR_USDC_ISSUER via envSchema', () => {
    const validKey = Keypair.random().publicKey();
    const baseEnv = {
      DATABASE_URL: 'postgresql://localhost:5432/test',
    };

    const validResult = envSchema.safeParse({
      ...baseEnv,
      STELLAR_USDC_ISSUER: validKey,
    });
    expect(validResult.success).toBe(true);

    const missingResult = envSchema.safeParse({
      ...baseEnv,
      STELLAR_USDC_ISSUER: '',
    });
    expect(missingResult.success).toBe(false);

    const invalidResult = envSchema.safeParse({
      ...baseEnv,
      STELLAR_USDC_ISSUER: 'not_a_stellar_address',
    });
    expect(invalidResult.success).toBe(false);
  });
});

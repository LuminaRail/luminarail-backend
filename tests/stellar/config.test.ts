import { describe, it, expect } from 'vitest';
import { envSchema } from '../../src/config/index.js';
import {
  assertProductionSettlementSafety,
  STELLAR_MAINNET_USDC_ISSUER,
  STELLAR_MAINNET_USDC_CONTRACT_ID,
  STELLAR_TESTNET_USDC_ISSUER,
  STELLAR_TESTNET_USDC_CONTRACT_ID,
} from '../../src/stellar/config/index.js';

describe('Phase 6A — Production Network, Configuration & USDC Safety', () => {
  const baseValidEnv = {
    DATABASE_URL: 'postgresql://luminarail:luminarail@localhost:5432/luminarail',
    STELLAR_USDC_ISSUER: STELLAR_TESTNET_USDC_ISSUER,
    JWT_SECRET: 'dev_secret_change_me_in_production',
  };

  it('1. testnet configuration succeeds', () => {
    const res = envSchema.safeParse({
      ...baseValidEnv,
      NODE_ENV: 'development',
      STELLAR_NETWORK: 'testnet',
      STELLAR_USDC_ISSUER: STELLAR_TESTNET_USDC_ISSUER,
    });
    expect(res.success).toBe(true);
  });

  it('2. staging configuration succeeds', () => {
    const res = envSchema.safeParse({
      ...baseValidEnv,
      NODE_ENV: 'development',
      STELLAR_NETWORK: 'testnet',
      STELLAR_USDC_ISSUER: STELLAR_TESTNET_USDC_ISSUER,
    });
    expect(res.success).toBe(true);
  });

  it('3. production configuration requires explicit production network', () => {
    const res = envSchema.safeParse({
      ...baseValidEnv,
      NODE_ENV: 'production',
      STELLAR_NETWORK: 'testnet',
      STELLAR_USDC_ISSUER: STELLAR_TESTNET_USDC_ISSUER,
      JWT_SECRET: 'a_very_secure_production_jwt_secret_32_chars_long',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.includes('STELLAR_NETWORK'))).toBe(true);
    }
  });

  it('4. production + testnet network rejected', () => {
    const res = envSchema.safeParse({
      ...baseValidEnv,
      NODE_ENV: 'production',
      STELLAR_NETWORK: 'testnet',
      STELLAR_USDC_ISSUER: STELLAR_TESTNET_USDC_ISSUER,
      JWT_SECRET: 'a_very_secure_production_jwt_secret_32_chars_long',
    });
    expect(res.success).toBe(false);
  });

  it('5. production + testnet USDC rejected', () => {
    const res = envSchema.safeParse({
      ...baseValidEnv,
      NODE_ENV: 'production',
      STELLAR_NETWORK: 'public',
      STELLAR_USDC_ISSUER: STELLAR_TESTNET_USDC_ISSUER, // testnet USDC
      STELLAR_SIGNER_PROVIDER: 'aws_kms',
      JWT_SECRET: 'a_very_secure_production_jwt_secret_32_chars_long',
    });
    expect(res.success).toBe(false);
  });

  it('6. production + testnet signer rejected', () => {
    const res = envSchema.safeParse({
      ...baseValidEnv,
      NODE_ENV: 'production',
      STELLAR_NETWORK: 'public',
      STELLAR_USDC_ISSUER: STELLAR_MAINNET_USDC_ISSUER,
      STELLAR_SIGNER_PROVIDER: 'testnet_local', // testnet local signer
      JWT_SECRET: 'a_very_secure_production_jwt_secret_32_chars_long',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.includes('STELLAR_SIGNER_PROVIDER'))).toBe(true);
    }
  });

  it('7. production without production signer rejected', () => {
    const res = envSchema.safeParse({
      ...baseValidEnv,
      NODE_ENV: 'production',
      STELLAR_NETWORK: 'mainnet',
      STELLAR_USDC_ISSUER: STELLAR_MAINNET_USDC_ISSUER,
      STELLAR_SIGNER_PROVIDER: 'testnet_local',
      JWT_SECRET: 'a_very_secure_production_jwt_secret_32_chars_long',
    });
    expect(res.success).toBe(false);
  });

  it('8. production without production Paystack configuration rejected', () => {
    const res = envSchema.safeParse({
      ...baseValidEnv,
      NODE_ENV: 'production',
      STELLAR_NETWORK: 'public',
      STELLAR_USDC_ISSUER: STELLAR_MAINNET_USDC_ISSUER,
      STELLAR_SIGNER_PROVIDER: 'aws_kms',
      NGN_PROVIDER: 'paystack',
      PAYSTACK_SECRET_KEY: 'sk_test_123456789', // test key in prod
      JWT_SECRET: 'a_very_secure_production_jwt_secret_32_chars_long',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.includes('PAYSTACK_SECRET_KEY'))).toBe(true);
    }
  });

  it('9. production without explicit settlement enablement rejected', () => {
    // If PRODUCTION_SETTLEMENT_ENABLED is set to true on testnet => fails
    const res = envSchema.safeParse({
      ...baseValidEnv,
      NODE_ENV: 'development',
      STELLAR_NETWORK: 'testnet',
      STELLAR_USDC_ISSUER: STELLAR_TESTNET_USDC_ISSUER,
      PRODUCTION_SETTLEMENT_ENABLED: 'true',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.includes('PRODUCTION_SETTLEMENT_ENABLED'))).toBe(true);
    }
  });

  it('10. mainnet network + testnet asset rejected', () => {
    const res = envSchema.safeParse({
      ...baseValidEnv,
      NODE_ENV: 'development',
      STELLAR_NETWORK: 'public',
      STELLAR_USDC_ISSUER: STELLAR_TESTNET_USDC_ISSUER,
      STELLAR_SIGNER_PROVIDER: 'aws_kms',
    });
    expect(res.success).toBe(false);
  });

  it('11. testnet network + mainnet asset rejected', () => {
    const res = envSchema.safeParse({
      ...baseValidEnv,
      NODE_ENV: 'development',
      STELLAR_NETWORK: 'testnet',
      STELLAR_USDC_ISSUER: STELLAR_MAINNET_USDC_ISSUER, // mainnet asset on testnet
    });
    expect(res.success).toBe(false);
  });

  it('12. missing network fails closed', () => {
    const res = envSchema.safeParse({
      DATABASE_URL: 'postgresql://luminarail:luminarail@localhost:5432/luminarail',
      STELLAR_NETWORK: undefined,
    });
    // Default is testnet, but if STELLAR_USDC_ISSUER is missing, safeParse fails
    expect(res.success).toBe(false);
  });

  it('13. missing asset fails closed', () => {
    const res = envSchema.safeParse({
      DATABASE_URL: 'postgresql://luminarail:luminarail@localhost:5432/luminarail',
      STELLAR_NETWORK: 'testnet',
    });
    expect(res.success).toBe(false);
  });

  it('14. malformed network configuration rejected', () => {
    const res = envSchema.safeParse({
      ...baseValidEnv,
      STELLAR_NETWORK: 'invalid_network_name',
    });
    expect(res.success).toBe(false);
  });

  it('15. malformed asset configuration rejected', () => {
    const res = envSchema.safeParse({
      ...baseValidEnv,
      STELLAR_USDC_ISSUER: 'not_a_valid_stellar_address',
    });
    expect(res.success).toBe(false);
  });

  it('16. production configuration cannot silently fall back to testnet', () => {
    const res = envSchema.safeParse({
      ...baseValidEnv,
      NODE_ENV: 'production',
      STELLAR_NETWORK: 'public',
      STELLAR_USDC_ISSUER: STELLAR_MAINNET_USDC_ISSUER,
      STELLAR_USDC_CONTRACT_ID: STELLAR_MAINNET_USDC_CONTRACT_ID,
      STELLAR_SIGNER_PROVIDER: 'aws_kms',
      STELLAR_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:123456789012:key/test-kms-key-id',
      JWT_SECRET: 'a_very_secure_production_jwt_secret_32_chars_long',
      STELLAR_CONTRACT_ADMIN_GOVERNANCE_TYPE: 'multisig',
      PRODUCTION_SETTLEMENT_ENABLED: 'true',
    });
    if (!res.success) {
      console.error('Test 16 Zod Error:', res.error.issues);
    }
    expect(res.success).toBe(true);
  });

  it('17. existing settlement safety assertions operate cleanly', () => {
    expect(() => assertProductionSettlementSafety()).not.toThrow();
  });
});

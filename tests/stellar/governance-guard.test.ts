import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config, envSchema } from '../../src/config/index.js';
import {
  assertContractGovernanceReadiness,
  assertProductionSettlementSafety,
  STELLAR_MAINNET_USDC_ISSUER,
} from '../../src/stellar/config/index.js';

describe('Smart Contract Governance Guard (MAINNET-07 Part 3)', () => {
  let prevEnv: any;
  let prevNetwork: any;
  let prevGovernanceType: any;
  let prevIssuer: any;
  let prevSignerProvider: any;
  let prevPaystackKey: any;

  beforeEach(() => {
    prevEnv = config.env;
    prevNetwork = config.stellar.network;
    prevGovernanceType = config.stellar.contractAdminGovernanceType;
    prevIssuer = config.stellar.usdcIssuer;
    prevSignerProvider = config.stellar.signerProvider;
    prevPaystackKey = config.paystack.secretKey;
  });

  afterEach(() => {
    (config as any).env = prevEnv;
    (config.stellar as any).network = prevNetwork;
    (config.stellar as any).contractAdminGovernanceType = prevGovernanceType;
    (config.stellar as any).usdcIssuer = prevIssuer;
    (config.stellar as any).signerProvider = prevSignerProvider;
    (config.paystack as any).secretKey = prevPaystackKey;
    vi.restoreAllMocks();
  });

  it('Rejects single_key governance in production environment mode', () => {
    (config as any).env = 'production';
    (config.stellar as any).network = 'public';
    (config.stellar as any).contractAdminGovernanceType = 'single_key';

    expect(() => assertContractGovernanceReadiness()).toThrow('Soroban smart contract admin cannot be single_key in production mainnet mode');
  });

  it('Approves multisig or dao governance type in production mainnet mode', () => {
    (config as any).env = 'production';
    (config.stellar as any).network = 'public';
    (config.stellar as any).contractAdminGovernanceType = 'multisig';

    expect(() => assertContractGovernanceReadiness()).not.toThrow();

    (config.stellar as any).contractAdminGovernanceType = 'dao';
    expect(() => assertContractGovernanceReadiness()).not.toThrow();
  });

  it('assertProductionSettlementSafety includes contract governance readiness assertion', () => {
    (config as any).env = 'production';
    (config as any).productionSettlementEnabled = true;
    (config.stellar as any).network = 'public';
    (config.stellar as any).usdcIssuer = STELLAR_MAINNET_USDC_ISSUER;
    (config.stellar as any).signerProvider = 'aws_kms';
    (config.paystack as any).secretKey = 'sk_live_valid_key';
    (config.stellar as any).contractAdminGovernanceType = 'single_key';

    expect(() => assertProductionSettlementSafety()).toThrow('Soroban smart contract admin cannot be single_key in production mainnet mode');
  });

  it('Zod env schema refinement rejects single_key governance when STELLAR_NETWORK is public', () => {
    const invalidEnv = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://localhost:5432/db',
      STELLAR_NETWORK: 'public',
      STELLAR_USDC_ISSUER: STELLAR_MAINNET_USDC_ISSUER,
      STELLAR_SIGNER_PROVIDER: 'aws_kms',
      STELLAR_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:123456789012:key/test',
      PAYSTACK_SECRET_KEY: 'sk_live_test_key',
      STELLAR_CONTRACT_ADMIN_GOVERNANCE_TYPE: 'single_key', // Invalid in production mainnet!
    };

    const parseResult = envSchema.safeParse(invalidEnv);
    expect(parseResult.success).toBe(false);
    if (!parseResult.success) {
      const issue = parseResult.error.issues.find((i) => i.path.includes('STELLAR_CONTRACT_ADMIN_GOVERNANCE_TYPE'));
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('multisig or dao');
    }
  });

  it('Zod env schema accepts multisig governance in production mainnet mode', () => {
    const validEnv = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://localhost:5432/db',
      STELLAR_NETWORK: 'public',
      STELLAR_USDC_ISSUER: STELLAR_MAINNET_USDC_ISSUER,
      STELLAR_SIGNER_PROVIDER: 'aws_kms',
      STELLAR_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:123456789012:key/test',
      PAYSTACK_SECRET_KEY: 'sk_live_test_key',
      JWT_SECRET: 'a_very_secure_production_jwt_secret_32_chars_long',
      STELLAR_CONTRACT_ADMIN_GOVERNANCE_TYPE: 'multisig',
      STELLAR_CONTRACT_ADMIN_ADDRESS: 'GAA...TEST_MULTISIG_ADDRESS',
    };

    const parseResult = envSchema.safeParse(validEnv);
    expect(parseResult.success).toBe(true);
  });
});

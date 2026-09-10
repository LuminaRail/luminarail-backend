import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { envSchema, config } from '../../src/config/index.js';
import { assertProductionSettlementSafety, assertContractGovernanceReadiness } from '../../src/stellar/config/index.js';
import { resolveTransactionSigner } from '../../src/stellar/signer/index.js';
import { LuminaRailWorkerRunner } from '../../src/worker.js';
import { SorobanSignerConfigError, StellarNetworkError } from '../../src/errors/index.js';

describe('Production Configuration Separation & Security Enforcement (MAINNET-06C)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const baseProdApiEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/luminarail',
    STELLAR_NETWORK: 'public',
    STELLAR_USDC_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    JWT_SECRET: 'super_secret_production_jwt_key_12345',
    PRODUCTION_SETTLEMENT_ENABLED: 'false',
    STELLAR_SIGNER_PROVIDER: 'testnet_local',
  };

  it('1. Production API configuration validates without KMS credentials when settlement is disabled', () => {
    const result = envSchema.safeParse(baseProdApiEnv);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.NODE_ENV).toBe('production');
      expect(result.data.STELLAR_NETWORK).toBe('public');
      expect(result.data.PRODUCTION_SETTLEMENT_ENABLED).toBe(false);
    }
  });

  it('2. Production API rejects testnet network when NODE_ENV is production', () => {
    const invalidEnv = {
      ...baseProdApiEnv,
      STELLAR_NETWORK: 'testnet',
    };
    const result = envSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('STELLAR_NETWORK'));
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('STELLAR_NETWORK must be set to "public" or "mainnet" when NODE_ENV is "production"');
    }
  });

  it('3. Production API rejects wrong USDC issuer on mainnet', () => {
    const invalidEnv = {
      ...baseProdApiEnv,
      STELLAR_USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', // testnet issuer
    };
    const result = envSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('STELLAR_USDC_ISSUER'));
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('STELLAR_USDC_ISSUER must be set to Circle Mainnet Issuer');
    }
  });

  it('4. Production API rejects default JWT secret', () => {
    const invalidEnv = {
      ...baseProdApiEnv,
      JWT_SECRET: 'dev_secret_change_me_in_production',
    };
    const result = envSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('JWT_SECRET'));
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('JWT_SECRET environment variable must be set to a secure key in production mode');
    }
  });

  it('5. Production API cannot select testnet_local for any production settlement capability (fails closed)', () => {
    (config as any).env = 'production';
    (config.stellar as any).network = 'public';
    (config.stellar as any).signerProvider = 'testnet_local';

    expect(() => resolveTransactionSigner()).toThrow(SorobanSignerConfigError);
    expect(() => resolveTransactionSigner()).toThrow('Local testnet signer cannot be used in production environment');
  });

  it('6. Production worker rejects missing Redis URL', async () => {
    (config as any).env = 'production';
    (config as any).redisUrl = '';
    (config as any).ngnProvider = 'sandbox';
    (config.stellar as any).network = 'public';
    (config.stellar as any).usdcIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    (config as any).productionSettlementEnabled = true;
    (config.stellar as any).signerProvider = 'aws_kms';
    (config.stellar as any).kmsKeyArn = 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012';
    (config.stellar as any).contractAdminGovernanceType = 'multisig';

    const runner = new LuminaRailWorkerRunner();
    await expect(runner.start({ runOnce: true })).rejects.toThrow('REDIS_URL environment variable is required for production worker process');
  });

  it('7. Production worker rejects testnet_local signer', async () => {
    (config as any).env = 'production';
    (config as any).redisUrl = 'redis://localhost:6379';
    (config.stellar as any).network = 'public';
    (config.stellar as any).usdcIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    (config as any).productionSettlementEnabled = true;
    (config.stellar as any).signerProvider = 'testnet_local';
    (config.stellar as any).contractAdminGovernanceType = 'multisig';

    const runner = new LuminaRailWorkerRunner();
    await expect(runner.start({ runOnce: true })).rejects.toThrow(SorobanSignerConfigError);
  });

  it('8. Production worker rejects missing KMS configuration when aws_kms is selected', async () => {
    (config as any).env = 'production';
    (config as any).redisUrl = 'redis://localhost:6379';
    (config.stellar as any).network = 'public';
    (config.stellar as any).usdcIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    (config as any).productionSettlementEnabled = true;
    (config.stellar as any).signerProvider = 'aws_kms';
    (config.stellar as any).kmsKeyArn = '';
    (config.stellar as any).contractAdminGovernanceType = 'multisig';

    const runner = new LuminaRailWorkerRunner();
    await expect(runner.start({ runOnce: true })).rejects.toThrow(SorobanSignerConfigError);
  });

  it('9. Production worker rejects settlement enabled with invalid mainnet configuration (e.g. testnet network)', () => {
    const invalidEnv = {
      ...baseProdApiEnv,
      STELLAR_NETWORK: 'testnet',
      PRODUCTION_SETTLEMENT_ENABLED: 'true',
      STELLAR_SIGNER_PROVIDER: 'aws_kms',
      STELLAR_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012',
    };
    const result = envSchema.safeParse(invalidEnv);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('PRODUCTION_SETTLEMENT_ENABLED'));
      expect(issue).toBeDefined();
    }
  });

  it('10. Production worker accepts a fully valid production configuration', () => {
    const validProdEnv = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/luminarail',
      STELLAR_NETWORK: 'public',
      STELLAR_USDC_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      JWT_SECRET: 'super_secret_production_jwt_key_12345',
      PRODUCTION_SETTLEMENT_ENABLED: 'true',
      STELLAR_SIGNER_PROVIDER: 'aws_kms',
      STELLAR_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012',
      STELLAR_CONTRACT_ADMIN_GOVERNANCE_TYPE: 'multisig',
      REDIS_URL: 'redis://localhost:6379',
    };

    const result = envSchema.safeParse(validProdEnv);
    expect(result.success).toBe(true);
  });
});

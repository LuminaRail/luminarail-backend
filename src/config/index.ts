import dotenv from 'dotenv';
import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';

dotenv.config();

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.string().transform((val) => parseInt(val, 10)).default('4000'),
  API_PREFIX: z.string().default('/api/v1'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL environment variable is required'),
  REDIS_URL: z.string().optional().default('redis://localhost:6379'),
  WORKER_LOCK_TTL_MS: z.string().transform((val) => parseInt(val, 10)).default('15000'),
  WORKER_LOCK_HEARTBEAT_MS: z.string().transform((val) => parseInt(val, 10)).default('5000'),
  WORKER_LOCK_ACQUIRE_TIMEOUT_MS: z.string().transform((val) => parseInt(val, 10)).default('3000'),
  REQUIRE_DISTRIBUTED_LOCKS: z.string().optional().transform((val) => val === 'true' || val === '1').default('false'),
  WORKER_LIVENESS_ENABLED: z.string().optional().transform((val) => val !== 'false' && val !== '0').default('true'),
  WORKER_LIVENESS_PORT: z.string().transform((val) => parseInt(val, 10)).default('4001'),
  WORKER_LIVENESS_MAX_SWEEP_AGE_MS: z.string().transform((val) => parseInt(val, 10)).default('120000'),
  STELLAR_NETWORK: z.enum(['testnet', 'futurenet', 'public', 'mainnet']).default('testnet'),
  STELLAR_RPC_URL: z.string().url('STELLAR_RPC_URL must be a valid URL').default('https://soroban-testnet.stellar.org'),
  STELLAR_HORIZON_URL: z.string().url('STELLAR_HORIZON_URL must be a valid URL').default('https://horizon-testnet.stellar.org'),
  STELLAR_USDC_ISSUER: z
    .string()
    .min(1, 'STELLAR_USDC_ISSUER environment variable is required')
    .refine((val) => StrKey.isValidEd25519PublicKey(val), {
      message: 'STELLAR_USDC_ISSUER must be a valid Stellar public key address',
    }),

  STELLAR_USDC_CONTRACT_ID: z
    .string()
    .optional()
    .refine((val) => !val || StrKey.isValidContract(val), {
      message: 'STELLAR_USDC_CONTRACT_ID must be a valid Stellar contract address',
    }),
  STELLAR_SETTLEMENT_VAULT_CONTRACT_ID: z.string().optional().default(''),
  SOROBAN_SETTLEMENT_VAULT_CONTRACT_ID: z.string().optional().default(''),
  SOROBAN_ESCROW_CONTRACT_ID: z.string().optional().default(''),
  SOROBAN_FEE_MANAGER_CONTRACT_ID: z.string().optional().default(''),
  STELLAR_SETTLEMENT_SIGNER_PUBLIC_KEY: z
    .string()
    .optional()
    .refine((val) => !val || StrKey.isValidEd25519PublicKey(val), {
      message: 'STELLAR_SETTLEMENT_SIGNER_PUBLIC_KEY must be a valid Stellar public key address',
    }),
  STELLAR_SETTLEMENT_SIGNER_SECRET_KEY: z
    .string()
    .optional()
    .refine((val) => !val || StrKey.isValidEd25519SecretSeed(val), {
      message: 'STELLAR_SETTLEMENT_SIGNER_SECRET_KEY must be a valid Stellar secret seed',
    }),
  JWT_SECRET: z.string().default('dev_secret_change_me_in_production'),
  JWT_EXPIRES_IN: z.string().default('1d'),
  NGN_PROVIDER: z.enum(['sandbox', 'paystack']).default('sandbox'),
  PAYSTACK_SECRET_KEY: z.string().optional().default(''),
  PAYSTACK_BASE_URL: z.string().url('PAYSTACK_BASE_URL must be a valid URL').default('https://api.paystack.co'),
  FX_API_URL: z.string().url('FX_API_URL must be a valid URL').default('https://open.er-api.com/v6/latest/USD'),
  FX_API_KEY: z.string().optional().default(''),
  QUOTE_PROVIDER: z.enum(['real', 'mock']).default('real'),
  QUOTE_EXPIRY_SECONDS: z.string().transform((val) => parseInt(val, 10)).default('300'),
  QUOTE_TTL_SECONDS: z.string().transform((val) => parseInt(val, 10)).default('300'),
  FX_RATE_MAX_AGE_SECONDS: z.string().transform((val) => parseInt(val, 10)).default('300'),
  QUOTE_FEE_PERCENTAGE: z.string().transform((val) => parseFloat(val)).default('0.01'),
  QUOTE_SPREAD_PERCENTAGE: z.string().transform((val) => parseFloat(val)).default('0'),
  MIN_NGN_AMOUNT: z.string().transform((val) => parseFloat(val)).default('1000'),
  MAX_NGN_AMOUNT: z.string().transform((val) => parseFloat(val)).default('10000000'),
  MAX_QUOTE_USDC_AMOUNT: z.string().transform((val) => parseFloat(val)).default('10000'),
  STELLAR_SIGNER_PROVIDER: z.enum(['testnet_local', 'aws_kms', 'gcp_kms', 'fireblocks']).default('testnet_local'),
  AWS_REGION: z.string().optional().default('us-east-1'),
  STELLAR_KMS_KEY_ARN: z.string().optional().default(''),
  AWS_KMS_SIGNING_KEY_ID: z.string().optional().default(''),
  PRODUCTION_SETTLEMENT_ENABLED: z.string().optional().transform((val) => val === 'true' || val === '1').default('false'),
  MAX_SINGLE_SETTLEMENT_USDC: z.string().transform((val) => parseFloat(val)).default('10000'),
  MAX_HOURLY_OUTFLOW_USDC: z.string().transform((val) => parseFloat(val)).default('50000'),
  MAX_DAILY_OUTFLOW_USDC: z.string().transform((val) => parseFloat(val)).default('200000'),
  MIN_SETTLEMENT_USDC: z.string().transform((val) => parseFloat(val)).default('1'),
  TREASURY_LOW_BALANCE_THRESHOLD: z.string().transform((val) => parseFloat(val)).default('5000'),
  TREASURY_WARN_THRESHOLD_USDC: z.string().transform((val) => parseFloat(val)).default('5000'),
  TREASURY_CRITICAL_THRESHOLD_USDC: z.string().transform((val) => parseFloat(val)).default('1000'),
  STELLAR_CONTRACT_ADMIN_GOVERNANCE_TYPE: z.enum(['single_key', 'multisig', 'dao']).default('single_key'),
  STELLAR_CONTRACT_ADMIN_ADDRESS: z.string().optional().default(''),
  EMERGENCY_GLOBAL_PAUSE: z.string().transform((val) => val === 'true' || val === '1').default('false'),
}).refine((data) => {
  if (data.NGN_PROVIDER === 'paystack' && (!data.PAYSTACK_SECRET_KEY || data.PAYSTACK_SECRET_KEY.trim() === '')) {
    return false;
  }
  return true;
}, {
  message: 'PAYSTACK_SECRET_KEY environment variable is required when NGN_PROVIDER is set to "paystack".',
  path: ['PAYSTACK_SECRET_KEY'],
}).refine((data) => {
  if (data.NODE_ENV === 'production' && data.JWT_SECRET === 'dev_secret_change_me_in_production') {
    return false;
  }
  return true;
}, {
  message: 'JWT_SECRET environment variable must be set to a secure key in production mode.',
  path: ['JWT_SECRET'],
}).refine((data) => {
  const isMainnet = data.STELLAR_NETWORK === 'public' || data.STELLAR_NETWORK === 'mainnet';
  if (data.NODE_ENV === 'production' && !isMainnet) {
    return false;
  }
  return true;
}, {
  message: 'STELLAR_NETWORK must be set to "public" or "mainnet" when NODE_ENV is "production".',
  path: ['STELLAR_NETWORK'],
}).refine((data) => {
  const isMainnet = data.STELLAR_NETWORK === 'public' || data.STELLAR_NETWORK === 'mainnet';
  const MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  if (isMainnet && data.STELLAR_USDC_ISSUER !== MAINNET_USDC_ISSUER) {
    return false;
  }
  return true;
}, {
  message: 'STELLAR_USDC_ISSUER must be set to Circle Mainnet Issuer (GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN) for public/mainnet networks.',
  path: ['STELLAR_USDC_ISSUER'],
}).refine((data) => {
  const isMainnet = data.STELLAR_NETWORK === 'public' || data.STELLAR_NETWORK === 'mainnet';
  const MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  if (!isMainnet && data.STELLAR_USDC_ISSUER === MAINNET_USDC_ISSUER) {
    return false;
  }
  return true;
}, {
  message: 'Circle Mainnet USDC Issuer cannot be used when STELLAR_NETWORK is testnet/futurenet.',
  path: ['STELLAR_USDC_ISSUER'],
}).refine((data) => {
  const isMainnet = data.STELLAR_NETWORK === 'public' || data.STELLAR_NETWORK === 'mainnet';
  const MAINNET_CONTRACT = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
  if (isMainnet && data.STELLAR_USDC_CONTRACT_ID && data.STELLAR_USDC_CONTRACT_ID !== MAINNET_CONTRACT) {
    return false;
  }
  return true;
}, {
  message: 'STELLAR_USDC_CONTRACT_ID must be Circle Mainnet Soroban Contract ID (CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75) when network is public/mainnet.',
  path: ['STELLAR_USDC_CONTRACT_ID'],
}).refine((data) => {
  if (data.NODE_ENV === 'production' && data.NGN_PROVIDER === 'paystack' && data.PAYSTACK_SECRET_KEY.startsWith('sk_test_')) {
    return false;
  }
  return true;
}, {
  message: 'PAYSTACK_SECRET_KEY cannot be a test key (sk_test_...) when NODE_ENV is "production".',
  path: ['PAYSTACK_SECRET_KEY'],
}).refine((data) => {
  if (data.PRODUCTION_SETTLEMENT_ENABLED) {
    const isMainnet = data.STELLAR_NETWORK === 'public' || data.STELLAR_NETWORK === 'mainnet';
    const MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    const hasValidSigner = data.STELLAR_SIGNER_PROVIDER !== 'testnet_local';
    const hasKmsKey = data.STELLAR_SIGNER_PROVIDER !== 'aws_kms' || Boolean((data.STELLAR_KMS_KEY_ARN || data.AWS_KMS_SIGNING_KEY_ID)?.trim());
    const hasValidGov = data.STELLAR_CONTRACT_ADMIN_GOVERNANCE_TYPE !== 'single_key';
    if (!isMainnet || data.STELLAR_USDC_ISSUER !== MAINNET_USDC_ISSUER || !hasValidSigner || !hasKmsKey || !hasValidGov) {
      return false;
    }
  }
  return true;
}, {
  message: 'PRODUCTION_SETTLEMENT_ENABLED requires mainnet network, Circle mainnet USDC issuer, non-local signer provider, valid KMS key ARN, and multisig/dao governance.',
  path: ['PRODUCTION_SETTLEMENT_ENABLED'],
}).refine((data) => {
  if (data.TREASURY_CRITICAL_THRESHOLD_USDC > data.TREASURY_WARN_THRESHOLD_USDC) {
    return false;
  }
  return true;
}, {
  message: 'TREASURY_CRITICAL_THRESHOLD_USDC must be less than or equal to TREASURY_WARN_THRESHOLD_USDC.',
  path: ['TREASURY_CRITICAL_THRESHOLD_USDC'],
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Environment configuration validation failed:');
  parsedEnv.error.issues.forEach((issue) => {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  });
  throw new Error('Invalid application environment configuration.');
}

const envData = parsedEnv.data;

export const config = {
  env: envData.NODE_ENV,
  port: envData.PORT,
  apiPrefix: envData.API_PREFIX,
  databaseUrl: envData.DATABASE_URL,
  redisUrl: envData.REDIS_URL,
  redis: {
    url: envData.REDIS_URL,
    lockTtlMs: envData.WORKER_LOCK_TTL_MS,
    lockHeartbeatMs: envData.WORKER_LOCK_HEARTBEAT_MS,
    lockAcquireTimeoutMs: envData.WORKER_LOCK_ACQUIRE_TIMEOUT_MS,
    requireDistributedLocks: envData.REQUIRE_DISTRIBUTED_LOCKS,
  },
  worker: {
    livenessEnabled: envData.WORKER_LIVENESS_ENABLED,
    livenessPort: envData.WORKER_LIVENESS_PORT,
    livenessMaxSweepAgeMs: envData.WORKER_LIVENESS_MAX_SWEEP_AGE_MS,
  },
  productionSettlementEnabled: envData.PRODUCTION_SETTLEMENT_ENABLED,
  stellar: {
    network: envData.STELLAR_NETWORK,
    rpcUrl: envData.STELLAR_RPC_URL,
    horizonUrl: envData.STELLAR_HORIZON_URL,
    usdcIssuer: envData.STELLAR_USDC_ISSUER,
    usdcContractId: envData.STELLAR_USDC_CONTRACT_ID,
    settlementVaultContractId: envData.SOROBAN_SETTLEMENT_VAULT_CONTRACT_ID || envData.STELLAR_SETTLEMENT_VAULT_CONTRACT_ID,
    escrowContractId: envData.SOROBAN_ESCROW_CONTRACT_ID,
    feeManagerContractId: envData.SOROBAN_FEE_MANAGER_CONTRACT_ID,
    signerPublicKey: envData.STELLAR_SETTLEMENT_SIGNER_PUBLIC_KEY,
    signerSecretKey: envData.STELLAR_SETTLEMENT_SIGNER_SECRET_KEY,
    signerProvider: envData.STELLAR_SIGNER_PROVIDER,
    kmsKeyArn: envData.STELLAR_KMS_KEY_ARN || envData.AWS_KMS_SIGNING_KEY_ID,
    awsRegion: envData.AWS_REGION,
    contractAdminGovernanceType: envData.STELLAR_CONTRACT_ADMIN_GOVERNANCE_TYPE,
    contractAdminAddress: envData.STELLAR_CONTRACT_ADMIN_ADDRESS,
  },
  treasury: {
    maxSingleSettlementUsdc: envData.MAX_SINGLE_SETTLEMENT_USDC,
    maxHourlyOutflowUsdc: envData.MAX_HOURLY_OUTFLOW_USDC,
    maxDailyOutflowUsdc: envData.MAX_DAILY_OUTFLOW_USDC,
    minSettlementUsdc: envData.MIN_SETTLEMENT_USDC,
    lowBalanceThreshold: envData.TREASURY_LOW_BALANCE_THRESHOLD,
    warnThresholdUsdc: envData.TREASURY_WARN_THRESHOLD_USDC,
    criticalThresholdUsdc: envData.TREASURY_CRITICAL_THRESHOLD_USDC,
    emergencyGlobalPause: envData.EMERGENCY_GLOBAL_PAUSE,
  },
  jwt: {
    secret: envData.JWT_SECRET,
    expiresIn: envData.JWT_EXPIRES_IN,
  },
  quotes: {
    provider: envData.QUOTE_PROVIDER,
    fxApiUrl: envData.FX_API_URL,
    fxApiKey: envData.FX_API_KEY,
    expirySeconds: envData.QUOTE_TTL_SECONDS || envData.QUOTE_EXPIRY_SECONDS,
    ttlSeconds: envData.QUOTE_TTL_SECONDS || envData.QUOTE_EXPIRY_SECONDS,
    fxMaxAgeSeconds: envData.FX_RATE_MAX_AGE_SECONDS,
    feePercentage: envData.QUOTE_FEE_PERCENTAGE,
    spreadPercentage: envData.QUOTE_SPREAD_PERCENTAGE,
    minNgnAmount: envData.MIN_NGN_AMOUNT,
    maxNgnAmount: envData.MAX_NGN_AMOUNT,
    maxQuoteUsdcAmount: envData.MAX_QUOTE_USDC_AMOUNT,
  },
  ngnProvider: envData.NGN_PROVIDER,
  paystack: {
    secretKey: envData.PAYSTACK_SECRET_KEY,
    baseUrl: envData.PAYSTACK_BASE_URL,
  },
};

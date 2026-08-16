import dotenv from 'dotenv';
import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';

dotenv.config();

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().transform((val) => parseInt(val, 10)).default('4000'),
  API_PREFIX: z.string().default('/api/v1'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL environment variable is required'),
  REDIS_URL: z.string().optional().default('redis://localhost:6379'),
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
  QUOTE_EXPIRY_SECONDS: z.string().transform((val) => parseInt(val, 10)).default('180'),
  QUOTE_FEE_PERCENTAGE: z.string().transform((val) => parseFloat(val)).default('0.01'),
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
  },
  jwt: {
    secret: envData.JWT_SECRET,
    expiresIn: envData.JWT_EXPIRES_IN,
  },
  quotes: {
    provider: envData.QUOTE_PROVIDER,
    fxApiUrl: envData.FX_API_URL,
    fxApiKey: envData.FX_API_KEY,
    expirySeconds: envData.QUOTE_EXPIRY_SECONDS,
    feePercentage: envData.QUOTE_FEE_PERCENTAGE,
  },
  ngnProvider: envData.NGN_PROVIDER,
  paystack: {
    secretKey: envData.PAYSTACK_SECRET_KEY,
    baseUrl: envData.PAYSTACK_BASE_URL,
  },
};

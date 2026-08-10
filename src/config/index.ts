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
  STELLAR_SETTLEMENT_VAULT_CONTRACT_ID: z.string().optional().default(''),
  JWT_SECRET: z.string().default('dev_secret_change_me_in_production'),
  JWT_EXPIRES_IN: z.string().default('1d'),
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
    settlementVaultContractId: envData.STELLAR_SETTLEMENT_VAULT_CONTRACT_ID,
  },
  jwt: {
    secret: envData.JWT_SECRET,
    expiresIn: envData.JWT_EXPIRES_IN,
  },
};

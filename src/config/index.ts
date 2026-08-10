import dotenv from 'dotenv';

dotenv.config();

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  apiPrefix: process.env.API_PREFIX || '/api/v1',
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || '',
  stellar: {
    network: process.env.STELLAR_NETWORK || 'testnet',
    rpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
    horizonUrl: process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
    usdcIssuer: process.env.STELLAR_USDC_ISSUER || '',
    settlementVaultContractId: process.env.STELLAR_SETTLEMENT_VAULT_CONTRACT_ID || '',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'dev_secret_change_me_in_production',
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
  },
};

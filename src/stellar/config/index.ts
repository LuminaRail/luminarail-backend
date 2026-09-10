import { Networks } from '@stellar/stellar-sdk';
import { config } from '../../config/index.js';
import { StellarNetworkError, SorobanSignerConfigError } from '../../errors/index.js';

export const STELLAR_MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
export const STELLAR_MAINNET_USDC_CONTRACT_ID = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';

export const STELLAR_TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
export const STELLAR_TESTNET_USDC_CONTRACT_ID = 'CBIELTK6YBZJU5UP2WWHLRHJB4EBHVGQZ22VJ2J53AEX4H5MHRG5U6PE';

export type SupportedStellarNetwork =
  | 'testnet'
  | 'futurenet'
  | 'public'
  | 'mainnet';

export function getNetworkPassphrase(network: string): string {
  const norm = network.toLowerCase();

  if (norm === 'public' || norm === 'mainnet') {
    return Networks.PUBLIC;
  }

  if (norm === 'futurenet') {
    return Networks.FUTURENET;
  }

  return Networks.TESTNET;
}

export function assertTestnetSafety(): void {
  const currentNetwork = config.stellar.network.toLowerCase();

  if (currentNetwork === 'public' || currentNetwork === 'mainnet') {
    if (config.env !== 'production' && config.env !== 'staging') {
      throw new StellarNetworkError(
        `Mainnet operations are strictly prohibited during ${config.env} environment development. Set STELLAR_NETWORK=testnet.`,
      );
    }
  }
}

/**
 * Production Settlement Safety Guard — Fail Closed Architecture
 *
 * Verifies that live settlement operations satisfy all production prerequisites before execution.
 */
export function assertProductionSettlementSafety(): void {
  const currentNetwork = config.stellar.network.toLowerCase();
  const isMainnet = currentNetwork === 'public' || currentNetwork === 'mainnet';

  // 1. If running on Testnet/Futurenet, block production settlement execution
  if (!isMainnet) {
    if (config.productionSettlementEnabled) {
      throw new StellarNetworkError(
        `Production settlement safety violation: PRODUCTION_SETTLEMENT_ENABLED is true, but STELLAR_NETWORK is set to '${currentNetwork}'. Operations fail closed.`
      );
    }
  }

  // 2. If running on Mainnet/Public, enforce all Production Prerequisites
  if (isMainnet) {
    if (!config.productionSettlementEnabled) {
      throw new StellarNetworkError(
        `Live settlement submission refused: STELLAR_NETWORK is '${currentNetwork}', but PRODUCTION_SETTLEMENT_ENABLED is false. Operations fail closed.`
      );
    }

    if (config.env !== 'production' && config.env !== 'staging') {
      throw new StellarNetworkError(
        `Mainnet settlement submission refused: NODE_ENV is '${config.env}'. Mainnet requires 'production' or 'staging'.`
      );
    }

    if (config.stellar.usdcIssuer !== STELLAR_MAINNET_USDC_ISSUER) {
      throw new StellarNetworkError(
        `Mainnet settlement safety violation: STELLAR_USDC_ISSUER is set to '${config.stellar.usdcIssuer}', expected Circle Mainnet Issuer '${STELLAR_MAINNET_USDC_ISSUER}'.`
      );
    }

    if (config.stellar.signerProvider === 'testnet_local') {
      throw new SorobanSignerConfigError(
        `FATAL SECURITY VIOLATION: Local testnet signer (testnet_local) is strictly forbidden for mainnet settlement submission.`
      );
    }

    if (config.ngnProvider === 'paystack' && config.paystack.secretKey.startsWith('sk_test_')) {
      throw new StellarNetworkError(
        `Mainnet settlement safety violation: Paystack test key (sk_test_...) cannot be used for production mainnet settlement.`
      );
    }

    assertContractGovernanceReadiness();
  }
}

/**
 * Asserts Smart Contract Governance Readiness for Mainnet.
 */
export function assertContractGovernanceReadiness(): void {
  const currentNetwork = config.stellar.network.toLowerCase();
  const isMainnet = currentNetwork === 'public' || currentNetwork === 'mainnet';

  if (isMainnet || config.env === 'production') {
    if (config.stellar.contractAdminGovernanceType === 'single_key') {
      throw new SorobanSignerConfigError(
        `FATAL SECURITY VIOLATION: Soroban smart contract admin cannot be single_key in production mainnet mode. Admin must be multisig or dao governance address.`
      );
    }
  }
}

/**
 * Legacy compatibility alias for assertProductionSettlementSafety
 */
export function assertLiveSettlementTestnetSafety(): void {
  assertProductionSettlementSafety();
}


export const stellarConfig = {
  get network(): SupportedStellarNetwork {
    return config.stellar.network.toLowerCase() as SupportedStellarNetwork;
  },

  get horizonUrl(): string {
    return config.stellar.horizonUrl;
  },

  get rpcUrl(): string {
    return config.stellar.rpcUrl;
  },

  get passphrase(): string {
    return getNetworkPassphrase(config.stellar.network);
  },

  get isTestnet(): boolean {
    const net = config.stellar.network.toLowerCase();
    return net === 'testnet' || net === 'futurenet';
  },

  get usdcIssuer(): string {
    return config.stellar.usdcIssuer;
  },

  get usdcContractId(): string {
  if (!config.stellar.usdcContractId) {
    throw new Error(
      'STELLAR_USDC_CONTRACT_ID is required for Soroban USDC operations'
    );
  }

  return config.stellar.usdcContractId;
},
};

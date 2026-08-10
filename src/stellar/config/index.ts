import { Networks } from '@stellar/stellar-sdk';
import { config } from '../../config/index.js';
import { StellarNetworkError } from '../../errors/index.js';

export type SupportedStellarNetwork = 'testnet' | 'futurenet' | 'public' | 'mainnet';

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
    if (config.env !== 'production') {
      throw new StellarNetworkError(
        `Mainnet operations are strictly prohibited during ${config.env} environment development. Set STELLAR_NETWORK=testnet.`
      );
    }
  }
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
};

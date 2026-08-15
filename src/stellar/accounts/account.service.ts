import { StrKey } from '@stellar/stellar-sdk';
import { getHorizonClient } from '../horizon/client.js';
import { StellarInvalidAddressError } from '../../errors/index.js';
import { getStellarBalanceService } from '../balances/balance.service.js';

export interface NormalizedStellarAccount {
  address: string;
  sequence: string;
  subentryCount: number;
  exists: boolean;
  balances: Array<{
    assetType: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
    assetCode: string;
    assetIssuer: string | null;
    balance: string;
  }>;
}

export class StellarAccountService {
  public validateAddress(address: string): boolean {
    if (!address || typeof address !== 'string') {
      return false;
    }
    // Reject secret keys (starts with S) or seed phrases
    if (address.startsWith('S') || StrKey.isValidEd25519SecretSeed(address)) {
      throw new StellarInvalidAddressError('Secret keys and seed phrases are strictly forbidden.');
    }
    return StrKey.isValidEd25519PublicKey(address);
  }

  public async accountExists(address: string): Promise<boolean> {
    if (!this.validateAddress(address)) {
      throw new StellarInvalidAddressError(`Invalid Stellar public key format: ${address}`);
    }
    const horizon = getHorizonClient();
    return horizon.checkAccountExists(address);
  }

  public async getAccountDetails(address: string): Promise<NormalizedStellarAccount> {
    if (!this.validateAddress(address)) {
      throw new StellarInvalidAddressError(`Invalid Stellar public key format: ${address}`);
    }

    const horizon = getHorizonClient();
    const accountRecord = await horizon.loadAccount(address);
    const balanceService = getStellarBalanceService();

    const normalizedBalances = balanceService.normalizeBalances(accountRecord.balances);

    return {
      address: accountRecord.account_id,
      sequence: accountRecord.sequence,
      subentryCount: accountRecord.subentry_count,
      exists: true,
      balances: normalizedBalances,
    };
  }

  public async getAccountSequence(address: string): Promise<string> {
    if (!this.validateAddress(address)) {
      throw new StellarInvalidAddressError(`Invalid Stellar public key format: ${address}`);
    }
    const horizon = getHorizonClient();
    const account = await horizon.loadAccount(address);
    return account.sequence;
  }
}

let accountServiceInstance: StellarAccountService | null = null;

export function getStellarAccountService(): StellarAccountService {
  if (!accountServiceInstance) {
    accountServiceInstance = new StellarAccountService();
  }
  return accountServiceInstance;
}

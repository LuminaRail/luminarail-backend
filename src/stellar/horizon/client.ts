import { Horizon } from '@stellar/stellar-sdk';
import { stellarConfig, assertTestnetSafety } from '../config/index.js';
import {
  StellarAccountNotFoundError,
  StellarTransactionNotFoundError,
  StellarNetworkError,
} from '../../errors/index.js';

export class StellarHorizonClient {
  private server: Horizon.Server;

  constructor() {
    assertTestnetSafety();
    this.server = new Horizon.Server(stellarConfig.horizonUrl);
  }

  public getRawServer(): Horizon.Server {
    return this.server;
  }

  public async loadAccount(address: string): Promise<Horizon.AccountResponse> {
    try {
      return await this.server.loadAccount(address);
    } catch (err: any) {
      if (err?.response?.status === 404) {
        throw new StellarAccountNotFoundError(address);
      }
      throw new StellarNetworkError(`Failed to load account ${address} from Horizon`, err);
    }
  }

  public async checkAccountExists(address: string): Promise<boolean> {
    try {
      await this.server.loadAccount(address);
      return true;
    } catch (err: any) {
      if (err?.response?.status === 404) {
        return false;
      }
      throw new StellarNetworkError(`Failed to check existence for account ${address}`, err);
    }
  }

  public async fetchTransaction(hash: string): Promise<Horizon.ServerApi.TransactionRecord> {
    try {
      return await this.server.transactions().transaction(hash).call();
    } catch (err: any) {
      if (err?.response?.status === 404) {
        throw new StellarTransactionNotFoundError(hash);
      }
      throw new StellarNetworkError(`Failed to fetch transaction ${hash} from Horizon`, err);
    }
  }

  public async fetchPayments(
    address: string,
    limit = 10
  ): Promise<Horizon.ServerApi.CollectionPage<Horizon.ServerApi.OperationRecord>> {
    try {
      return await this.server
        .payments()
        .forAccount(address)
        .order('desc')
        .limit(limit)
        .call();
    } catch (err: any) {
      if (err?.response?.status === 404) {
        throw new StellarAccountNotFoundError(address);
      }
      throw new StellarNetworkError(`Failed to fetch payments for account ${address}`, err);
    }
  }
}

let horizonClientInstance: StellarHorizonClient | null = null;

export function getHorizonClient(): StellarHorizonClient {
  if (!horizonClientInstance) {
    horizonClientInstance = new StellarHorizonClient();
  }
  return horizonClientInstance;
}

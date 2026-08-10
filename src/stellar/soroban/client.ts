import { rpc, Transaction, xdr } from '@stellar/stellar-sdk';
import { stellarConfig, assertTestnetSafety } from '../config/index.js';
import { StellarRpcError } from '../../errors/index.js';

export class StellarSorobanClient {
  private server: rpc.Server;

  constructor() {
    assertTestnetSafety();
    this.server = new rpc.Server(stellarConfig.rpcUrl);
  }

  public getRawServer(): rpc.Server {
    return this.server;
  }

  public async getLatestLedger(): Promise<number> {
    try {
      const response = await this.server.getLatestLedger();
      return response.sequence;
    } catch (err) {
      throw new StellarRpcError('Failed to fetch latest Soroban ledger sequence.', err);
    }
  }

  public async getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<rpc.Api.GetLedgerEntriesResponse> {
    try {
      return await this.server.getLedgerEntries(...keys);
    } catch (err) {
      throw new StellarRpcError('Failed to fetch Soroban ledger entries.', err);
    }
  }

  public async getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    try {
      return await this.server.getTransaction(hash);
    } catch (err) {
      throw new StellarRpcError(`Failed to fetch Soroban transaction info for ${hash}.`, err);
    }
  }

  public async simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse> {
    try {
      return await this.server.simulateTransaction(tx);
    } catch (err) {
      throw new StellarRpcError('Failed to simulate Soroban transaction.', err);
    }
  }

  public async sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse> {
    try {
      return await this.server.sendTransaction(tx);
    } catch (err) {
      throw new StellarRpcError('Failed to submit Soroban transaction.', err);
    }
  }
}

let sorobanClientInstance: StellarSorobanClient | null = null;

export function getSorobanClient(): StellarSorobanClient {
  if (!sorobanClientInstance) {
    sorobanClientInstance = new StellarSorobanClient();
  }
  return sorobanClientInstance;
}

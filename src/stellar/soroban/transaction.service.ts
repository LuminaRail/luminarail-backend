import {
  Account,
  Address,
  Contract,
  Keypair,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  StrKey,
} from '@stellar/stellar-sdk';
import { config } from '../../config/index.js';
import { stellarConfig, assertLiveSettlementTestnetSafety } from '../config/index.js';
import { getSorobanClient, StellarSorobanClient } from './client.js';
import {
  SorobanSimulationError,
  SorobanSubmissionError,
  SorobanSignerConfigError,
  SorobanContractConfigError,
} from '../../errors/index.js';
import { SubmitSettlementParams } from '../settlement.executor.js';

export function parseSettlementIdToU64(settlementId: string): bigint {
  const numericPart = settlementId.replace(/\D/g, '');
  if (numericPart.length >= 8) {
    const truncated = numericPart.substring(0, 18);
    return BigInt(truncated);
  }
  let hash = 14695981039346656037n;
  const FNV_PRIME = 1099511628211n;
  for (let i = 0; i < settlementId.length; i++) {
    hash ^= BigInt(settlementId.charCodeAt(i));
    hash = (hash * FNV_PRIME) & 0xffffffffffffffffn;
  }
  return hash;
}

export function parseAmountToStroops(amount: string): bigint {
  const parts = amount.split('.');
  const integerPart = parts[0] || '0';
  let decimalPart = parts[1] || '';
  if (decimalPart.length > 7) {
    decimalPart = decimalPart.substring(0, 7);
  } else {
    decimalPart = decimalPart.padEnd(7, '0');
  }
  return BigInt(integerPart + decimalPart);
}

export class SorobanTransactionService {
  private clientInstance: StellarSorobanClient | null = null;

  constructor(client?: StellarSorobanClient) {
    if (client) {
      this.clientInstance = client;
    }
  }

  private get sorobanClient(): StellarSorobanClient {
    if (!this.clientInstance) {
      this.clientInstance = getSorobanClient();
    }
    return this.clientInstance;
  }

  public async buildAndSubmitSettlementTransaction(
    params: SubmitSettlementParams
  ): Promise<{ transactionHash: string }> {
    // 1. Enforce Testnet safety guard
    assertLiveSettlementTestnetSafety();

    // 2. Validate contract configuration
    const contractId = params.contractAddress || config.stellar.settlementVaultContractId;
    if (!contractId || contractId.trim() === '') {
      throw new SorobanContractConfigError('Soroban Settlement Vault Contract ID is not configured.');
    }

    // 3. Validate signer configuration
    const secretKey = config.stellar.signerSecretKey;
    if (!secretKey) {
      throw new SorobanSignerConfigError('STELLAR_SETTLEMENT_SIGNER_SECRET_KEY is not configured.');
    }

    const signerKeypair = Keypair.fromSecret(secretKey);
    const signerPublicKey = config.stellar.signerPublicKey || signerKeypair.publicKey();

    if (config.stellar.signerPublicKey && config.stellar.signerPublicKey !== signerKeypair.publicKey()) {
      throw new SorobanSignerConfigError(
        'Configured STELLAR_SETTLEMENT_SIGNER_PUBLIC_KEY does not match secret key.'
      );
    }

    // 4. Resolve source account sequence from network
    const server = this.sorobanClient.getRawServer();
    let accountResponse;
    try {
      accountResponse = await server.getAccount(signerPublicKey);
    } catch (err: unknown) {
      throw new SorobanSubmissionError(
        `Failed to fetch account sequence for signer address ${signerPublicKey}.`,
        err
      );
    }

    const account = new Account(signerPublicKey, accountResponse.sequenceNumber());

    // 5. Parse contract parameters
    const settlementIdU64 = parseSettlementIdToU64(params.settlementId);
    const amountStroops = parseAmountToStroops(params.amount);
    const sourceAddress = params.source || signerPublicKey;
    const destinationAddress = params.destination;

    if (!destinationAddress || !StrKey.isValidEd25519PublicKey(destinationAddress)) {
      throw new SorobanSubmissionError(`Invalid destination Stellar address: ${destinationAddress}`);
    }

    const assetAddress = StrKey.isValidContract(params.asset) || StrKey.isValidEd25519PublicKey(params.asset)
      ? params.asset
      : config.stellar.usdcIssuer;

    const contract = new Contract(contractId);

    // 6. Build Soroban invocation operation (create_settlement)
    const tx: Transaction = new TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: stellarConfig.passphrase,
    })
      .addOperation(
        contract.call(
          'create_settlement',
          nativeToScVal(settlementIdU64, { type: 'u64' }),
          nativeToScVal(new Address(sourceAddress)),
          nativeToScVal(new Address(destinationAddress)),
          nativeToScVal(new Address(assetAddress)),
          nativeToScVal(amountStroops, { type: 'i128' })
        )
      )
      .setTimeout(30)
      .build();

    // 7. Simulate transaction
    const simulation = await this.sorobanClient.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simulation)) {
      throw new SorobanSimulationError(
        `Soroban transaction simulation error: ${simulation.error}`
      );
    }

    if (!rpc.Api.isSimulationSuccess(simulation)) {
      throw new SorobanSimulationError('Soroban transaction simulation failed to execute successfully.');
    }

    // 8. Assemble prepared transaction with simulation footprint and fees
    const preparedTx = rpc.assembleTransaction(tx, simulation).build();

    // 9. Sign transaction with backend Testnet signer
    preparedTx.sign(signerKeypair);

    // 10. Submit to Soroban RPC
    const sendResponse = await this.sorobanClient.sendTransaction(preparedTx);

    if (sendResponse.status === 'ERROR') {
      throw new SorobanSubmissionError(
        `Soroban RPC rejected transaction submission with status ERROR.`
      );
    }

    return {
      transactionHash: sendResponse.hash,
    };
  }
}

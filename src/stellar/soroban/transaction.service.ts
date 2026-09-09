import {
  Account,
  Address,
  Contract,
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
  SorobanContractConfigError,
} from '../../errors/index.js';
import { SubmitSettlementParams } from '../settlement.executor.js';
import { ITransactionSigner } from '../signer/signer.interface.js';
import { resolveTransactionSigner } from '../signer/testnet-local.signer.js';
import { AuthorizationPolicyContext, SignTransactionRequest, SignTransactionResponse } from '../signer/types.js';

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

export interface PreparedUnsignedSettlement {
  unsignedTransactionXdr: string;
  context: AuthorizationPolicyContext;
}

export class SorobanTransactionService {
  private clientInstance: StellarSorobanClient | null = null;
  private signerInstance: ITransactionSigner | null = null;

  constructor(client?: StellarSorobanClient, signer?: ITransactionSigner) {
    if (client) {
      this.clientInstance = client;
    }
    if (signer) {
      this.signerInstance = signer;
    }
  }

  private get sorobanClient(): StellarSorobanClient {
    if (!this.clientInstance) {
      this.clientInstance = getSorobanClient();
    }
    return this.clientInstance;
  }

  private get transactionSigner(): ITransactionSigner {
    if (!this.signerInstance) {
      this.signerInstance = resolveTransactionSigner();
    }
    return this.signerInstance;
  }

  /**
   * Step 1: Build & Simulate Unsigned Transaction XDR with context metadata.
   */
  public async buildUnsignedSettlementTransaction(
    params: SubmitSettlementParams
  ): Promise<PreparedUnsignedSettlement> {
    assertLiveSettlementTestnetSafety();

    const contractId = params.contractAddress || config.stellar.settlementVaultContractId;
    if (!contractId || contractId.trim() === '') {
      throw new SorobanContractConfigError('Soroban Settlement Vault Contract ID is not configured.');
    }

    const identity = await this.transactionSigner.getIdentity();
    const signerPublicKey = identity.publicKey;

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
    const settlementIdU64 = parseSettlementIdToU64(params.settlementId);
    const amountStroops = parseAmountToStroops(params.amount);
    const sourceAddress =
      !params.source || params.source === 'LUMINA_TREASURY'
        ? signerPublicKey
        : params.source;

    const destinationAddress = params.destination;

    if (!StrKey.isValidEd25519PublicKey(sourceAddress)) {
      throw new SorobanSubmissionError(`Invalid source Stellar address: ${sourceAddress}`);
    }

    if (!destinationAddress || !StrKey.isValidEd25519PublicKey(destinationAddress)) {
      throw new SorobanSubmissionError(`Invalid destination Stellar address: ${destinationAddress}`);
    }

    const assetAddress =
      params.asset && StrKey.isValidContract(params.asset)
        ? params.asset
        : stellarConfig.usdcContractId;

    const contract = new Contract(contractId);

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

    const simulation = await this.sorobanClient.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simulation)) {
      throw new SorobanSimulationError(
        `Soroban transaction simulation error: ${simulation.error}`
      );
    }

    if (!rpc.Api.isSimulationSuccess(simulation)) {
      throw new SorobanSimulationError('Soroban transaction simulation failed to execute successfully.');
    }

    const preparedTx = rpc.assembleTransaction(tx, simulation).build();

    const context: AuthorizationPolicyContext = {
      settlementId: params.settlementId,
      orderId: params.orderId,
      expectedSource: sourceAddress,
      expectedDestination: destinationAddress,
      expectedAmountStroops: amountStroops,
      expectedAssetContract: assetAddress,
      expectedVaultContract: contractId,
    };

    return {
      unsignedTransactionXdr: preparedTx.toXDR(),
      context,
    };
  }

  /**
   * Step 2: Policy Validation & Cryptographic Signing via Signer Interface.
   */
  public async signSettlementTransaction(
    request: SignTransactionRequest,
    customSigner?: ITransactionSigner
  ): Promise<SignTransactionResponse> {
    const signer = customSigner || this.transactionSigner;
    return signer.signTransaction(request);
  }

  /**
   * Step 3: Broadcast Pre-Signed Transaction XDR to Soroban RPC.
   */
  public async submitSignedSettlementTransaction(
    signedTransactionXdr: string
  ): Promise<{ transactionHash: string }> {
    const tx = TransactionBuilder.fromXDR(signedTransactionXdr, stellarConfig.passphrase);
    const sendResponse = await this.sorobanClient.sendTransaction(tx as Transaction);

    if (sendResponse.status === 'ERROR') {
      throw new SorobanSubmissionError(
        `Soroban RPC rejected transaction submission with status ERROR.`
      );
    }

    return {
      transactionHash: sendResponse.hash,
    };
  }

  /**
   * Orchestrated Settlement Flow (Build -> Policy Validate & Sign -> Submit).
   */
  public async buildAndSubmitSettlementTransaction(
    params: SubmitSettlementParams,
    customSigner?: ITransactionSigner
  ): Promise<{ transactionHash: string }> {
    const prepared = await this.buildUnsignedSettlementTransaction(params);
    const signedResult = await this.signSettlementTransaction(prepared, customSigner);
    return this.submitSignedSettlementTransaction(signedResult.signedTransactionXdr);
  }
}

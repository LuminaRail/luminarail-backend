import {
  Account,
  Contract,
  TransactionBuilder,
  rpc,
} from '@stellar/stellar-sdk';
import { config } from '../src/config/index.js';
import { stellarConfig } from '../src/stellar/config/index.js';
import { getSorobanClient } from '../src/stellar/soroban/client.js';

async function simulateContractCall(
  name: string,
  contractId: string,
  method: string,
) {
  const client = getSorobanClient();
  const server = client.getRawServer();

  const signer = config.stellar.signerPublicKey;

  if (!signer) {
    throw new Error('Signer public key is not configured.');
  }

  const accountResponse = await server.getAccount(signer);

  const account = new Account(
    signer,
    accountResponse.sequenceNumber(),
  );

  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: stellarConfig.passphrase,
  })
    .addOperation(contract.call(method))
    .setTimeout(30)
    .build();

  const simulation = await client.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`${name}: ${simulation.error}`);
  }

  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error(`${name}: simulation unsuccessful`);
  }

  console.log(`${name}: SUCCESS`);
}

async function main() {
  console.log(`Network: ${stellarConfig.network}`);

  await simulateContractCall(
    'Settlement Vault',
    config.stellar.settlementVaultContractId,
    'get_admin',
  );

  await simulateContractCall(
    'Fee Manager',
    config.stellar.feeManagerContractId,
    'get_fee_basis_points',
  );

  console.log(
    'Escrow contract configured:',
    config.stellar.escrowContractId,
  );
}

main().catch((error) => {
  console.error('Verification failed:', error);
  process.exit(1);
});

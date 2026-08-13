import {
  Account,
  Address,
  Contract,
  TransactionBuilder,
  rpc,
} from '@stellar/stellar-sdk';

import { config } from '../src/config/index.js';
import { stellarConfig } from '../src/stellar/config/index.js';
import { getSorobanClient } from '../src/stellar/soroban/client.js';

async function main() {
  const client = getSorobanClient();
  const server = client.getRawServer();

  const contractId = config.stellar.settlementVaultContractId;
  const signerPublicKey = config.stellar.signerPublicKey;

  if (!contractId) {
    throw new Error('Settlement Vault contract ID is not configured.');
  }

  if (!signerPublicKey) {
    throw new Error('Settlement signer public key is not configured.');
  }

  console.log('Network:', stellarConfig.network);
  console.log('Contract:', contractId);
  console.log('Backend signer:', signerPublicKey);

  const accountResponse = await server.getAccount(signerPublicKey);

  const account = new Account(
    signerPublicKey,
    accountResponse.sequenceNumber()
  );

  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: stellarConfig.passphrase,
  })
    .addOperation(contract.call('get_admin'))
    .setTimeout(30)
    .build();

  const simulation = await client.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }

  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error('Simulation did not return a successful result.');
  }

  const retval = simulation.result?.retval;

  if (!retval) {
    throw new Error('get_admin returned no value.');
  }

  const adminAddress = Address.fromScVal(retval).toString();

  console.log('Contract admin:', adminAddress);
  console.log('Backend signer:', signerPublicKey);
  console.log('Admin matches signer:', adminAddress === signerPublicKey);
}

main().catch((error) => {
  console.error('Verification failed:', error);
  process.exit(1);
});

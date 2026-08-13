import {
  Account,
  Address,
  Contract,
  Horizon,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk';

import { config } from '../src/config/index.js';
import { stellarConfig } from '../src/stellar/config/index.js';
import { getSorobanClient } from '../src/stellar/soroban/client.js';

async function main() {
  const signerKeypair = Keypair.fromSecret(
    config.stellar.signerSecretKey!
  );

  const signerPublicKey =
    config.stellar.signerPublicKey || signerKeypair.publicKey();

  const contractId =
    config.stellar.settlementVaultContractId;

  const destinationAddress = signerPublicKey;
  const sourceAddress = signerPublicKey;
  const assetAddress = config.stellar.usdcIssuer;

  console.log('Network:', config.stellar.network);
  console.log('Signer:', signerPublicKey);
  console.log('Contract:', contractId);
  console.log('Source:', sourceAddress);
  console.log('Destination:', destinationAddress);
  console.log('Asset:', assetAddress);

  // Use Horizon to obtain the classic account sequence.
  const horizonServer = new Horizon.Server(
    'https://horizon-testnet.stellar.org'
  );

  const accountResponse =
    await horizonServer.loadAccount(signerPublicKey);

  const account = new Account(
    signerPublicKey,
    accountResponse.sequence
  );

  const client = getSorobanClient();

  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: stellarConfig.passphrase,
  })
    .addOperation(
      contract.call(
        'create_settlement',
        nativeToScVal(123456789n, { type: 'u64' }),
        nativeToScVal(new Address(sourceAddress)),
        nativeToScVal(new Address(destinationAddress)),
        nativeToScVal(new Address(assetAddress)),
        nativeToScVal(99000000n, { type: 'i128' })
      )
    )
    .setTimeout(30)
    .build();

  console.log('\nSimulating...');

  const simulation =
    await client.simulateTransaction(tx);

  console.log(
    'Simulation success:',
    rpc.Api.isSimulationSuccess(simulation)
  );

  if (!rpc.Api.isSimulationSuccess(simulation)) {
    console.log('\nSimulation response:');
    console.dir(simulation, { depth: 10 });
    return;
  }

  const preparedTx =
    rpc.assembleTransaction(tx, simulation).build();

  const operations =
    preparedTx
      .toEnvelope()
      .v1()
      .tx()
      .operations();

  console.log(
    '\nOPERATION COUNT:',
    operations.length
  );

  for (let i = 0; i < operations.length; i++) {
    const operation = operations[i];

    console.log(`\n--- OPERATION ${i} ---`);

    console.log(
      'Operation type:',
      operation.body().switch().name
    );

    const operationValue =
      operation.body().value();

    console.log(
      'Operation value prototype methods:'
    );

    console.log(
      Object.getOwnPropertyNames(
        Object.getPrototypeOf(operationValue)
      )
    );

    console.log(
      '\nOperation value:'
    );

    console.dir(
      operationValue,
      { depth: 6 }
    );

    const invokeMethod =
      (operationValue as any)
        .invokeHostFunctionOp;

    if (typeof invokeMethod !== 'function') {
      console.log(
        '\ninvokeHostFunctionOp() is NOT available.'
      );
      continue;
    }

    const invoke =
      invokeMethod.call(operationValue);

    const authEntries =
      invoke.auth();

    console.log(
      '\nAUTH ENTRY COUNT:',
      authEntries.length
    );

    console.log(
      '\nAUTH ENTRIES:'
    );

    console.dir(
      authEntries,
      { depth: 20 }
    );
  }
}

main()
  .catch((error) => {
    console.error('\nFAILED:');
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    // Nothing to disconnect here.
  });

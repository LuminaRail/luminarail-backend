import { getSorobanClient } from '../src/stellar/soroban/client.js';

async function main() {
  const txHash =
    '5016d1096dbc5ac9e9c4337e98f6a5f0660d823cae618c57eb89e33cdd0514cb';

  const client = getSorobanClient();

  try {
    const result = await client.getTransaction(txHash);

    console.log('STATUS:', result.status);
    console.log('LEDGER:', result.ledger);
    console.log('LATEST LEDGER:', result.latestLedger);

    if ('latestLedgerCloseTime' in result) {
      console.log('LATEST LEDGER CLOSE TIME:', result.latestLedgerCloseTime);
    }

    console.log('FULL RESULT KEYS:', Object.keys(result));
  } catch (error) {
    console.error(error);
  }
}

main().finally(() => process.exit(0));

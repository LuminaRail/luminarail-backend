import { getSorobanClient } from '../src/stellar/soroban/client.js';

async function main() {
  const txHash =
    '5016d1096dbc5ac9e9c4337e98f6a5f0660d823cae618c57eb89e33cdd0514cb';

  const client = getSorobanClient();

  console.log('Checking transaction:', txHash);

  try {
    const result = await client.getTransaction(txHash);

    console.log('RPC response:');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('RPC ERROR:');
    console.error(error);
  }
}

main().finally(() => process.exit(0));

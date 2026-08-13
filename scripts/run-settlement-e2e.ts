import { SettlementWorker } from '../src/workers/settlement.worker.js';

const orderId = 'e96ca0ac-f45d-4f2c-96b5-00a0c9064aa6';

async function main() {
  console.log('Starting settlement for order:', orderId);

  const worker = new SettlementWorker();

  const result = await worker.processSingleOrder(orderId);

  console.log('Settlement result:');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('Settlement failed:');
  console.error(error);
  process.exit(1);
});

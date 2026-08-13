import { SettlementService } from '../src/modules/settlements/settlements.service.js';

async function main() {
  const s = await SettlementService.getSettlementByOrder(
    'e96ca0ac-f45d-4f2c-96b5-00a0c9064aa6',
    undefined,
    true
  );

  console.log(JSON.stringify({
    id: s.id,
    settlementId: s.settlementId,
    status: s.status,
    source: s.source,
    destination: s.destination,
    asset: s.asset,
    amount: s.amount.toString(),
    contractAddress: s.contractAddress,
    stellarTransactionHash: s.stellarTransactionHash,
    lastError: s.lastError
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { prisma } from '../src/db/prisma.js';
import { config } from '../src/config/index.js';
import { SettlementStatus } from '@prisma/client';

async function main() {
  const orderId = 'e96ca0ac-f45d-4f2c-96b5-00a0c9064aa6';

  const settlement = await prisma.settlement.findUnique({
    where: { orderId },
  });

  if (!settlement) {
    throw new Error('Settlement not found');
  }

  const updated = await prisma.settlement.update({
    where: { id: settlement.id },
    data: {
      status: SettlementStatus.PENDING,
      source: config.stellar.signerPublicKey,
      stellarTransactionHash: null,
      stellarLedger: null,
      lastError: null,
      submittedAt: null,
      confirmedAt: null,
    },
  });

  console.log(JSON.stringify({
    settlementId: updated.settlementId,
    status: updated.status,
    source: updated.source,
    destination: updated.destination,
    asset: updated.asset,
    amount: updated.amount.toString(),
    contractAddress: updated.contractAddress,
    stellarTransactionHash: updated.stellarTransactionHash,
    lastError: updated.lastError,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

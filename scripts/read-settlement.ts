import { prisma } from '../src/db/prisma.js';

async function main() {
  const settlement = await prisma.settlement.findUnique({
    where: {
      orderId: 'e96ca0ac-f45d-4f2c-96b5-00a0c9064aa6',
    },
  });

  console.log(JSON.stringify(settlement, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

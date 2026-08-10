import { prisma } from '../../db/prisma.js';
import { NotFoundError, ForbiddenError } from '../../errors/index.js';

export class TransactionService {
  static async getUserTransactions(userId: string, limit = 50, offset = 0) {
    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where: { userId },
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
        include: { order: true, wallet: true },
      }),
      prisma.transaction.count({ where: { userId } }),
    ]);

    return { transactions, total, limit, offset };
  }

  static async getTransactionById(userId: string, txId: string, isAdmin = false) {
    const transaction = await prisma.transaction.findUnique({
      where: { id: txId },
      include: { order: true, wallet: true },
    });

    if (!transaction) {
      throw new NotFoundError('Transaction not found.');
    }

    if (!isAdmin && transaction.userId !== userId) {
      throw new ForbiddenError('Unauthorized access to this transaction.');
    }

    return transaction;
  }
}

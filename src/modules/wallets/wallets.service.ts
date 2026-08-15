import { prisma } from '../../db/prisma.js';
import { ConflictError, NotFoundError } from '../../errors/index.js';
import { AuditService } from '../audit/audit.service.js';

export interface CreateWalletDTO {
  address: string;
  label?: string;
  network?: string;
}

export class WalletService {
  static async createWallet(userId: string, dto: CreateWalletDTO, ipAddress?: string) {
    const existing = await prisma.wallet.findUnique({
      where: {
        userId_address: {
          userId,
          address: dto.address,
        },
      },
    });

    if (existing) {
      throw new ConflictError('Wallet address is already registered to this user.');
    }

    const wallet = await prisma.wallet.create({
      data: {
        userId,
        address: dto.address,
        label: dto.label || 'Main Wallet',
        network: dto.network || 'testnet',
        verified: false,
      },
    });

    await AuditService.log({
      userId,
      action: 'WALLET_ADDED',
      resource: 'Wallet',
      resourceId: wallet.id,
      details: { address: wallet.address, network: wallet.network, label: wallet.label },
      ipAddress,
    });

    return wallet;
  }

  static async listUserWallets(userId: string) {
    return prisma.wallet.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async deleteWallet(userId: string, walletId: string, ipAddress?: string) {
    const wallet = await prisma.wallet.findFirst({
      where: { id: walletId, userId },
    });

    if (!wallet) {
      throw new NotFoundError('Wallet not found or access denied.');
    }

    await prisma.wallet.delete({
      where: { id: walletId },
    });

    await AuditService.log({
      userId,
      action: 'WALLET_REMOVED',
      resource: 'Wallet',
      resourceId: walletId,
      details: { address: wallet.address },
      ipAddress,
    });

    return { id: walletId, deleted: true };
  }
}

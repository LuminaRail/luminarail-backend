import { prisma } from '../../db/prisma.js';
import { NotFoundError } from '../../errors/index.js';

export class UserService {
  static async getUserProfile(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        isKycVerified: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new NotFoundError('User profile not found.');
    }

    return user;
  }
}

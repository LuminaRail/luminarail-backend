import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { config } from '../../config/index.js';
import { ConflictError, UnauthorizedError } from '../../errors/index.js';
import { AuditService } from '../audit/audit.service.js';

export interface RegisterDTO {
  email: string;
  password: string;
  phone?: string;
  role?: Role;
}

export interface LoginDTO {
  email: string;
  password: string;
}

export class AuthService {
  static async register(dto: RegisterDTO, ipAddress?: string) {
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: dto.email.toLowerCase() },
          ...(dto.phone ? [{ phone: dto.phone }] : []),
        ],
      },
    });

    if (existingUser) {
      throw new ConflictError('User with this email or phone already exists.');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        passwordHash,
        phone: dto.phone,
        role: dto.role || Role.USER,
        status: 'ACTIVE',
      },
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

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, status: user.status },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn as jwt.SignOptions['expiresIn'] }
    );

    await AuditService.log({
      actor: user.email,
      userId: user.id,
      action: 'USER_REGISTERED',
      resource: 'User',
      resourceId: user.id,
      ipAddress,
    });

    return { user, token };
  }

  static async login(dto: LoginDTO, ipAddress?: string) {
    const user = await prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedError('Invalid email or password.');
    }

    const isValidPassword = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isValidPassword) {
      throw new UnauthorizedError('Invalid email or password.');
    }

    if (user.status === 'SUSPENDED') {
      throw new UnauthorizedError('Account is suspended.');
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, status: user.status },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn as jwt.SignOptions['expiresIn'] }
    );

    await AuditService.log({
      actor: user.email,
      userId: user.id,
      action: 'USER_LOGIN',
      resource: 'User',
      resourceId: user.id,
      ipAddress,
    });

    const { passwordHash, ...userWithoutPassword } = user;
    return { user: userWithoutPassword, token };
  }
}

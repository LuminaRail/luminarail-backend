import { Role, UserStatus } from '@prisma/client';

export interface AuthUserPayload {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUserPayload;
    }
  }
}

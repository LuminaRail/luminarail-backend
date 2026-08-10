export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly details?: unknown;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode = 500, errorCode = 'INTERNAL_SERVER_ERROR', details?: unknown, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) {
    super(message, 400, 'BAD_REQUEST', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource conflict') {
    super(message, 409, 'CONFLICT');
  }
}

export class StellarError extends AppError {
  constructor(message = 'Stellar integration error', statusCode = 500, errorCode = 'STELLAR_ERROR', details?: unknown) {
    super(message, statusCode, errorCode, details);
  }
}

export class StellarAccountNotFoundError extends StellarError {
  constructor(address: string) {
    super(`Stellar account not found: ${address}`, 404, 'STELLAR_ACCOUNT_NOT_FOUND');
  }
}

export class StellarTransactionNotFoundError extends StellarError {
  constructor(hash: string) {
    super(`Stellar transaction not found: ${hash}`, 404, 'STELLAR_TRANSACTION_NOT_FOUND');
  }
}

export class StellarNetworkError extends StellarError {
  constructor(message = 'Failed to communicate with Stellar network', details?: unknown) {
    super(message, 502, 'STELLAR_NETWORK_ERROR', details);
  }
}

export class StellarInvalidAddressError extends StellarError {
  constructor(message = 'Invalid Stellar public address') {
    super(message, 400, 'STELLAR_INVALID_ADDRESS');
  }
}

export class StellarInvalidAssetError extends StellarError {
  constructor(message = 'Invalid Stellar asset identifier') {
    super(message, 400, 'STELLAR_INVALID_ASSET');
  }
}

export class StellarRpcError extends StellarError {
  constructor(message = 'Stellar RPC operation failed', details?: unknown) {
    super(message, 502, 'STELLAR_RPC_ERROR', details);
  }
}

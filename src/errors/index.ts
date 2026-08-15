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

export class PaymentError extends AppError {
  constructor(message = 'Payment error', statusCode = 400, errorCode = 'PAYMENT_ERROR', details?: unknown) {
    super(message, statusCode, errorCode, details);
  }
}

export class PaymentNotFoundError extends PaymentError {
  constructor(paymentId: string) {
    super(`Payment not found: ${paymentId}`, 404, 'PAYMENT_NOT_FOUND');
  }
}

export class InvalidPaymentStateError extends PaymentError {
  constructor(message = 'Invalid payment state transition') {
    super(message, 400, 'INVALID_PAYMENT_STATE');
  }
}

export class DuplicatePaymentError extends PaymentError {
  constructor(message = 'Duplicate payment request detected') {
    super(message, 409, 'DUPLICATE_PAYMENT');
  }
}

export class WebhookVerificationError extends PaymentError {
  constructor(message = 'Webhook signature verification failed') {
    super(message, 400, 'WEBHOOK_VERIFICATION_FAILED');
  }
}

export class ProviderError extends PaymentError {
  constructor(message = 'Payment provider error', statusCode = 502, errorCode = 'PROVIDER_ERROR', details?: unknown) {
    super(message, statusCode, errorCode, details);
  }
}

export class SettlementError extends AppError {
  constructor(message = 'Settlement error', statusCode = 400, errorCode = 'SETTLEMENT_ERROR', details?: unknown) {
    super(message, statusCode, errorCode, details);
  }
}

export class SettlementNotFoundError extends SettlementError {
  constructor(identifier: string) {
    super(`Settlement not found: ${identifier}`, 404, 'SETTLEMENT_NOT_FOUND');
  }
}

export class InvalidSettlementStateError extends SettlementError {
  constructor(message = 'Invalid settlement state transition') {
    super(message, 400, 'INVALID_SETTLEMENT_STATE');
  }
}

export class DuplicateSettlementError extends SettlementError {
  constructor(message = 'Duplicate settlement detected for order') {
    super(message, 409, 'DUPLICATE_SETTLEMENT');
  }
}

export class InvalidOrderStateForSettlementError extends SettlementError {
  constructor(status: string) {
    super(`Order status '${status}' is invalid for settlement creation. Must be SETTLEMENT_PENDING.`, 400, 'INVALID_ORDER_STATE_FOR_SETTLEMENT');
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

export class SorobanSimulationError extends StellarError {
  constructor(message = 'Soroban transaction simulation failed', details?: unknown) {
    super(message, 400, 'SOROBAN_SIMULATION_FAILED', details);
  }
}

export class SorobanSubmissionError extends StellarError {
  constructor(message = 'Soroban transaction submission failed', details?: unknown) {
    super(message, 502, 'SOROBAN_SUBMISSION_FAILED', details);
  }
}

export class SorobanConfirmationError extends StellarError {
  constructor(message = 'Soroban transaction confirmation failed or timed out', details?: unknown) {
    super(message, 504, 'SOROBAN_CONFIRMATION_FAILED', details);
  }
}

export class SorobanSignerConfigError extends StellarError {
  constructor(message = 'Stellar settlement signer configuration missing or invalid') {
    super(message, 500, 'SOROBAN_SIGNER_CONFIG_ERROR');
  }
}

export class SorobanContractConfigError extends StellarError {
  constructor(message = 'Soroban contract ID configuration missing or invalid') {
    super(message, 500, 'SOROBAN_CONTRACT_CONFIG_ERROR');
  }
}

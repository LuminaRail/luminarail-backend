import { describe, it, expect } from 'vitest';
import { getStellarTransactionService } from '../../src/stellar/transactions/transaction.service.js';

describe('Stellar Transaction Service & Hash Validation', () => {
  const txService = getStellarTransactionService();
  const validTxHash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

  it('should validate 64-character hex transaction hashes', () => {
    expect(txService.validateHash(validTxHash)).toBe(true);
  });

  it('should reject invalid or short transaction hashes', () => {
    expect(txService.validateHash('short_hash')).toBe(false);
    expect(txService.validateHash('zzzzc3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90')).toBe(false);
  });
});

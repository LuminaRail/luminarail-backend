import { describe, it, expect } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { getStellarAccountService } from '../../src/stellar/accounts/account.service.js';
import { StellarInvalidAddressError } from '../../src/errors/index.js';

describe('Stellar Account Service & Address Validation', () => {
  const accountService = getStellarAccountService();
  const validKeypair = Keypair.random();

  it('should validate valid Ed25519 Stellar public key', () => {
    const isValid = accountService.validateAddress(validKeypair.publicKey());
    expect(isValid).toBe(true);
  });

  it('should reject malformed or non-Stellar addresses', () => {
    const isValid = accountService.validateAddress('not_a_stellar_address_12345');
    expect(isValid).toBe(false);
  });

  it('should strictly reject secret keys and throw StellarInvalidAddressError', () => {
    const secretKey = validKeypair.secret();
    expect(() => accountService.validateAddress(secretKey)).toThrow(StellarInvalidAddressError);
  });
});

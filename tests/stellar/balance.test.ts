import { describe, it, expect } from 'vitest';
import { Keypair, Horizon } from '@stellar/stellar-sdk';
import { getStellarBalanceService } from '../../src/stellar/balances/balance.service.js';

describe('Stellar Balance Service & String Precision', () => {
  const balanceService = getStellarBalanceService();
  const issuerKeypair = Keypair.random();

  it('should normalize Horizon balance lines with exact string precision', () => {
    const rawBalances: Horizon.ServerApi.BalanceLine[] = [
      {
        asset_type: 'native',
        balance: '1234.5678901',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: issuerKeypair.publicKey(),
        balance: '500.2500000',
        limit: '10000.0000000',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
        is_authorized: true,
        is_authorized_to_maintain_liabilities: true,
        last_modified_ledger: 100,
      },
    ];

    const normalized = balanceService.normalizeBalances(rawBalances);

    expect(normalized).toHaveLength(2);

    expect(normalized[0].assetType).toBe('native');
    expect(normalized[0].assetCode).toBe('XLM');
    expect(normalized[0].assetIssuer).toBeNull();
    expect(typeof normalized[0].balance).toBe('string');
    expect(normalized[0].balance).toBe('1234.5678901');

    expect(normalized[1].assetType).toBe('credit_alphanum4');
    expect(normalized[1].assetCode).toBe('USDC');
    expect(normalized[1].assetIssuer).toBe(issuerKeypair.publicKey());
    expect(typeof normalized[1].balance).toBe('string');
    expect(normalized[1].balance).toBe('500.2500000');
  });
});

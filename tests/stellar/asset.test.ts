import { describe, it, expect } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { getStellarAssetService } from '../../src/stellar/assets/asset.service.js';
import { stellarConfig } from '../../src/stellar/config/index.js';
import { StellarInvalidAssetError } from '../../src/errors/index.js';

describe('Stellar Asset Service & Normalization', () => {
  const assetService = getStellarAssetService();
  const issuerKeypair = Keypair.random();

  it('should normalize native XLM asset correctly', () => {
    const asset = assetService.normalizeAsset('XLM');
    expect(asset.type).toBe('native');
    expect(asset.code).toBe('XLM');
    expect(asset.issuer).toBeNull();
  });

  it('should normalize valid credit_alphanum4 asset correctly', () => {
    const asset = assetService.normalizeAsset('USDC', issuerKeypair.publicKey());
    expect(asset.type).toBe('credit_alphanum4');
    expect(asset.code).toBe('USDC');
    expect(asset.issuer).toBe(issuerKeypair.publicKey());
  });

  it('should normalize valid credit_alphanum12 asset correctly', () => {
    const asset = assetService.normalizeAsset('LONGASSET', issuerKeypair.publicKey());
    expect(asset.type).toBe('credit_alphanum12');
    expect(asset.code).toBe('LONGASSET');
    expect(asset.issuer).toBe(issuerKeypair.publicKey());
  });

  it('should throw StellarInvalidAssetError for missing or invalid issuer on credit asset', () => {
    expect(() => assetService.normalizeAsset('USDC', null)).toThrow(StellarInvalidAssetError);
    expect(() => assetService.normalizeAsset('USDC', 'invalid_issuer')).toThrow(StellarInvalidAssetError);
  });

  it('should verify correct code + issuer is allowlisted', () => {
    expect(assetService.isAllowlistedAsset('XLM')).toBe(true);
    expect(assetService.isAllowlistedAsset('USDC', stellarConfig.usdcIssuer)).toBe(true);
  });

  it('should reject same asset code with a different issuer', () => {
    const differentIssuer = Keypair.random().publicKey();
    expect(assetService.isAllowlistedAsset('USDC', differentIssuer)).toBe(false);
  });

  it('should reject USDC without issuer', () => {
    expect(assetService.isAllowlistedAsset('USDC', null)).toBe(false);
    expect(assetService.isAllowlistedAsset('USDC')).toBe(false);
  });

  it('should reject unknown asset codes even with valid issuer', () => {
    expect(assetService.isAllowlistedAsset('UNKNOWN_ASSET', issuerKeypair.publicKey())).toBe(false);
  });
});

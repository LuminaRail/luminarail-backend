import { Asset, StrKey } from '@stellar/stellar-sdk';
import { stellarConfig } from '../config/index.js';
import { StellarInvalidAssetError } from '../../errors/index.js';

export interface NormalizedAsset {
  type: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
  code: string;
  issuer: string | null;
  network: string;
}

export class StellarAssetService {
  public validateAssetIdentifier(code: string, issuer?: string | null): boolean {
    if (!code || typeof code !== 'string') {
      return false;
    }
    const cleanCode = code.toUpperCase().trim();
    if (cleanCode === 'XLM' || cleanCode === 'NATIVE') {
      return true;
    }
    if (cleanCode.length < 1 || cleanCode.length > 12) {
      return false;
    }
    if (!issuer || !StrKey.isValidEd25519PublicKey(issuer)) {
      return false;
    }
    return true;
  }

  public normalizeAsset(code: string, issuer?: string | null): NormalizedAsset {
    const cleanCode = (code || '').toUpperCase().trim();
    if (cleanCode === 'XLM' || cleanCode === 'NATIVE') {
      return {
        type: 'native',
        code: 'XLM',
        issuer: null,
        network: stellarConfig.network,
      };
    }

    if (!this.validateAssetIdentifier(cleanCode, issuer)) {
      throw new StellarInvalidAssetError(
        `Invalid Stellar asset representation. Code: '${code}', Issuer: '${issuer || 'none'}'`
      );
    }

    const type = cleanCode.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12';

    return {
      type,
      code: cleanCode,
      issuer: issuer!,
      network: stellarConfig.network,
    };
  }

  public toStellarSdkAsset(code: string, issuer?: string | null): Asset {
    const normalized = this.normalizeAsset(code, issuer);
    if (normalized.type === 'native') {
      return Asset.native();
    }
    return new Asset(normalized.code, normalized.issuer!);
  }

  public isAllowlistedAsset(code: string, issuer?: string | null): boolean {
    try {
      const normalized = this.normalizeAsset(code, issuer);
      if (normalized.type === 'native') {
        return true;
      }
      if (
        normalized.code === 'USDC' &&
        normalized.issuer === stellarConfig.usdcIssuer
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  public getKnownAssets(): NormalizedAsset[] {
    return [
      {
        type: 'native',
        code: 'XLM',
        issuer: null,
        network: stellarConfig.network,
      },
      {
        type: 'credit_alphanum4',
        code: 'USDC',
        issuer: stellarConfig.usdcIssuer,
        network: stellarConfig.network,
      },
    ];
  }
}

let assetServiceInstance: StellarAssetService | null = null;

export function getStellarAssetService(): StellarAssetService {
  if (!assetServiceInstance) {
    assetServiceInstance = new StellarAssetService();
  }
  return assetServiceInstance;
}

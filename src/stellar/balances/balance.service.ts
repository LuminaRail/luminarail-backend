import { Horizon } from '@stellar/stellar-sdk';
import { getStellarAssetService } from '../assets/asset.service.js';

export interface NormalizedStellarBalance {
  assetType: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
  assetCode: string;
  assetIssuer: string | null;
  balance: string;
  limit?: string;
  buyingLiabilities?: string;
  sellingLiabilities?: string;
}

export class StellarBalanceService {
  public normalizeBalances(
    horizonBalances: Horizon.HorizonApi.BalanceLine[]
  ): NormalizedStellarBalance[] {
    const assetService = getStellarAssetService();

    return horizonBalances.map((b) => {
      if (b.asset_type === 'native') {
        const normalizedAsset = assetService.normalizeAsset('XLM', null);
        const nativeLine = b as Horizon.HorizonApi.BalanceLineNative;
        return {
          assetType: normalizedAsset.type,
          assetCode: normalizedAsset.code,
          assetIssuer: null,
          balance: String(nativeLine.balance),
          buyingLiabilities: nativeLine.buying_liabilities,
          sellingLiabilities: nativeLine.selling_liabilities,
        };
      }

      if (b.asset_type === 'credit_alphanum4' || b.asset_type === 'credit_alphanum12') {
        const assetLine = b as Horizon.HorizonApi.BalanceLineAsset;
        const normalizedAsset = assetService.normalizeAsset(
          assetLine.asset_code,
          assetLine.asset_issuer
        );

        return {
          assetType: normalizedAsset.type,
          assetCode: normalizedAsset.code,
          assetIssuer: normalizedAsset.issuer,
          balance: String(assetLine.balance),
          limit: assetLine.limit,
          buyingLiabilities: assetLine.buying_liabilities,
          sellingLiabilities: assetLine.selling_liabilities,
        };
      }

      return {
        assetType: 'credit_alphanum4',
        assetCode: 'UNKNOWN',
        assetIssuer: null,
        balance: String(b.balance),
      };
    });
  }
}

let balanceServiceInstance: StellarBalanceService | null = null;

export function getStellarBalanceService(): StellarBalanceService {
  if (!balanceServiceInstance) {
    balanceServiceInstance = new StellarBalanceService();
  }
  return balanceServiceInstance;
}

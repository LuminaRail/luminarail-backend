import { Asset } from '@stellar/stellar-sdk';
import { config } from '../../config/index.js';

export const STELLAR_ASSETS = {
  NATIVE: Asset.native(),
  USDC: new Asset('USDC', config.stellar.usdcIssuer),
};

import { Horizon, rpc } from '@stellar/stellar-sdk';
import { config } from '../../config/index.js';

export function getHorizonServer(): Horizon.Server {
  return new Horizon.Server(config.stellar.horizonUrl);
}

export function getSorobanRpcServer(): rpc.Server {
  return new rpc.Server(config.stellar.rpcUrl);
}

import fs from 'fs';
import { Keypair } from '@stellar/stellar-sdk';

const env = fs.readFileSync('.env', 'utf8');

const line = env
  .split('\n')
  .find((line) => line.startsWith('STELLAR_SETTLEMENT_SIGNER_SECRET_KEY='));

if (!line) {
  console.log('Signer secret missing');
  process.exit(0);
}

const secret = line
  .slice('STELLAR_SETTLEMENT_SIGNER_SECRET_KEY='.length)
  .trim();

const keypair = Keypair.fromSecret(secret);

const contractAdmin =
  'GA2DPTRRZUNIGWKAO6ZR5YA3J5DKT3W3O3TXMEYJJVG6S5O4E7OIT6XV';

console.log('Secret corresponds to public key:', keypair.publicKey());
console.log('Matches contract admin:', keypair.publicKey() === contractAdmin);

import { Keypair } from '@stellar/stellar-sdk';

const admin = 'GA2DPTRRZUNIGWKAO6ZR5YA3J5DKT3W3O3TXMEYJJVG6S5O4E7OIT6XV';

console.log('Expected contract admin:');
console.log(admin);

console.log('\nConfigured backend signer:');
console.log(process.env.STELLAR_SETTLEMENT_SIGNER_PUBLIC_KEY || 'not loaded');

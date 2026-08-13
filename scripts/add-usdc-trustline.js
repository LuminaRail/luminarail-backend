import {
  Keypair,
  Horizon,
  Networks,
  TransactionBuilder,
  Operation,
  Asset,
} from '@stellar/stellar-sdk';

const horizon = new Horizon.Server(
  'https://horizon-testnet.stellar.org'
);

// Read the signer secret from the environment.
// Do NOT put the secret key directly in this file.
const secret = process.env.STELLAR_SIGNER_SECRET;

if (!secret) {
  throw new Error('STELLAR_SIGNER_SECRET is not set');
}

const keypair = Keypair.fromSecret(secret);
const publicKey = keypair.publicKey();

const issuer = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const usdc = new Asset('USDC', issuer);

console.log('Signer:', publicKey);
console.log('Creating USDC trustline...');

const account = await horizon.loadAccount(publicKey);

const transaction = new TransactionBuilder(account, {
  fee: '100000',
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(
    Operation.changeTrust({
      asset: usdc,
    })
  )
  .setTimeout(30)
  .build();

transaction.sign(keypair);

const result = await horizon.submitTransaction(transaction);

console.log('Trustline created successfully!');
console.log('Transaction:', result.hash);

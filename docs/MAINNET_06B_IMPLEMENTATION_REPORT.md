# MAINNET-06B — SECURE SIGNER & KMS INTEGRATION IMPLEMENTATION REPORT

**Phase**: MAINNET-06B / Phase 6B — Secure Signer & KMS Integration  
**Repository**: `luminarail-backend`  
**Current HEAD**: `3744bf6529323eb2e5d7ad836cb56efbe8b81ee0`  
**Implementation Verdict**: **SUCCESSFULLY IMPLEMENTED — ALL TESTS & SAFETY GUARDS VERIFIED**  
**Production Activation Status**: **NOT ACTIVATED (Mainnet settlement remains disabled)**  

---

## 1. ARCHITECTURE SUMMARY

The **MAINNET-06B** implementation introduces institutional hardware key custody for LuminaRail's hot treasury settlement signer using **AWS KMS** (`KeySpec: ECC_ED25519`).

### Core Architectural Invariants:
1. **Zero Private Key Invariant**: Private keys reside exclusively inside AWS KMS Hardware Security Modules (FIPS 140-3 Level 3) and are non-exportable. No secret key seed (`S...`) or private key material ever enters LuminaRail backend container memory or environment variables when `STELLAR_SIGNER_PROVIDER = aws_kms`.
2. **Policy Boundary Gating**: `KmsTransactionSigner` is strictly gated behind `SettlementPolicyEngine.validateAndApprove()`. The signer CANNOT be reached or invoked without prior policy authorization.
3. **Exact Digest Signing**: AWS KMS `SignCommand` receives `Message = transaction.hash()` (raw 32-byte SHA-256 Buffer) with `SigningAlgorithm = 'ED25519'` and `MessageType = 'RAW'`. No additional hashing or encoding is applied.
4. **Local Cryptographic Signature Verification**: Every 64-byte Ed25519 signature returned by AWS KMS is cryptographically verified locally (`Keypair.fromPublicKey(pubKey).verify(txHash, signature)`) before assembling the Stellar `xdr.DecoratedSignature`.
5. **Fail-Closed Readiness Guard**: Application startup verifies KMS public key format, network passphrase, and on-chain account matching. Any mismatch halts initialization.

### 7. KEY ROTATION READINESS

The system architecture supports future controlled key rotation:
1. Add new KMS key public address to Stellar hot treasury account on-chain as a secondary signer (`SetOptions`).
2. Update application configuration (`STELLAR_KMS_KEY_ARN`, `STELLAR_SETTLEMENT_SIGNER_PUBLIC_KEY`).
3. Deploy application.
4. Revoke old key weight on-chain after in-flight transactions settle.

---

## 2. EXACT SIGNING FLOW

```
[Settlement Trigger] 
       │
       ▼
[SorobanTxService.buildUnsignedSettlementTransaction()]
       │
       ▼
[KmsTransactionSigner.signTransaction(request)]
       │
       ├─► [1. SettlementPolicyEngine.validateAndApprove(request)]
       │       ├─ Global Pause Check
       │       ├─ Contract & Method Allowlist (create_settlement)
       │       ├─ Order, Payment, Reservation & Refund DB Checks
       │       └─ Single & Cumulative Outflow Limits
       │       (If rejected: Throws SorobanSubmissionError; KMS SIGN NEVER CALLED)
       │
       ├─► [2. Parse Unsigned XDR & Extract tx.hash()]
       │       └─ txHash = tx.hash() (Assert length == 32 bytes)
       │
       ├─► [3. Invoke AWS KMS Hardware Signing]
       │       └─ kmsClient.send(SignCommand({
       │            KeyId: kmsKeyArn,
       │            Message: txHash, (32 bytes Buffer)
       │            MessageType: 'RAW',
       │            SigningAlgorithm: 'ED25519'
       │          }))
       │
       ├─► [4. Validate & Verify Returned Signature]
       │       ├─ Assert signature.length == 64 bytes
       │       └─ Assert Keypair.fromPublicKey(pubKey).verify(txHash, sig) == true
       │
       ├─► [5. Assemble Stellar Envelope]
       │       └─ tx.signatures.push(new xdr.DecoratedSignature({ hint, signature }))
       │
       └─► [6. Audit Trail Logging (Redacted)]
```

---

## 3. COMPONENT IMPLEMENTATION & FILES MODIFIED

### 1. `package.json`
* Added `@aws-sdk/client-kms` (`^3.750.0`) dependency.

### 2. `src/config/index.ts`
* Added Zod schema fields:
  - `STELLAR_SIGNER_PROVIDER`: `z.enum(['testnet_local', 'aws_kms', 'gcp_kms', 'fireblocks']).default('testnet_local')`
  - `AWS_REGION`: `z.string().optional().default('us-east-1')`
  - `STELLAR_KMS_KEY_ARN`: `z.string().optional().default('')`
  - `AWS_KMS_SIGNING_KEY_ID`: `z.string().optional().default('')`
* Added Zod refinement enforcing `STELLAR_KMS_KEY_ARN` presence when `STELLAR_SIGNER_PROVIDER === 'aws_kms'`.

### 3. `src/stellar/signer/types.ts`
* Enhanced `SignerIdentity` to include `expectedSourceAccount`.
* Added `SignerHealthResult` type for read-only health checks.

### 4. `src/stellar/signer/signer.interface.ts`
* Extended `ITransactionSigner` interface with:
  - `healthCheck(): Promise<SignerHealthResult>`
  - `verifyReadiness(expectedPublicKey?: string, expectedNetworkPassphrase?: string): Promise<void>`

### 5. `src/stellar/signer/kms-transaction.signer.ts` [NEW]
* Implemented `KmsTransactionSigner`:
  - Accepts dependency-injected `KMSClient` (for mock testing) or instantiates standard client.
  - Implements DER SPKI 32-byte public key extraction from `GetPublicKeyCommand`.
  - Implements `getIdentity()`, `verifyReadiness()`, `healthCheck()`, and `signTransaction()`.
  - Enforces 64-byte signature assertion and local cryptographic verification.
  - Fail-closed error handling for KMS timeouts, throttling, invalid signature length, or public key mismatch.

### 6. `src/stellar/signer/testnet-local.signer.ts`
* Updated `TestnetLocalSigner` to implement `healthCheck()` and `verifyReadiness()`.
* Updated `resolveTransactionSigner()` to instantiate `KmsTransactionSigner` when `STELLAR_SIGNER_PROVIDER === 'aws_kms'`.

### 7. `src/stellar/signer/index.ts` [NEW]
* Created signer module barrel re-exporting signer types, interfaces, and implementations.

### 8. `src/stellar/soroban/transaction.service.ts`
* Updated imports to consume signer module barrel.

### 9. `tests/stellar/kms-signer.test.ts` [NEW]
* Added 19 comprehensive unit tests covering points A through X (exact `tx.hash()` verification, RAW MessageType, ED25519 algorithm, 64-byte length assertion, policy boundary gating, error handling, readiness checks, and no-key-leakage assertions).

---

## 4. SECURITY & POLICY BOUNDARY AUDIT

1. **Policy Gate Assertion**: Tested and verified that if `SettlementPolicyEngine` rejects a settlement request, `KMSClient.send(SignCommand)` is **NEVER** called.
2. **No Arbitrary XDR Oracle**: No HTTP endpoint exists allowing external callers to submit arbitrary XDR for signing. Signer is internal to `SorobanTransactionService`.
3. **No Private Key In Memory**: `KmsTransactionSigner` holds zero private key fields (`secretKey`, `privateKey`, `seed`, `keypair` are all `undefined`).
4. **Log Redaction**: Audit logs record `transactionHash`, `settlementId`, `signerPublicKey`, and `providerType`. Raw signatures, secret seeds, and AWS credentials are never logged.

---

## 5. TEST & REGRESSION VERIFICATION RESULTS

* **Unit & Integration Test Suite**: `npm test` — **38 test files passed / 279 tests passed (0 failed)**
* **TypeScript Compilation**: `npm run type-check` — **0 errors**
* **ESLint Verification**: `npm run lint` — **0 warnings / 0 errors**
* **Production Build**: `npm run build` — **Clean compilation**

---

## 6. PRODUCTION ACTIVATION PREREQUISITES

> [!IMPORTANT]
> **MAINNET-06B implementation does NOT activate production settlement.** `PRODUCTION_SETTLEMENT_ENABLED` remains `false`.

Before production mainnet settlement can be enabled:
1. Provision AWS KMS `ECC_ED25519` key in target production region.
2. Configure AWS IAM role with restricted `kms:Sign` and `kms:GetPublicKey` permissions.
3. Configure environment variables (`STELLAR_SIGNER_PROVIDER=aws_kms`, `STELLAR_KMS_KEY_ARN=...`, `AWS_REGION=...`, `STELLAR_SETTLEMENT_SIGNER_PUBLIC_KEY=G...`).
4. Fund hot treasury address on Stellar mainnet with initial USDC reserve.
5. Complete Phase 6C (Worker Replica Isolation & Redlock Distributed Locking).

---
*End of Implementation Report*

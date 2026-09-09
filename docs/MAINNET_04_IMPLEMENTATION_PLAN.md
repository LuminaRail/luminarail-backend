# MAINNET-04 — Treasury & Signing Architecture Implementation Plan

## Executive Summary

This document defines the final pre-implementation specification and step-by-step technical implementation plan for **MAINNET-04 — Treasury & Signing Security Architecture** in `luminarail-backend`.

The objective is to establish an enterprise-grade, policy-enforced transaction signing and treasury architecture that cleanly decouples settlement business logic from physical private key management.

> [!IMPORTANT]
> **STRICT IMPLEMENTATION BOUNDARY**:
> - **Implement Now**: Signer interface abstraction, `TestnetLocalSigner` adapter, `SettlementPolicyEngine` XDR inspection, building/signing/submission decoupling, reconciliation daemon workflows, provisional spending limit controls, audit logging, and automated tests.
> - **Deferred to Future Mainnet Production Phase**: Production AWS/GCP KMS SDK integration, Fireblocks SDK integration, real mainnet wallet provisioning, real mainnet USDC funding, and mainnet contract deployment.

---

## 1. Final System Architecture & Component Model

The system isolates transaction construction, policy authorization, transaction signing, and network submission into four single-responsibility modules:

```
┌─────────────────────────┐
│     SettlementWorker    │  (Orchestrates background settlement sweeps)
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│   TransactionBuilder    │  (Constructs unsigned Stellar XDR via Soroban RPC simulation)
└────────────┬────────────┘
             │  Unsigned XDR + Context
             ▼
┌─────────────────────────┐
│ SettlementPolicyEngine  │  (Parses XDR & validates 9 security assertions against DB)
└────────────┬────────────┘
             │  Approved Request
             ▼
┌─────────────────────────┐
│   ITransactionSigner    │  (Signs approved XDR: TestnetLocalSigner for dev)
└────────────┬────────────┘
             │  Signed XDR
             ▼
┌─────────────────────────┐
│ StellarSubmitterService │  (Broadcasts signed XDR to Soroban RPC)
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  ConfirmationService    │  (Polls RPC finality & triggers DB reconciliation)
└─────────────────────────┘
```

---

## 2. Trust Boundaries & Security Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ TRUST BOUNDARY 1: APPLICATION & WORKER LAYER (Untrusted Payload Creation)   │
│ - Constructs transaction XDR based on DB order parameters.                   │
│ - MUST NOT have direct access to signing keys.                              │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ TRUST BOUNDARY 2: POLICY ENGINE GATEKEEPER (Authoritative Validation)       │
│ - Re-queries database independently.                                        │
│ - Decompiles unsigned XDR and inspects contract host function parameters.   │
│ - Enforces spending caps, contract whitelist, and account bindings.         │
│ - Rejects invalid, tampered, or arbitrary XDR payloads.                     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ TRUST BOUNDARY 3: SIGNER ENGINE (Cryptographic Execution)                  │
│ - Receives validated, policy-approved XDR envelopes only.                   │
│ - Dev/Testnet: Uses TestnetLocalSigner (in-memory test key).                │
│ - Production: Delegated to AWS KMS / HSM via IAM authentication.            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Signer Interface Design (`ITransactionSigner`)

To ensure the application cannot execute a naive `sign(rawXdr)` without policy context, the interface requires an envelope containing both the unsigned XDR and the authoritative `AuthorizationPolicyContext`:

```typescript
export interface SignerIdentity {
  publicKey: string;
  keyId: string;
  providerType: 'TESTNET_LOCAL' | 'AWS_KMS' | 'GCP_KMS' | 'FIREBLOCKS';
  networkPassphrase: string;
}

export interface AuthorizationPolicyContext {
  settlementId: string;
  orderId: string;
  liquidityReservationId: string;
  expectedSource: string;
  expectedDestination: string;
  expectedAmountStroops: bigint;
  expectedAssetContract: string;
  expectedVaultContract: string;
}

export interface SignTransactionRequest {
  unsignedTransactionXdr: string;
  context: AuthorizationPolicyContext;
}

export interface SignTransactionResponse {
  signedTransactionXdr: string;
  transactionHash: string;
  signerPublicKey: string;
  signedAt: Date;
  auditMetadata: {
    signerId: string;
    algorithm: string;
    keyArn?: string;
  };
}

export interface ITransactionSigner {
  getIdentity(): Promise<SignerIdentity>;
  signTransaction(request: SignTransactionRequest): Promise<SignTransactionResponse>;
}
```

---

## 4. Transaction Authorization Design (`SettlementPolicyEngine`)

The `SettlementPolicyEngine` decompiles the unsigned XDR using `@stellar/stellar-sdk` and inspects its operations before signature generation.

```typescript
export interface ISettlementPolicyEngine {
  validateAndApprove(request: SignTransactionRequest): Promise<void>;
}
```

### Mandatory Policy Validation Steps
1. **XDR Decompilation**: Decodes `unsignedTransactionXdr` into a Stellar `Transaction` object using `TransactionBuilder.fromXDR()`.
2. **Network Passphrase Check**: Asserts `transaction.networkPassphrase === config.stellar.networkPassphrase`.
3. **Operation Type Assertion**: Verifies operation is a single Soroban `InvokeHostFunction` operation.
4. **Contract Address Whitelist**: Confirms target contract ID equals `config.stellar.settlementVaultContractId`.
5. **Function Name Match**: Verifies contract function name is strictly `create_settlement`.
6. **Argument Extraction & Database Cross-Check**:
   - `settlement_id` (u64): Matches `parseSettlementIdToU64(context.settlementId)`.
   - `source` (Address): Matches expected Hot Treasury address (`config.stellar.signerPublicKey`).
   - `destination` (Address): Matches `Order.walletAddress` fetched directly from DB by `orderId`.
   - `asset` (Address): Matches `config.stellar.usdcContractId`.
   - `amount` (i128 stroops): Matches `Order.destinationAmount` converted to stroops.
7. **DB State Verification**: Re-queries DB to confirm `Order.status === SETTLEMENT_PENDING`, `Payment.status === SUCCEEDED`, and `LiquidityReservation.status === CONFIRMED`.
8. **Spending Limit Enforcement**: Verifies amount is within single transaction limits and rolling daily caps.
9. **Age Verification**: Asserts settlement was created within the last 24 hours (`createdAt >= now - 24h`).

---

## 5. Replay Protection & Duplicate Settlement Prevention

The architecture guarantees idempotency across all lifecycle stages:

- **Duplicate Order**: Guarded by `Idempotency-Key` header & DB unique index on `Order.idempotencyKey`.
- **Duplicate Reservation**: Guarded by PostgreSQL `SELECT FOR UPDATE` row lock & `@unique` on `LiquidityReservation.orderId`.
- **Duplicate Settlement Record**: Guarded by `@unique` on `Settlement.orderId` with Prisma `P2002` exception handling.
- **Duplicate Signing & Submission**: Policy engine checks if `Settlement` already has `stellarTransactionHash` or status `SUBMITTED`/`COMPLETED`.
- **Worker Crash After Signing But Before Submission**:
  - `Settlement.status` is `SUBMITTING`; `stellarTransactionHash` is null.
  - Recovery worker queries RPC with transaction hash (if hash generated) and checks signer account sequence.
  - If transaction was NOT submitted: sequence number is unchanged. Worker resets status to `PENDING` for clean re-preparation.
  - If transaction WAS submitted: RPC returns status, worker records `stellarTransactionHash`, updates status to `SUBMITTED`, avoiding double payout.

---

## 6. Failure Mode & Reconciliation Matrix

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Scenario A: DB Pending / Submitting + Chain SUCCESS                         │
│ -> Reconciliation Daemon detects SUCCESS on RPC via txHash.                 │
│ -> Updates Settlement -> COMPLETED, Order -> COMPLETED, consumes reservation.│
├─────────────────────────────────────────────────────────────────────────────┤
│ Scenario B: DB Pending / Submitting + Chain FAILED                          │
│ -> Reconciliation Daemon detects FAILED on RPC.                             │
│ -> Updates Settlement -> FAILED, releases reservation, updates Order -> FAILED.│
├─────────────────────────────────────────────────────────────────────────────┤
│ Scenario C: RPC Timeout + Unknown Chain Result                              │
│ -> Marked REQUIRES_RECONCILIATION. Re-submission BLOCKED.                   │
│ -> Daemon polls RPC with exponential backoff up to 24h before resolving.    │
├─────────────────────────────────────────────────────────────────────────────┤
│ Scenario D: Crash After Signing (Pre-Broadcast)                             │
│ -> Status SUBMITTING, no txHash. Daemon verifies sequence & unsubmitted state│
│ -> Resets status to PENDING for clean re-execution.                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ Scenario E: Crash After Submission (Pre-DB Update)                          │
│ -> Status SUBMITTED with txHash. Daemon queries RPC, finds SUCCESS, updates  │
│    Settlement -> COMPLETED. Zero double payout.                             │
├─────────────────────────────────────────────────────────────────────────────┤
│ Scenario F: DB Update Failure After Successful Chain Submission              │
│ -> Chain is source of truth. Daemon detects txHash SUCCESS on RPC, completes│
│    DB update idempotently.                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Hot / Cold Treasury Model Architecture

```
┌───────────────────────────────┐
│         Cold Treasury         │  Offline Hardware Multisig (3-of-5)
│  (Holds 90-95% Core Capital)  │  Address: G...COLD_TREASURY
└───────────────┬───────────────┘
                │ Manual / Scheduled Replenishment
                ▼
┌───────────────────────────────┐
│     Replenishment Wallet      │  Buffer Wallet (2-of-3 Multisig / Rate-Limited)
│   (Holds 5-10% Operational)   │  Address: G...REPLENISH_TREASURY
└───────────────┬───────────────┘
                │ Automated Refill when Hot Wallet < MIN_THRESHOLD
                ▼
┌───────────────────────────────┐
│     Hot Settlement Wallet     │  Automated Operational Wallet (KMS / Policy Signer)
│   (Capped Operational Float)  │  Address: G...HOT_TREASURY (~10,000 - 50,000 USDC)
└───────────────┬───────────────┘
                │ Automated Order Settlements
                ▼
┌───────────────────────────────┐
│    User Destination Wallet    │
└───────────────────────────────┘
```

---

## 8. Multi-Tiered Emergency Controls & Fail-Closed Behavior

1. **Application Layer Pause**: Setting `EMERGENCY_GLOBAL_PAUSE=true` in environment or database halts background worker sweeps immediately.
2. **Signer Policy Layer Pause**: `SettlementPolicyEngine` rejects all transaction signing requests if pause flag is active or daily volume limits are breached.
3. **Smart Contract Layer Pause**: Admin invocation of `pause()` on Soroban Vault contract freezes on-chain settlement execution.
4. **Fail-Closed Guarantee**: If any layer (DB, RPC, Policy Engine) is unresponsive or ambiguous, the system defaults to failing closed—refusing to sign or submit transactions.

---

## 9. Security Logging & Audit Policy

### Redacted Sensitive Keys
The following keys are automatically redacted in audit logs:
`password`, `password_hash`, `token`, `secret`, `api_key`, `private_key`, `seed`, `seed_phrase`.

### Safe Audit Fields
`orderId`, `settlementId`, `userId`, `amount`, `asset`, `destination`, `signerPublicKey`, `signerProvider`, `network`, `stellarTransactionHash`, `signedAt`, `status`.

---

## 10. Scope Boundaries

### IMPLEMENT NOW (MAINNET-04)
- Core `ITransactionSigner` interface and `SignerIdentity` types.
- `TestnetLocalSigner` adapter implementing `ITransactionSigner` for development/testnet environments.
- `SettlementPolicyEngine` implementing `ISettlementPolicyEngine` with full XDR parsing and 9-point security assertion checks.
- Refactoring `SorobanTransactionService` and `LiveSettlementExecutor` to separate transaction building, policy authorization, signing, and submission.
- `ReconciliationDaemon` background service for handling pending, submitted, and reconciliation-required settlements.
- Spending limits configuration structure and policy checks.
- Comprehensive test suite (unit tests for Policy Engine, Signer abstraction, Worker error recovery, and idempotency).
- Documentation updates.

### DEFER TO FUTURE PRODUCTION RELEASE PHASE
- AWS KMS SDK (`@aws-sdk/client-kms`) production integration.
- GCP KMS / Fireblocks SDK production integration.
- Mainnet wallet creation or production secret key configuration.
- Real mainnet USDC funding.
- Mainnet Soroban smart contract deployment.

---

## 11. Test Plan

1. **Policy Engine Unit Tests**:
   - Verify rejection of tampered destination address.
   - Verify rejection of tampered payout amount.
   - Verify rejection of non-whitelisted contract address.
   - Verify rejection of non-whitelisted contract function.
   - Verify rejection of wrong network passphrase.
   - Verify rejection when order status is not `SETTLEMENT_PENDING`.
   - Verify rejection when spending limits are exceeded.
2. **Signer Abstraction Unit Tests**:
   - Test `TestnetLocalSigner` identity and signing output.
   - Verify error throwing when `NODE_ENV === 'production'` and local signer is requested.
3. **Decoupled Settlement Flow Integration Tests**:
   - Test end-to-end building -> policy validation -> signing -> submission with `MockSettlementExecutor` and `TestnetLocalSigner`.
4. **Reconciliation Daemon Tests**:
   - Simulate worker crash after signing (Scenario D) and verify state reset.
   - Simulate worker crash after submission (Scenario E) and verify state recovery to `COMPLETED`.

---

## 12. Security Acceptance Criteria

- [ ] `ITransactionSigner` interface implemented and decoupled from transaction building and submission.
- [ ] `SettlementPolicyEngine` parses XDR and verifies all 9 security assertions before signing.
- [ ] No raw Ed25519 secret key resides in transaction building logic.
- [ ] `TestnetLocalSigner` blocked when `NODE_ENV === 'production'`.
- [ ] Zero secret seeds or private keys present in audit logs or stdout streams.
- [ ] All unit and integration tests pass cleanly.

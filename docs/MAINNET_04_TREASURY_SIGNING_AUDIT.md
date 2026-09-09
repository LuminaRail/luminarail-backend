# MAINNET-04 — Treasury & Signing Security Architecture Audit

## Executive Summary
This document provides a comprehensive security audit, threat model, architectural analysis, and mitigation strategy for the Treasury and Transaction-Signing Architecture of **LuminaRail** prior to MAINNET-04 production deployment. 

The primary objective is to transition LuminaRail from a monolithic testnet setup—where raw Ed25519 private keys reside directly in backend application memory—to an enterprise-grade, policy-enforced signing and treasury architecture capable of leveraging AWS KMS, GCP KMS, or institutional custody providers (e.g., Fireblocks) without modifying settlement business logic.

---

## 1. Current Architecture Trace

The current settlement lifecycle spans 14 distinct steps across quote generation, order placement, liquidity reservation, payment ingestion, background settlement execution, Soroban contract interaction, and accounting reconciliation:

```
┌──────────────┐     ┌──────────────┐     ┌───────────────────────┐     ┌───────────────────┐
│ Quote        │ ──► │ Order        │ ──► │ Liquidity             │ ──► │ Paystack Payment  │
│ Creation     │     │ Creation     │     │ Reservation (RESERVED)│     │ Webhook / Verify  │
└──────────────┘     └──────────────┘     └───────────────────────┘     └─────────┬─────────┘
                                                                                  │
┌──────────────┐     ┌──────────────┐     ┌───────────────────────┐               │
│ Order        │ ◄── │ Reservation  │ ◄── │ Order Status:         │ ◄─────────────┘
│ COMPLETED    │     │ CONSUMED     │     │ SETTLEMENT_PENDING    │
└──────▲───────┘     └──────────────┘     └─────────┬─────────────┘
       │                                            │
┌──────┴───────┐     ┌──────────────┐     ┌─────────▼─────────────┐
│ Stellar RPC  │ ◄── │ Soroban      │ ◄── │ SettlementWorker      │
│ Finality     │     │ Submission   │     │ Claim (SUBMITTING)    │
└──────────────┘     └──────────────┘     └───────────────────────┘
```

### Detailed 14-Step Flow Analysis
1. **Quote Creation** (`QuoteService.createQuote`): Client requests an NGN → USDC quote. Rates are fetched via `RealFXQuoteProvider` or `MockQuoteProvider`, calculated using `Prisma.Decimal`, verified against available pool balance (`LiquidityService.getAvailableLiquidity`), and persisted with status `ACTIVE` (TTL: 300s).
2. **Order Creation** (`OrderService.createOrder`): Client places order with `quoteId` and mandatory `Idempotency-Key`. System verifies quote freshness (`now <= expiresAt`), checks status (`ACTIVE`), and creates `Order` record (`status: CREATED`).
3. **Liquidity Reservation** (`LiquidityService.reserveForOrderInTx`): Within an atomic Prisma database transaction, the system acquires a row lock (`SELECT FOR UPDATE`) on `LiquidityPool`, verifies `availableBalance >= destinationAmount`, increments `reservedBalance`, decrements `availableBalance`, creates a `LiquidityReservation` record (`status: RESERVED`, TTL: 15 minutes), and marks quote as `USED`.
4. **Paystack Payment Confirmation** (`WebhookService` / `PaymentService`): NGN deposit is processed via Paystack. Webhook signature is validated, `eventId` is recorded in `WebhookEvent` table for deduplication, and `Payment` status transitions to `SUCCEEDED`. `LiquidityService.confirmReservation(orderId)` updates reservation to `CONFIRMED`.
5. **Settlement Eligibility**: If the order has a verified Stellar recipient address (`walletAddress`), `PaymentService` transitions order status from `PAYMENT_CONFIRMED` to `SETTLEMENT_PENDING`.
6. **Settlement Worker Sweep** (`SettlementWorker.processPendingOrders`): A background worker polls orders in `SETTLEMENT_PENDING` with valid `walletAddress` and no active completed settlement.
7. **Settlement Record Creation**: Worker calls `SettlementService.createSettlementForOrder()`. Unique constraint on `orderId` in `Settlement` table prevents concurrent duplication. Record is initialized in `PENDING` status with `settlementId` format `STL_<timestamp>_<random>`. Worker updates status to `SUBMITTING`.
8. **Stellar Transaction Construction** (`SorobanTransactionService.buildAndSubmitSettlementTransaction`): Fetches account sequence for signer address from Soroban RPC, converts `settlementId` to `u64` hash, converts USDC amount to 7-decimal stroops (`i128`), and constructs a Soroban `create_settlement` contract call transaction.
9. **Transaction Simulation**: Transaction is simulated against Soroban RPC (`sorobanClient.simulateTransaction`). Simulation footprint and gas fees are assembled into the prepared transaction.
10. **Transaction Authorization & Signing**: Authorization is implicit. `SorobanTransactionService` reads `STELLAR_SETTLEMENT_SIGNER_SECRET_KEY` from process environment configuration (`config.stellar.signerSecretKey`), creates an in-memory `Keypair.fromSecret(secretKey)`, and signs the prepared transaction (`preparedTx.sign(signerKeypair)`).
11. **Transaction Submission**: `SorobanTransactionService` submits the signed transaction directly to Soroban RPC (`sorobanClient.sendTransaction(preparedTx)`), returning the transaction hash. `SettlementService.markSubmitted` updates status to `SUBMITTED` with `stellarTransactionHash`.
12. **Stellar Confirmation Polling** (`SorobanConfirmationService.confirmTransaction`): Worker updates status to `CONFIRMING` and polls Soroban RPC `getTransaction` endpoint up to 10 attempts until `SUCCESS` or `FAILED`.
13. **Reservation Consumption & Accounting**: On RPC `SUCCESS`, `SettlementService.markCompleted()` updates settlement to `COMPLETED` and calls `LiquidityService.consumeReservation()`. The pool's `totalBalance` and `reservedBalance` are reduced by the settlement amount, `LiquidityReservation` status becomes `CONSUMED`, and a `TreasuryTransaction` (`SETTLEMENT_PAYOUT`) record is written.
14. **Order Completion**: Order status transitions to `COMPLETED`, and an audit log (`SETTLEMENT_COMPLETED`) is recorded.

---

## 2. Current Signer Implementation & Audit Findings

| Component / Aspect | Current Code Location | Implementation Detail | Audit Evaluation |
|---|---|---|---|
| **Signer Loading** | `src/config/index.ts` (L39-44)<br>`src/stellar/soroban/transaction.service.ts` (L79-85) | Reads `STELLAR_SETTLEMENT_SIGNER_SECRET_KEY` from `process.env`. | **Vulnerable**: Raw Ed25519 secret seed held in process environment variables. |
| **Private Key Handling** | `src/stellar/soroban/transaction.service.ts` (L84) | Instantiates `Keypair.fromSecret(secretKey)` in Node.js process memory. | **Vulnerable**: Heap memory dump, crash dumps, or process inspection exposes private key. |
| **Transaction Building** | `src/stellar/soroban/transaction.service.ts` (L135-150) | Constructs `TransactionBuilder` with `create_settlement` host function call. | **Monolithic**: Transaction construction is coupled with key retrieval and submission. |
| **Transaction Signing** | `src/stellar/soroban/transaction.service.ts` (L169) | Direct call to `preparedTx.sign(signerKeypair)`. | **Unprotected**: No policy engine validates transaction parameters before signing. |
| **Transaction Submission** | `src/stellar/soroban/transaction.service.ts` (L172) | Submits directly via `sorobanClient.sendTransaction(preparedTx)`. | **Coupled**: Signing and submission occur in a single synchronous call tree. |
| **Duplicate Settlement Protection** | `src/modules/settlements/settlements.service.ts` (L93-104) | Prisma `@unique` constraint on `orderId` in `Settlement` table. | **Robust**: Prevents multiple settlement records for a single order. |
| **Replay Protection** | Soroban Smart Contract & Stellar Network | On-chain `settlement_id` (u64) unique tracking & account sequence numbers. | **Robust**: Network and contract reject duplicate transaction execution. |
| **Retry Strategy** | `src/workers/settlement.worker.ts` (L150-158) | Deterministic errors -> `FAILED`; Transient / RPC errors -> `REQUIRES_RECONCILIATION`. | **Adequate**: Prevents immediate blind retries on ambiguous RPC timeouts. |
| **Transaction Hash Storage** | `Settlement.stellarTransactionHash`<br>`TreasuryTransaction.stellarTxHash` | Saved in DB after RPC submission return. | **Adequate**: Retained for audit and reconciliation. |
| **Treasury Balance Tracking** | `LiquidityPool` table (`totalBalance`, `reservedBalance`, `availableBalance`) | Atomically managed via PostgreSQL `FOR UPDATE` row locks. | **Robust**: High precision and lock isolation. |
| **Admin Actions** | `LiquidityService.recordTreasuryTransaction` | Direct balance adjustment without multi-sig or dual control. | **High Risk**: Lacks approval workflow for manual treasury adjustments. |

---

## 3. Comprehensive Threat Model

We evaluated 20 threat vectors targeting LuminaRail's settlement and treasury infrastructure:

| # | Threat Vector | Attack Scenario | Impact | Current Protection | Remaining Risk | Recommended Mitigation |
|---|---|---|---|---|---|---|
| **1** | **Backend Server Compromise** | Attacker executes Remote Code Execution (RCE) on backend container. | Hot treasury private key stolen; total drain of hot wallet. | Environment variable schema validation (`zod`). | **CRITICAL**: Key sits in process memory and env. | Migrate signing to KMS/HSM. Backend only holds KMS Key ARN and IAM role. |
| **2** | **Private Key Exposure** | Secret seed accidentally committed to git, backup, or diagnostic dump. | Attacker imports seed into wallet and transfers funds. | Key excluded from git via `.env` in `.gitignore`. | **HIGH**: Human error during secret management. | Eliminate raw secret key in production; enforce KMS asymmetric key pairs. |
| **3** | **Environment Variable Leakage** | `/proc/self/environ` read or crash dump exposes env vars. | Secret key disclosed to unauthorized reader. | `AuditService` redacts `secret` / `private_key` in DB audit logs. | **HIGH**: Process crash dumps contain environment. | Replace secret seed env var with `STELLAR_SIGNER_PROVIDER=aws_kms` & `KMS_KEY_ARN`. |
| **4** | **Malicious Admin** | Rogues admin uses internal API/DB access to trigger unauthorized payout. | Arbitrary treasury depletion to insider address. | Audit logging of admin actions (`AuditLog`). | **HIGH**: No dual-control / threshold approval for admin adjustments. | Enforce multi-sig RBAC and Signer Policy Engine checks on destination address. |
| **5** | **Compromised Admin Account** | Stolen admin JWT token used to invoke settlement endpoints. | Unauthorized settlement initiation. | JWT authentication & RBAC middleware. | **MEDIUM**: Compromised admin credentials can bypass API checks. | Signer Policy Engine verifies order payment state in DB independently of caller role. |
| **6** | **Settlement Worker Compromise** | Worker process code injected to rewrite destination address in XDR. | USDC payouts redirected to attacker wallet. | Server-side address resolution from `Order.walletAddress`. | **HIGH**: Worker builds XDR and signs without external policy validation. | Decouple signing; Signer Policy Engine re-validates XDR against DB `Order`. |
| **7** | **Duplicate Settlement Job** | Multiple worker instances pick up same order concurrently. | Potential double-submission to Stellar network. | PostgreSQL row lock & `@unique` on `Settlement.orderId`. | **LOW**: Idempotency handled cleanly at DB & contract level. | Maintain atomic state transition `PENDING` -> `SUBMITTING` with `updateMany` count check. |
| **8** | **Transaction Replay** | Attacker intercepts signed XDR and re-submits it to network. | Potential double payout. | Soroban contract tracks used `settlement_id` (u64); Stellar sequence numbers. | **LOW**: Stellar RPC and Soroban contract reject replayed transactions. | Enforce unique `settlementId` per order; verify contract rejection codes. |
| **9** | **Stale Settlement** | Worker processes an order whose quote/payment expired hours ago. | Financial discrepancy due to stale FX rate or invalid order. | Order status must be `SETTLEMENT_PENDING`; quote checked at order creation. | **MEDIUM**: Long delay between payment and worker sweep. | Policy Engine enforces max transaction age (e.g., settlement created within 24h). |
| **10** | **Incorrect Payout Amount** | Bug or exploit alters `destinationAmount` during XDR construction. | Overpayment or underpayment of USDC. | Amount derived strictly from `Order.destinationAmount`. | **MEDIUM**: Worker could construct invalid XDR amount. | Signer Policy Engine parses XDR stroops and verifies `XDR.amount == Order.destinationAmount`. |
| **11** | **Incorrect Destination Wallet** | XDR destination address tampered with during assembly. | Funds sent to wrong wallet address. | Address validated with `StrKey.isValidEd25519PublicKey`. | **MEDIUM**: Malicious worker can supply valid key of attacker. | Signer Policy Engine parses XDR destination and verifies `XDR.destination == Order.walletAddress`. |
| **12** | **Unauthorized Contract Invocation** | Worker constructs XDR calling a malicious or unapproved Soroban contract. | Vault contract drained or arbitrary smart contract code executed. | `contractAddress` defaults to `config.stellar.settlementVaultContractId`. | **HIGH**: Worker can pass arbitrary `contractAddress` in params. | Signer Policy Engine enforces strict whitelist of approved `SETTLEMENT_VAULT_CONTRACT_ID`. |
| **13** | **Insufficient Treasury Balance** | Worker submits transaction when Hot Wallet lacks USDC. | On-chain transaction failure; gas wasted; worker queue blocked. | Pre-reservation check in `LiquidityService`. | **LOW**: Pool balance tracked in PostgreSQL. | Add pre-flight Hot Wallet Stellar account balance check before simulation. |
| **14** | **Stellar RPC Failure** | Stellar RPC node drops offline or returns HTTP 503 during submission. | Indeterminate submission status. | Exception caught; settlement marked `REQUIRES_RECONCILIATION`. | **MEDIUM**: Worker halts processing for that order. | Implement RPC retry with exponential backoff & multi-node fallback list. |
| **15** | **Transaction Submission Failure** | RPC rejects transaction with status `ERROR` (e.g. sequence number drift). | Settlement not submitted to chain. | Exception caught; marked `REQUIRES_RECONCILIATION` or `FAILED`. | **MEDIUM**: Sequence number collision requires account refresh. | Submission service refreshes account sequence from RPC and retries prepared transaction. |
| **16** | **Transaction Timeout** | RPC submission or status query times out while transaction is pending in mempool. | Unknown on-chain execution status. | Status set to `REQUIRES_RECONCILIATION`. Retries blocked until verified. | **MEDIUM**: Requires manual or daemon reconciliation. | Status Reconciliation Daemon polls Stellar Horizon/Soroban RPC by transaction hash. |
| **17** | **DB / Chain State Divergence** | On-chain transaction succeeds, but DB transaction fails (e.g. DB network error). | Customer wallet receives USDC, but order stays `SETTLEMENT_PENDING`. | `SettlementService.markCompleted` runs in Prisma transaction with `Order`. | **MEDIUM**: Order/Reservation state out of sync with chain. | Reconciliation Daemon uses chain state as source of truth to complete DB update. |
| **18** | **Compromised CI/CD Environment** | CI/CD pipeline secrets leaked during build/test step. | Testnet/Mainnet credentials exposed. | Secrets loaded from environment; unit tests use `MockSettlementExecutor`. | **MEDIUM**: CI environment variables might contain secrets. | Use OIDC short-lived role assumption for CI/CD; no static private keys in CI secrets. |
| **19** | **Log Leakage** | Secret key or sensitive data printed to stdout/stderr log streams. | Exposure in log aggregator (CloudWatch, Datadog). | `AuditService.sanitizeDetails` redacts sensitive JSON keys. | **MEDIUM**: Uncaught exception stack traces might include env object. | Enforce strict logger redactor filtering `signerSecretKey` and raw Ed25519 seeds globally. |
| **20** | **Accidental Large Settlement** | Software bug creates order for 1,000,000 USDC instead of 100 USDC. | Massive unintended treasury outflow. | `MAX_QUOTE_USDC_AMOUNT` enforced at quote creation (10,000 USDC). | **HIGH**: Bypassing quote validation could request large amount. | Enforce dual spending caps: single tx cap ($10,000) & daily cap ($200,000) inside Signer Policy Engine. |

---

## 4. Proposed Signer Abstraction Architecture

To completely decouple business logic from key management and transaction signing, we define a vendor-agnostic **Signer Interface** (`ITransactionSigner`) and **Authorization Policy Engine** (`ISettlementPolicyEngine`).

### Component Sequence Diagram

```
┌───────────────────┐      ┌───────────────────┐      ┌─────────────────────────┐      ┌───────────────────┐      ┌───────────────────┐
│ SettlementService │      │TransactionBuilder │      │ ISettlementPolicyEngine │      │ ITransactionSigner│      │ SubmissionService │
└─────────┬─────────┘      └─────────┬─────────┘      └────────────┬────────────┘      └─────────┬─────────┘      └─────────┬─────────┘
          │                          │                             │                             │                          │
          │ 1. Build Unsigned XDR    │                             │                             │                          │
          │─────────────────────────►│                             │                             │                          │
          │                          │ 2. Unsigned Transaction XDR │                             │                          │
          │                          │────────────────────────────►│                             │                          │
          │                          │                             │ 3. Validate Policy Against  │                          │
          │                          │                             │    Authoritative DB State   │                          │
          │                          │                             │    (Amount, Wallet, Asset)  │                          │
          │                          │                             │────────────────────────────┐│                          │
          │                          │                             │                            ││                          │
          │                          │                             │◄───────────────────────────┘│                          │
          │                          │                             │                             │                          │
          │                          │                             │ 4. Forward Approved XDR     │                          │
          │                          │                             │────────────────────────────►│                          │
          │                          │                             │                             │ 5. Sign with KMS/HSM     │
          │                          │                             │                             │─────────────────────────┐│
          │                          │                             │                             │                         ││
          │                          │                             │                             │◄────────────────────────┘│
          │                          │                             │                             │                          │
          │                          │                             │ 6. Signed Transaction XDR   │                          │
          │                          │◄────────────────────────────┴─────────────────────────────┤                          │
          │                          │                                                           │                          │
          │ 7. Submit Signed XDR     │                                                                                      │
          │──────────────────────────┴─────────────────────────────────────────────────────────────────────────────────►│
```

### TypeScript Interface Specification

```typescript
// Core Signer Identity Metadata
export interface SignerIdentity {
  publicKey: string;
  keyId: string; // KMS Key ARN, Vault Key Name, or Public Key
  providerType: 'TESTNET_LOCAL' | 'AWS_KMS' | 'GCP_KMS' | 'FIREBLOCKS' | 'HASHICORP_VAULT';
  networkPassphrase: string;
}

// Authoritative Context required for Policy Validation
export interface AuthorizationPolicyContext {
  settlementId: string;
  orderId: string;
  expectedSource: string;
  expectedDestination: string;
  expectedAmountStroops: bigint;
  expectedAssetContract: string;
  expectedVaultContract: string;
}

// Signer Request Envelope
export interface SignTransactionRequest {
  unsignedTransactionXdr: string;
  context: AuthorizationPolicyContext;
}

// Signer Response Envelope
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

// Clean Signer Abstraction
export interface ITransactionSigner {
  getIdentity(): Promise<SignerIdentity>;
  signTransaction(request: SignTransactionRequest): Promise<SignTransactionResponse>;
}
```

---

## 5. Transaction Authorization Policy Engine

The system MUST NEVER blindly sign arbitrary XDR provided by client callers or worker instances. The **`ISettlementPolicyEngine`** enforces strict invariant checks before passing any transaction to `ITransactionSigner`:

```typescript
export interface ISettlementPolicyEngine {
  validateAndApprove(request: SignTransactionRequest): Promise<void>;
}
```

### Policy Validation Checklist
1. **Network Passphrase Check**: Verifies XDR was built for the authorized network passphrase (`STELLAR_NETWORK`). Prevents signing Mainnet transactions with Testnet configurations or vice-versa.
2. **Contract Address Whitelist**: Inspects Soroban `InvokeHostFunction` operation and confirms the target contract ID matches the configured `STELLAR_SETTLEMENT_VAULT_CONTRACT_ID`.
3. **Host Function & Method Verification**: Ensures the invoked contract function is strictly `create_settlement`.
4. **Source Account Check**: Verifies transaction source account matches registered Hot Treasury public key.
5. **Destination Address Cross-Check**: Decodes `destination` address from XDR parameters and queries PostgreSQL to confirm `XDR.destination == Order.walletAddress` for the given `orderId`.
6. **Asset Contract Verification**: Confirms `asset` parameter matches official USDC Soroban contract address (`STELLAR_USDC_CONTRACT_ID`).
7. **Exact Monetary Amount Verification**: Converts `Order.destinationAmount` to stroops (`i128`) and verifies `XDR.amount == Order.destinationAmountStroops`.
8. **Order & Payment State Verification**: Re-queries DB to verify `Order.status == SETTLEMENT_PENDING`, associated `Payment.status == SUCCEEDED`, and `LiquidityReservation.status == CONFIRMED`.
9. **Settlement Age Limit**: Rejects settlements created more than 24 hours prior (`createdAt < now - 24h`) to prevent stale transaction processing.

---

## 6. Configurable Spending Controls

To prevent catastrophic automated loss due to software bugs or system compromise, spending controls are enforced at both Application Service and Signer Policy levels:

```
┌─────────────────────────────────────────────────────────┐
│              Configurable Spending Controls             │
├───────────────────────────────────┬─────────────────────┤
│ Field Name                        │ Recommended Default │
├───────────────────────────────────┼─────────────────────┤
│ MAX_SINGLE_SETTLEMENT_USDC        │ 10,000.00 USDC      │
│ MAX_HOURLY_OUTFLOW_USDC           │ 50,000.00 USDC      │
│ MAX_DAILY_OUTFLOW_USDC            │ 200,000.00 USDC     │
│ MIN_SETTLEMENT_USDC               │ 1.00 USDC           │
│ EMERGENCY_GLOBAL_PAUSE            │ false               │
│ TREASURY_LOW_BALANCE_THRESHOLD    │ 5,000.00 USDC       │
└───────────────────────────────────┴─────────────────────┘
```

*Operational Note*: Default values must be reviewed and formally approved by LuminaRail Risk & Compliance officers prior to Mainnet launch.

---

## 7. Replay Protection & Idempotency Audit

An audit of existing idempotency controls confirmed strong multi-layered protection:

1. **Order Level**: `idempotency_key` unique index on `Order` table prevents duplicate order creation.
2. **Liquidity Reservation Level**: PostgreSQL `SELECT FOR UPDATE` row locks guarantee atomic balance updates; `@unique` on `orderId` prevents duplicate reservations.
3. **Settlement Level**: `@unique` on `orderId` in `Settlement` model prevents concurrent worker double-creation (handled with Prisma `P2002` exception catch).
4. **Payment Webhook Level**: Unique index on `[provider, eventId]` in `WebhookEvent` table prevents duplicate Paystack webhook execution.
5. **On-Chain Soroban Level**: Smart contract tracks used `settlement_id` (u64); duplicate execution of `create_settlement` with an existing `settlement_id` reverts on-chain.
6. **Stellar Network Level**: Account sequence numbers guarantee each signed transaction can only be included in a ledger once.

---

## 8. Database / Chain Reconciliation Matrix

The system specifies deterministic recovery workflows for all 7 edge-case failure modes:

| Scenario | State Condition | Root Cause | Automated Recovery Strategy |
|---|---|---|---|
| **A** | DB: `PENDING` / `SUBMITTING`<br>Chain: `SUCCESS` | Worker crash after chain submission before DB update. | **Status Reconciliation Daemon** queries Soroban RPC `getTransaction(txHash)`. On `SUCCESS`, atomically updates `Settlement` -> `COMPLETED`, `Order` -> `COMPLETED`, and invokes `LiquidityService.consumeReservation()`. |
| **B** | DB: `PENDING` / `SUBMITTING`<br>Chain: `FAILED` | On-chain contract assertion failure (e.g. insufficient vault balance). | Reconciliation Daemon detects `FAILED` on RPC. Updates `Settlement` -> `FAILED`, sets `lastError`, calls `LiquidityService.releaseReservation()` (`CANCELLED_RELEASED`), updates `Order` -> `FAILED`. |
| **C** | DB: `SUBMITTED`<br>Chain: `UNKNOWN` (RPC Timeout) | Soroban RPC timeout during status query. | Settlement status set to `REQUIRES_RECONCILIATION`. Re-submission is **BLOCKED**. Daemon polls RPC with exponential backoff up to 24 hours. If confirmed `SUCCESS`, recovers via Scenario A. |
| **D** | DB: `SUBMITTING`<br>Chain: `NONE` | Worker crash after signing but before RPC broadcast. | Recovery Daemon checks signer sequence number and RPC status by hash. If non-existent on-chain, resets `Settlement` status to `PENDING` for clean re-simulation and signing. |
| **E** | DB: `SUBMITTED`<br>Chain: `SUCCESS` | Worker crash after RPC submission before DB record of `stellarLedger`. | Next worker sweep detects `stellarTransactionHash` present. Queries RPC, receives `SUCCESS` and ledger number, and marks `COMPLETED`. |
| **F** | DB: `SETTLEMENT_PENDING`<br>Chain: `NONE` (Build/Sim Error) | Invalid address or RPC simulation failure. | `SettlementWorker` catches error. Deterministic error -> `Settlement` marked `FAILED`, reservation released. Transient error -> increment `attemptCount`, retain `PENDING` status for retry. |
| **G** | DB Update Error after Chain `SUCCESS` | DB transaction failure (e.g. connection drop) after RPC returns transaction hash. | On next daemon poll, transaction hash is queried against RPC. Returns `SUCCESS`, allowing daemon to re-execute DB completion transaction idempotently. |

---

## 9. Treasury Ledger Assessment (`TreasuryTransaction`)

The existing `TreasuryTransaction` model was audited against enterprise accounting requirements:

```prisma
model TreasuryTransaction {
  id            String                  @id @default(uuid())
  poolId        String                  @map("pool_id")
  type          TreasuryTransactionType // REPLENISHMENT, SETTLEMENT_PAYOUT, MANUAL_ADJUSTMENT, FEE_COLLECTION
  amount        Decimal                 @db.Decimal(18, 7)
  stellarTxHash String?                 @map("stellar_tx_hash")
  externalRef   String?                 @map("external_ref")
  createdAt     DateTime                @default(now()) @map("created_at")
  pool          LiquidityPool           @relation(fields: [poolId], references: [id])
}
```

### Identified Gaps for Production Audit Trail
1. **Missing Enum Types**: Lacks `WITHDRAWAL` (Cold transfer) and `REFUND_REVERSAL` transaction types.
2. **Missing Balance Snapshots**: Does not record `balanceAfter` snapshot, requiring a full sequential scan of historical rows to audit balance history.
3. **Missing Admin Attribution**: Lacks `actorId` tracking for manual adjustments (`MANUAL_ADJUSTMENT`).
4. **Missing Gas/Network Fee Tracking**: Does not capture Stellar transaction stroop fee (`networkFeeUsdc`).

*Conclusion*: The current `TreasuryTransaction` model is functional for MAINNET-04 architecture planning. Extension of the enum and addition of snapshot fields (`balanceAfter`, `actorId`) will be scheduled for a future Prisma migration.

---

## 10. Hot / Cold Treasury Architecture

LuminaRail enforces a 3-tier isolated treasury model to protect capital reserves:

```
  ┌───────────────────────────┐
  │       Cold Treasury       │  3-of-5 Hardware / Institutional Custody (Offline)
  │   Holds 90-95% Reserves   │  G...COLD_TREASURY
  └─────────────┬─────────────┘
                │ Periodic Manual Replenishment
                ▼
  ┌───────────────────────────┐
  │   Replenishment Wallet    │  2-of-3 Multisig / Rate-Limited Buffer
  │    Holds 5-10% Reserves   │  G...REPLENISH_TREASURY
  └─────────────┬─────────────┘
                │ Automated Refill when Hot Wallet < MIN_THRESHOLD
                ▼
  ┌───────────────────────────┐
  │   Hot Settlement Wallet   │  KMS / HSM Single Signer with Policy Engine
  │     Capped Operational    │  G...HOT_TREASURY (Max ~10,000 - 50,000 USDC)
  └─────────────┬─────────────┘
                │ Automated Instant Settlements
                ▼
  ┌───────────────────────────┐
  │   User Destination Wallet │
  └───────────────────────────┘
```

### Wallet Operational Roles
- **Cold Treasury Wallet**: Offline hardware multisig holding bulk protocol liquidity. Zero connectivity to application backend.
- **Replenishment Wallet**: Medium-security buffer wallet used to refill the Hot Wallet. Requires dual authorization for transfers exceeding daily thresholds.
- **Hot Settlement Wallet**: Hot operational wallet managed by `ITransactionSigner` via KMS/HSM. Backend only holds permission to request signatures for transactions passing `ISettlementPolicyEngine` checks.
- **Low-Balance Alerts**: When Hot Wallet balance drops below `TREASURY_LOW_BALANCE_THRESHOLD` (5,000 USDC), automated PagerDuty / Webhook alerts trigger a replenishment request.
- **Emergency Circuit Breaker**: If the Hot Wallet is suspected of compromise, setting `EMERGENCY_GLOBAL_PAUSE=true` instantly freezes all signing operations. Cold and Replenishment treasuries remain completely untouched.

---

## 11. Multi-Tiered Emergency Controls

```
                      ┌─────────────────────────────────┐
                      │    Emergency Trigger Event      │
                      └────────────────┬────────────────┘
                                       │
            ┌──────────────────────────┼──────────────────────────┐
            ▼                          ▼                          ▼
┌───────────────────────┐  ┌───────────────────────┐  ┌───────────────────────┐
│ Database / Config     │  │ Signer Policy Engine  │  │ Smart Contract        │
│ Pause                 │  │ Caps                  │  │ Pause                 │
├───────────────────────┤  ├───────────────────────┤  ├───────────────────────┤
│ EMERGENCY_GLOBAL_PAUSE│  │ MAX_SINGLE_SETTLEMENT │  │ Soroban Vault         │
│ TREASURY_PAUSE        │  │ MAX_DAILY_OUTFLOW     │  │ Admin pause()         │
│ PER_ASSET_PAUSE       │  │ CONTRACT_WHITELIST    │  │ On-Chain Freeze       │
└───────────────────────┘  └───────────────────────┘  └───────────────────────┘
```

1. **Layer 1 (Database/Config Level)**: Immediate soft pause toggled via Redis/Config flags (`EMERGENCY_GLOBAL_PAUSE=true`). Halts background workers within 1 second.
2. **Layer 2 (Signer Policy Engine Level)**: Hard policy limits enforced in code before calling KMS. Even if DB is compromised, Signer rejects transactions exceeding single/daily spending limits or targeting non-whitelisted contracts.
3. **Layer 3 (On-Chain Smart Contract Level)**: Admin invocation of `pause()` on Soroban Settlement Vault contract. On-chain freeze prevents settlement execution regardless of signed transactions.

---

## 12. Testnet Compatibility & Production Isolation

- **Testnet Signer (`TestnetLocalSigner`)**: Retained as a development implementation of `ITransactionSigner`. Uses `STELLAR_SETTLEMENT_SIGNER_SECRET_KEY` from local `.env`.
- **Production Guard**: `assertLiveSettlementTestnetSafety()` and `config.env` validation enforce that `TestnetLocalSigner` CANNOT be instantiated when `NODE_ENV === 'production'`.
- **Secret Isolation**: Raw secret seeds are NEVER logged, serialized, or exposed in API responses or error stack traces.

---

## 13. Security Logging & Audit Metadata Requirements

`AuditService` enforces strict data sanitization rules. 

### Mandatory Redaction Rules
The following keys are automatically redacted to `[REDACTED]` prior to audit log persistence:
`password`, `password_hash`, `token`, `secret`, `api_key`, `private_key`, `seed`, `seed_phrase`.

### Approved Audit Metadata Schema
Settlement audit entries are restricted to non-sensitive operational metadata:
```json
{
  "settlementId": "STL_1725800000_abc123",
  "orderId": "ord_9988776655",
  "signerPublicKey": "GBX...SETTLEMENT_SIGNER",
  "signerProvider": "AWS_KMS",
  "network": "testnet",
  "contractAddress": "CC...SETTLEMENT_VAULT",
  "destination": "GA...USER_RECIPIENT",
  "asset": "CC...USDC_CONTRACT",
  "amount": "100.0000000",
  "stellarTransactionHash": "a1b2c3d4e5f6...",
  "timestamp": "2026-09-09T10:30:00.000Z"
}
```

---

## 14. Summary of Remaining Blockers for Mainnet Launch

Before proceeding to Mainnet production deployment, the following technical prerequisites must be completed:

1. **AWS KMS / Custody Signer Driver Implementation**: Implement `KmsSigner` using AWS KMS SDK (`@aws-sdk/client-kms`) or Fireblocks API.
2. **Production Risk Review**: Risk Committee approval of daily outflow caps and single transaction settlement limits.
3. **Soroban Contract Deployment**: Deploy and verify audited Soroban Settlement Vault smart contract on Stellar Mainnet.
4. **Reconciliation Daemon Service**: Deploy dedicated background reconciliation daemon process (`ReconciliationDaemon`) for automated Scenario A-G state recovery.
5. **Multi-Sig Cold Treasury Setup**: Provision 3-of-5 hardware multisig cold treasury wallet on Stellar Mainnet.

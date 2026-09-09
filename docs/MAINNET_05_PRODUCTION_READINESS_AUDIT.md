# MAINNET-05 — Production Readiness & Failure Lifecycle Audit

## Executive Summary

This document presents a comprehensive, code-level production-readiness audit of **LuminaRail** (`luminarail-backend`) following the successful implementation of the **MAINNET-04 Treasury & Signing Security Architecture**.

While MAINNET-04 established cryptographic signer abstraction, `SettlementPolicyEngine` XDR inspection, and durable crash-reconciliation for Stellar transactions, this audit evaluates the **end-to-end operational lifecycle**—from NGN deposit ingestion through fiat payment providers (Paystack) to USDC settlement execution on Stellar, liquidity management, refund handling, and compliance boundaries.

> [!CAUTION]
> **PRODUCTION READINESS VERDICT**: **NOT READY FOR PRODUCTION**.
> Although unit tests pass and cryptographic transaction authorization is hardened, LuminaRail currently lacks **automated refund processing**, **independent Paystack ledger reconciliation**, **late-webhook liquidity re-reservation**, and **KYC/AML compliance boundaries**. 
> Enabling real NGN deposits or Mainnet USDC settlements under the current codebase will result in **stranded customer funds** upon settlement or payment edge-case failures.

---

## 1. End-to-End Payment & Settlement Lifecycle Trace

The LuminaRail transaction lifecycle spans 9 sequential stages across 5 decoupled modules:

```
┌──────────────┐     ┌──────────────┐     ┌───────────────────────┐     ┌───────────────────┐
│ 1. Quote     │ ──► │ 2. Order     │ ──► │ 3. Liquidity          │ ──► │ 4. Payment        │
│    Creation  │     │    Created   │     │    Reservation        │     │    Initialized    │
└──────────────┘     └──────────────┘     └───────────────────────┘     └─────────┬─────────┘
                                                                                  │
┌──────────────┐     ┌──────────────┐     ┌───────────────────────┐               │
│ 8. Order     │ ◄── │ 7. Settlement│ ◄── │ 6. Settlement         │ ◄─────────────┤ 5. Webhook
│    COMPLETED │     │    Confirmed │     │    PENDING            │               │    Confirmed
└──────────────┘     └──────────────┘     └───────────────────────┘               └───────────────────┘
```

### Stage Summary & Component Mapping
1. **Quote Creation** (`QuoteService.createQuote`): Client requests FX quote (NGN $\rightarrow$ USDC). System verifies rate, fee, and available liquidity in `LiquidityPool` (`availableBalance >= destinationAmount`), creating a `Quote` in `ACTIVE` status (TTL: 300s).
2. **Order Placement** (`OrderService.createOrder`): Client places order referencing an active `quoteId`. System verifies quote freshness, reserves idempotency key, and creates `Order` (`status: CREATED`).
3. **Liquidity Reservation** (`LiquidityService.reserveForOrderInTx`): Within an atomic Prisma transaction with PostgreSQL `SELECT FOR UPDATE` row locks, `availableBalance` is decremented, `reservedBalance` is incremented, `LiquidityReservation` is created (`status: RESERVED`, TTL: 15 min), and quote status is set to `USED`.
4. **Payment Initialization** (`PaymentService.createPayment`): Creates `Payment` record (`status: CREATED`), invokes payment provider (`PaystackClient.initializeTransaction`), saves authorization URL & reference, and updates `Order` to `AWAITING_PAYMENT`.
5. **Payment Webhook & Confirmation** (`WebhookService.processWebhook`): Paystack delivers HTTP POST webhook. Signature is verified using HMAC-SHA512 raw body comparison. `WebhookEvent` row is claimed atomically. `Payment` transitions to `SUCCEEDED`. `LiquidityService.confirmReservation(orderId)` updates reservation to `CONFIRMED`. `Order` transitions to `SETTLEMENT_PENDING`.
6. **Settlement Sweep & Signing** (`SettlementWorker` $\rightarrow$ `SorobanTransactionService` $\rightarrow$ `SettlementPolicyEngine` $\rightarrow$ `TestnetLocalSigner`): Background worker claims order, creates `Settlement` (`PENDING` $\rightarrow$ `SUBMITTING`), constructs Soroban XDR, simulates footprint, enforces 16 policy assertions in `SettlementPolicyEngine`, signs XDR via `ITransactionSigner`, and submits to Soroban RPC.
7. **Settlement Confirmation & Accounting** (`SorobanConfirmationService` / `ReconciliationDaemon`): Polls RPC `getTransaction`. On `SUCCESS`, `SettlementService.markCompleted()` updates `Settlement` to `COMPLETED`, calls `LiquidityService.consumeReservation()` (`totalBalance` & `reservedBalance` reduced, reservation `CONSUMED`, `TreasuryTransaction` written).
8. **Order Completion** (`OrderService`): `Order` transitions to `COMPLETED`, and `SETTLEMENT_COMPLETED` audit log is written.

---

## 2. Comprehensive 20-Point Failure & Edge-Case Audit Matrix

We evaluated 20 failure vectors across the complete lifecycle in the active repository code:

| # | Scenario | Current Code Behavior | Current DB State | Stranded Funds? | Permanent Reserved Liquidity? | Duplicate Payout Risk? | Refund Required? | Recommended Production Behavior |
|---|---|---|---|---|---|---|---|---|
| **1** | **Paystack Init Failure** | `PaymentService.createPayment` catches error, marks `Payment.status = FAILED`, throws error. | `Payment: FAILED`<br>`Order: CREATED`<br>`Reservation: RESERVED` | No | Temporarily (15 min until cleanup worker runs) | No | No | Immediately invoke `LiquidityService.releaseReservation()` on payment init failure. |
| **2** | **Payment Abandoned** | Customer closes checkout. Reservation expires after 15 min. | `Payment: CREATED`<br>`Order: AWAITING_PAYMENT`<br>`Reservation: EXPIRED_RELEASED` | No | No (cleaned by worker) | No | No | Auto-expire `Order` to `EXPIRED` status when cleanup worker runs. |
| **3** | **Payment Expired** | Paystack authorization URL expires (30 min). | `Payment: EXPIRED`<br>`Order: EXPIRED`<br>`Reservation: EXPIRED_RELEASED` | No | No | No | No | Correct behavior; ensure webhook or cron updates payment to `EXPIRED`. |
| **4** | **Payment Failed / Declined** | Paystack returns `charge.failed`. `WebhookService` sets `Payment: FAILED`, calls `releaseReservation()`. | `Payment: FAILED`<br>`Order: FAILED`<br>`Reservation: CANCELLED_RELEASED` | No | No | No | No | Correct behavior. |
| **5** | **Payment Cancelled** | User cancels at checkout. Same handling as Payment Failed. | `Payment: CANCELLED`<br>`Order: CANCELLED`<br>`Reservation: CANCELLED_RELEASED` | No | No | No | No | Correct behavior. |
| **6** | **Duplicate NGN Transfer** | Customer sends 2 bank transfers to same Paystack reference. Webhook 1 succeeds; Webhook 2 ignored by state machine. | `Payment: SUCCEEDED`<br>(Only 1 Payment record exists) | **YES** (2nd deposit trapped at Paystack) | No | No | **YES** (Manual or automated refund of 2nd deposit) | Detect duplicate deposit references at Paystack webhook level and auto-create `Refund` record. |
| **7** | **Duplicate Webhook** | Paystack retries same webhook event. `WebhookEvent` `@unique[provider, eventId]` catches it. | `WebhookEvent: processed`<br>`Payment: SUCCEEDED` | No | No | No | No | Correct behavior (idempotent return 200). |
| **8** | **Late Webhook (>15 min)** | Webhook arrives after reservation expired (`EXPIRED_RELEASED`). `confirmReservation()` returns without confirming. Policy Engine **REJECTS** signing (`status !== CONFIRMED`). | `Payment: SUCCEEDED`<br>`Order: SETTLEMENT_PENDING`<br>`Reservation: EXPIRED_RELEASED`<br>`Settlement: FAILED/REJECTED` | **YES** (Customer NGN received, USDC payout rejected) | No | No | **YES** | Re-reserve liquidity if available balance permits; otherwise trigger **AUTOMATED NGN REFUND**. |
| **9** | **Out-of-Order Webhook** | `charge.success` arrives before payment creation DB write completes. `findFirst` returns null. | `WebhookEvent: processed = false` | **YES** | No | No | **YES** (If unprocessed) | Store unlinked webhooks in dead-letter queue; retry linking when payment created. |
| **10** | **Delayed Webhook** | Webhook delayed by hours due to network partition. Settlement pending. | Same as Scenario 8 (Late Webhook). | **YES** | No | No | **YES** | Auto-re-evaluate liquidity or trigger auto-refund. |
| **11** | **Manual Verification Needed** | Paystack transaction status `pending` / `unknown`. `verifyPayment` API called manually. | `Payment: SUCCEEDED`<br>`Order: SETTLEMENT_PENDING` | No | No | No | No | Correct behavior; ensures manual verification triggers `confirmReservation()`. |
| **12** | **Settlement FAILED on-chain** | Smart contract reverts or recipient address invalid. Worker marks `Settlement: FAILED`, releases reservation, sets `Order: FAILED`. | `Payment: SUCCEEDED`<br>`Order: FAILED`<br>`Settlement: FAILED`<br>`Reservation: CANCELLED_RELEASED` | **YES** (Customer paid NGN, got no USDC, no refund) | No | No | **CRITICAL YES** | Transition `Order` to `REFUND_PENDING` and trigger automated NGN refund via Paystack Refund API. |
| **13** | **Worker Crash Post-Signing** | Worker crashes in `SUBMITTING` state without `stellarTransactionHash`. `ReconciliationDaemon` flags `REQUIRES_RECONCILIATION`. | `Settlement: REQUIRES_RECONCILIATION`<br>`Order: SETTLEMENT_PENDING` | No | Yes (held in reservation) | **NO** (Blocked from worker sweeps) | No (pending audit) | Operator / Daemon inspects Horizon account sequence. If un-broadcast, resets to `PENDING`. |
| **14** | **DB Fail Post-Chain Success** | On-chain tx succeeds, but DB drop prevents `markCompleted()`. `ReconciliationDaemon` queries RPC, detects `SUCCESS`, completes DB update. | `Settlement: COMPLETED`<br>`Order: COMPLETED` | No | No | No | No | Correct behavior (Chain is source of truth). |
| **15** | **RPC Timeout / Unreachable** | RPC times out during submission or status query. Marked `REQUIRES_RECONCILIATION`. | `Settlement: REQUIRES_RECONCILIATION` | No | Yes | No | No | Poll RPC with exponential backoff up to 24h before resolving. |
| **16** | **Unknown Submission Result** | RPC connection drops during HTTP POST `sendTransaction`. | Same as Scenario 15. | No | Yes | No | No | Re-submission BLOCKED until transaction hash confirmed or account sequence drift verified. |
| **17** | **Insufficient Hot Liquidity** | Hot wallet balance < settlement amount. Policy Engine checks stroops vs balance; simulation fails. | `Settlement: REQUIRES_RECONCILIATION` or `PENDING` | No | Yes | No | No (If refilled) | Trigger automated PagerDuty alert to Hot Wallet replenishment buffer. |
| **18** | **Reservation Expiry Race** | Reservation expires at exact millisecond webhook arrives. `confirmReservation` vs cleanup worker race. | Transactional lock isolates status update. | No | No | No | No | Database row lock prevents concurrent state corruption. |
| **19** | **Reservation Release Race** | Cleanup worker attempts to release reservation while payment verification is processing. | Transactional update lock on `LiquidityReservation`. | No | No | No | No | Row lock prevents double release. |
| **20** | **App Restart During Settlement** | Process SIGTERM during settlement flow. In-flight DB queries rollback; DB status reflects last committed state. | State dependent on commit boundary. | No | Temporary | No | No | `ReconciliationDaemon` sweeps unconfirmed settlements on startup. |

---

## 3. Treasury & Liquidity Invariants Audit

The core financial invariant governing protocol liquidity is:

$$\text{availableBalance} = \text{totalBalance} - \text{reservedBalance}$$

### Verified Invariant Controls
1. **Atomic Modifications**: All updates to `LiquidityPool` balances inside [`LiquidityService`](file:///home/whiteghost/LuminaRail/luminarail-backend/src/modules/liquidity/liquidity.service.ts) use PostgreSQL `SELECT FOR UPDATE` row locks.
2. **Precision Safety**: Balances are calculated using `Prisma.Decimal` (18 integer, 7 decimal places), matching Stellar's 7-decimal stroop precision ($1\text{ USDC} = 10,000,000\text{ stroops}$).
3. **Non-Negative Constraints**: `availableBalance` checks enforce `availableBalance >= 0` and `reservedBalance <= totalBalance`.

### Identified Treasury Gaps
- **Missing Administrative Balance Snapshots**: `TreasuryTransaction` does not store `balanceAfter`, requiring a full historical table scan to calculate pool balance at a past timestamp.
- **Unlinked Manual Adjustments**: `MANUAL_ADJUSTMENT` transactions lack required `actorId` / admin approval metadata.

---

## 4. Critical Production Blockers

Before LuminaRail can process real monetary transactions on Stellar Mainnet, the following **5 Critical Production Blockers** must be resolved:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ CRITICAL BLOCKER 1: NO AUTOMATED REFUND ENGINE                              │
│ - Customer NGN is collected on Paystack, but if settlement fails on-chain   │
│   or wallet is invalid, funds are permanently trapped without a refund pipeline.│
├─────────────────────────────────────────────────────────────────────────────┤
│ CRITICAL BLOCKER 2: LATE WEBHOOK LIQUIDITY DEADLOCK                         │
│ - Webhook arriving after 15-min reservation expiry leaves payment SUCCEEDED   │
│   and order SETTLEMENT_PENDING, but Policy Engine REJECTS unconfirmed       │
│   reservations. Zero payout & zero refund.                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ CRITICAL BLOCKER 3: NO INDEPENDENT PAYSTACK RECONCILIATION                  │
│ - Backend relies 100% on incoming HTTP webhooks. Missed/dropped webhooks    │
│   cause silent order stagnation without automatic API polling reconciliation.│
├─────────────────────────────────────────────────────────────────────────────┤
│ CRITICAL BLOCKER 4: MISSING COMPLIANCE & KYC/AML BOUNDARIES                 │
│ - No checks exist to block sanctioned wallet addresses, unverified users,   │
│   or high-risk velocity limits prior to settlement signing.                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ CRITICAL BLOCKER 5: DEFERRED PRODUCTION KMS / HSM SIGNER DRIVERS            │
│ - Production environment currently rejects `TestnetLocalSigner`, but AWS KMS │
│   and institutional custody SDK drivers are not yet implemented.            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Recommended Implementation Order for MAINNET-05+

1. **Phase 1: Refund Engine & State Machine** (`docs/MAINNET_05_REFUND_RECONCILIATION_DESIGN.md`)
   - Implement `RefundService`, Paystack Refund API driver, and `REFUND_PENDING` / `REFUNDED` order transitions.
2. **Phase 2: Independent Paystack Reconciliation Worker**
   - Implement background cron worker comparing Paystack transaction list vs LuminaRail DB payments.
3. **Phase 3: Late-Webhook Liquidity Auto-Recovery**
   - Update `confirmReservation()` to attempt dynamic re-reservation if pool balance permits; otherwise auto-route to `REFUND_PENDING`.
4. **Phase 4: Compliance & KYC/AML Boundary Plug** (`docs/MAINNET_05_COMPLIANCE_BOUNDARY.md`)
   - Implement pre-order and pre-settlement compliance verification hooks.
5. **Phase 5: Production KMS Driver & Observability Model** (`docs/MAINNET_05_PRODUCTION_CONFIG_AUDIT.md`, `docs/MAINNET_05_INCIDENT_RESPONSE.md`)
   - Integrate `@aws-sdk/client-kms` and deploy structured CloudWatch / Prometheus metrics.

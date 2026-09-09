# MAINNET-05 SECURITY & ARCHITECTURE AUDIT REPORT: REFUND ENGINE & PRODUCTION SAFETY

> **SECURITY AUDIT VERDICT**: **PASS WITH REQUIRED FIXES**
> **AUDIT DATE**: 2026-09-09
> **TARGET COMPONENT**: Phase 8 Refund Engine & Production Readiness (MAINNET-05)

---

## 1. EXECUTIVE SUMMARY

An architectural and code-level security audit was conducted on the **MAINNET-05 / Phase 8 Refund Engine** implementation in the `luminarail-backend` codebase.

The audit inspected the state machines, Prisma database schema and migrations, payment provider interfaces, Paystack client integration, refund service logic, controller authorization, webhook handlers, and incident response/compliance documentation.

### Core Findings Summary
1. **Critical Invariant Breach (Double Payout Risk)**: `RefundService.createRefund()` does not check if an active settlement transaction is currently in-flight (`SUBMITTING`, `SUBMITTED`, `CONFIRMING`, or `REQUIRES_RECONCILIATION`) on Stellar when an order is in `SETTLEMENT_PENDING`. A user or automated trigger can initiate an NGN fiat refund while the Soroban USDC settlement completes on-chain, leading to a **double payout** (customer receives both NGN refund and USDC payout).
2. **Race Condition on Partial Refunds**: `RefundService.createRefund()` queries cumulative existing refunds without database row locking (`FOR UPDATE`). Concurrent refund requests can bypass the cumulative refund check and over-refund an order.
3. **Authorization Boundary Exposure**: `POST /api/v1/refunds` permits any regular authenticated user to self-initiate refunds on their active orders without administrative approval or restriction to failed/expired orders.
4. **Missing Test Suite**: Zero unit or integration tests currently exist for the Refund Engine under `tests/`.

---

## 2. AUDITED FILES & COMPONENTS

The following 15 files and artifacts were audited:

### Implementation & Configuration
1. [src/modules/refunds/refunds.service.ts](file:///home/whiteghost/LuminaRail/luminarail-backend/src/modules/refunds/refunds.service.ts)
2. [src/modules/refunds/refund.state-machine.ts](file:///home/whiteghost/LuminaRail/luminarail-backend/src/modules/refunds/refund.state-machine.ts)
3. [src/modules/refunds/refunds.controller.ts](file:///home/whiteghost/LuminaRail/luminarail-backend/src/modules/refunds/refunds.controller.ts)
4. [src/modules/orders/orders.state-machine.ts](file:///home/whiteghost/LuminaRail/luminarail-backend/src/modules/orders/orders.state-machine.ts)
5. [src/modules/providers/paystack.provider.ts](file:///home/whiteghost/LuminaRail/luminarail-backend/src/modules/providers/paystack.provider.ts)
6. [src/services/paystack.client.ts](file:///home/whiteghost/LuminaRail/luminarail-backend/src/services/paystack.client.ts)
7. [src/modules/providers/paymentProvider.interface.ts](file:///home/whiteghost/LuminaRail/luminarail-backend/src/modules/providers/paymentProvider.interface.ts)
8. [src/modules/providers/mock.provider.ts](file:///home/whiteghost/LuminaRail/luminarail-backend/src/modules/providers/mock.provider.ts)
9. [prisma/schema.prisma](file:///home/whiteghost/LuminaRail/luminarail-backend/prisma/schema.prisma)
10. [prisma/migrations/20260909114243_phase8_refund_engine/migration.sql](file:///home/whiteghost/LuminaRail/luminarail-backend/prisma/migrations/20260909114243_phase8_refund_engine/migration.sql)

### Documentation & Compliance
11. [docs/MAINNET_05_REFUND_RECONCILIATION_DESIGN.md](file:///home/whiteghost/LuminaRail/luminarail-backend/docs/MAINNET_05_REFUND_RECONCILIATION_DESIGN.md)
12. [docs/MAINNET_05_COMPLIANCE_BOUNDARY.md](file:///home/whiteghost/LuminaRail/luminarail-backend/docs/MAINNET_05_COMPLIANCE_BOUNDARY.md)
13. [docs/MAINNET_05_INCIDENT_RESPONSE.md](file:///home/whiteghost/LuminaRail/luminarail-backend/docs/MAINNET_05_INCIDENT_RESPONSE.md)
14. [docs/MAINNET_05_PRODUCTION_CONFIG_AUDIT.md](file:///home/whiteghost/LuminaRail/luminarail-backend/docs/MAINNET_05_PRODUCTION_CONFIG_AUDIT.md)
15. [docs/MAINNET_05_PRODUCTION_READINESS_AUDIT.md](file:///home/whiteghost/LuminaRail/luminarail-backend/docs/MAINNET_05_PRODUCTION_READINESS_AUDIT.md)

---

## 3. DETAILED AUDIT FINDINGS BY AREA

### 1. Refund State Machine & Lifecycle
- **Order State Flow**: `CREATED` → `AWAITING_PAYMENT` → `PAYMENT_CONFIRMED` → `SETTLEMENT_PENDING` → `SETTLEMENT_COMPLETED` / `COMPLETED`.
- **Refund State Flow**: `PENDING` → `PROCESSING` → `SUCCEEDED` / `FAILED` / `CANCELLED`.
- **Terminal Isolation**: `OrderStateMachine.canTransition()` ([orders.state-machine.ts](file:///home/whiteghost/LuminaRail/luminarail-backend/src/modules/orders/orders.state-machine.ts#L88-L90)) blocks `REFUNDED` status from regressing to active execution.
- **Flaw**: `RefundService.createRefund()` does not prevent refund creation when an order is in `SETTLEMENT_PENDING` while a settlement transaction is already in-flight (`SUBMITTING`, `SUBMITTED`, `CONFIRMING`).

### 2. Critical Double-Payout / Double-Refund Protection
- **Scenario A/B (In-Flight Settlement Refund Race)**: **UNSAFE**. If a settlement transaction is submitted to Stellar RPC (`SettlementStatus.SUBMITTED`), `Order.status` remains `SETTLEMENT_PENDING`. `RefundService.createRefund()` only checks if `order.status` is `COMPLETED` or `SETTLEMENT_COMPLETED`. It does NOT check `Settlement.status`. As a result, a refund can be issued via Paystack while the on-chain Soroban USDC settlement completes, resulting in a **double payout**.
- **Scenario C (Duplicate Webhooks)**: **SAFE**. Webhooks trigger `processAutomaticRefund()` using a deterministic idempotency key (`AUTO_REF_${orderId}_...`). Unique database constraints prevent duplicate insertions.
- **Scenario D (Duplicate Refund Requests)**: **SAFE**. Idempotency key tracking and cumulative balance validation block duplicate manual requests.
- **Scenario E (Worker Retries)**: **SAFE**. `ReconciliationDaemon` flags unknown crashes as `REQUIRES_RECONCILIATION`, excluding them from automated worker sweeps.
- **Scenario F (Paystack Refund DB Crash)**: **PARTIALLY SAFE**. If Paystack accepts a refund but DB update fails, status remains `PROCESSING`. Re-executing refund sends identical parameters to Paystack. However, Paystack's endpoint behavior on duplicate calls with the same transaction reference must be explicitly handled.

### 3. Paystack Refund Semantics
- **Endpoint**: `POST https://api.paystack.co/refund`
- **Payload**: `{ transaction: reference, amount: amountInKobo, merchant_note: reason }`
- **Ambiguous Response Handling**: In [paystack.provider.ts](file:///home/whiteghost/LuminaRail/luminarail-backend/src/modules/providers/paystack.provider.ts#L186-L200), if `client.refundTransaction()` encounters a network error, it returns `status: RefundStatus.PROCESSING` with `ambiguousNetworkFailure: true`.
- **Unknown Result Invariant**: The system correctly retains `RefundStatus.PROCESSING` rather than marking the refund `FAILED` or blindly attempting a second payout.

### 4. Payment / Refund / Settlement Race Conditions
- **Missing Database Locks**: In `RefundService.createRefund()` ([refunds.service.ts](file:///home/whiteghost/LuminaRail/luminarail-backend/src/modules/refunds/refunds.service.ts#L30-L86)), `order` and `existingRefunds` are queried without PostgreSQL row locking (`FOR UPDATE`). Under concurrent refund creation requests, two requests can read the same `totalAlreadyRefunded` and over-refund the order.

### 5. Liquidity Reservation Interaction
- **Release Timing**: When `RefundService.executeRefund()` completes with `RefundStatus.SUCCEEDED`, it calls `LiquidityService.releaseReservation(orderId, CANCELLED_RELEASED)`.
- **Ambiguous State**: While refund status is `PROCESSING`, liquidity is retained in `CONFIRMED` / `RESERVED` state, preventing early release.

### 6. Paystack Webhook Security
- **HMAC Verification**: Paystack signature verification in `paystack.provider.ts` ([paystack.provider.ts](file:///home/whiteghost/LuminaRail/luminarail-backend/src/modules/providers/paystack.provider.ts#L213-L256)) uses HMAC SHA-512 with `crypto.timingSafeEqual`.
- **Deterministic Event IDs**: Generates fallback `evt_pstk_${hash}` when event ID is missing, maintaining idempotency. Protections from MAINNET-04 remain fully intact.

### 7. Refund Amount Integrity
- **Server-Side Derivation**: Refund amounts are validated against `capturedPaymentAmount` from DB `Payment.amount`.
- **Precision**: Uses `@prisma/client/runtime/library` `Decimal`.
- **Cumulative Cap**: `totalAlreadyRefunded + requestedAmount <= capturedPaymentAmount`.

### 8. Database / Schema Audit
- **Schema**: `Refund` model in `schema.prisma` ([schema.prisma](file:///home/whiteghost/LuminaRail/luminarail-backend/prisma/schema.prisma#L322-L358)) includes `@unique` constraint on `idempotencyKey` and appropriate indexes.
- **Migration**: `prisma/migrations/20260909114243_phase8_refund_engine/migration.sql` creates the table structure cleanly.

### 9. Unknown External Result
- **Classification**: Network timeouts across PaystackInit, Verify, Refund, and Soroban Submit are classified as `PROCESSING` or `REQUIRES_RECONCILIATION`, never as explicit failures.

### 10. Admin / Authorization Security
- **Exposure**: `RefundController.createRefund()` ([refunds.controller.ts](file:///home/whiteghost/LuminaRail/luminarail-backend/src/modules/refunds/refunds.controller.ts#L7-L35)) allows any authenticated regular user to initiate refunds on active orders. Self-initiated refunds by users on active/pending orders without admin approval present financial risk.

### 11. Compliance Boundary
- Reviewed `docs/MAINNET_05_COMPLIANCE_BOUNDARY.md`. Technical controls (idempotency, state machines) are properly separated from regulatory/legal obligations (NDPR, CBN fiat guidelines).

### 12. Incident Response
- Reviewed `docs/MAINNET_05_INCIDENT_RESPONSE.md`. Playbooks adequately cover duplicate refunds, ambiguous Paystack responses, and emergency pauses.

### 13. Production Configuration
- Reviewed `docs/MAINNET_05_PRODUCTION_CONFIG_AUDIT.md` & `docs/MAINNET_05_PRODUCTION_READINESS_AUDIT.md`. Environment variable requirements and secret checks are specified.

### 14. Test Quality
- **Coverage Deficit**: Zero tests currently exist for the Refund Engine under `tests/`.

### 15. Financial Invariants
- **Invariant 1**: `total_refunded_ngn <= total_paid_ngn` (Breached under concurrent refund creation without row locking).
- **Invariant 2**: An order CANNOT have both a successful USDC settlement AND a successful NGN refund (Breached when refund is created during `SETTLEMENT_PENDING` while settlement is in-flight).

---

## 4. FINDINGS CLASSIFICATION & REQUIRED REMEDIATIONS

### [CRITICAL-01]: In-Flight Settlement vs. Refund Race Condition (Double Payout Risk)
- **File**: `src/modules/refunds/refunds.service.ts` ([L44-L46](file:///home/whiteghost/LuminaRail/luminarail-backend/src/modules/refunds/refunds.service.ts#L44-L46))
- **Current Behavior**: `createRefund()` only checks `order.status === OrderStatus.COMPLETED || order.status === OrderStatus.SETTLEMENT_COMPLETED`.
- **Risk**: An NGN refund can be issued via Paystack while a Soroban USDC settlement is in-flight on Stellar (`SUBMITTING`, `SUBMITTED`, `CONFIRMING`, `REQUIRES_RECONCILIATION`), causing both fiat refund and on-chain payout to complete.
- **Required Remediation**:
  1. Inspect `order.settlements` in `createRefund()`.
  2. Reject refund creation if any settlement record exists with status `SUBMITTING`, `SUBMITTED`, `CONFIRMING`, `REQUIRES_RECONCILIATION`, or `COMPLETED`.
  3. Only permit refunds if `Order.status` is `FAILED`, `CANCELLED`, `EXPIRED`, `REFUND_FAILED`, or if `Settlement.status` is `FAILED`.

### [HIGH-01]: Missing Database Row Lock in Cumulative Refund Calculation
- **File**: `src/modules/refunds/refunds.service.ts` ([L30-L86](file:///home/whiteghost/LuminaRail/luminarail-backend/src/modules/refunds/refunds.service.ts#L30-L86))
- **Current Behavior**: `existingRefunds` are fetched via standard `prisma.refund.findMany()` without a `FOR UPDATE` transaction lock.
- **Risk**: Parallel `createRefund` calls can execute concurrently, read stale cumulative refund totals, and over-refund the order past `capturedPaymentAmount`.
- **Required Remediation**: Wrap order lookup and cumulative refund validation inside a Prisma transaction block using `SELECT ... FOR UPDATE` on the `Order` / `Payment` row.

### [HIGH-02]: Unrestricted User Self-Initiated Refunds on Active Orders
- **File**: `src/modules/refunds/refunds.controller.ts` ([L7-L35](file:///home/whiteghost/LuminaRail/luminarail-backend/src/modules/refunds/refunds.controller.ts#L7-L35))
- **Current Behavior**: Any authenticated user can call `POST /api/v1/refunds` for an active order.
- **Risk**: Users can trigger refunds on processing orders, causing operational friction and double payout risk.
- **Required Remediation**: Restrict user-initiated refunds to orders in terminal failure states (`FAILED`, `EXPIRED`), or require `ADMIN` / `SUPER_ADMIN` role for manual refund initiation.

### [HIGH-03]: Complete Absence of Refund Unit/Integration Tests
- **File**: `tests/`
- **Current Behavior**: No test files exist for `RefundService`, `RefundStateMachine`, or `RefundController`.
- **Risk**: Unverified state transitions and potential regressions in production.
- **Required Remediation**: Implement a comprehensive test suite in `tests/refunds/refunds.service.test.ts` covering all 15 audit scenarios.

---

## 5. FINAL AUDIT VERDICT

```
==================================================
FINAL VERDICT: PASS WITH REQUIRED FIXES
==================================================
```

The MAINNET-05 / Phase 8 implementation architecture is well-structured and incorporates solid idempotency and webhook security patterns. However, before deployment to production, the 4 identified remediations (**CRITICAL-01**, **HIGH-01**, **HIGH-02**, and **HIGH-03**) MUST be implemented and verified with automated regression tests.

---
*Report generated by Antigravity AI Security Audit Gate.*

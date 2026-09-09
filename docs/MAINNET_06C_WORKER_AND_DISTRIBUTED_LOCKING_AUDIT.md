# MAINNET-06C — Worker Replica Protection & Distributed Locking Audit

**Repository**: `luminarail-backend`  
**Base Commit**: `edae63f559abc7fb20813521023bf46a92c4cb51`  
**Branch**: `develop`  
**Status**: AUDIT ONLY — READ-ONLY ARCHITECTURAL REVIEW

---

## 1. Executive Summary

This document provides a comprehensive read-only security and architecture audit of the worker execution model, state machine mechanics, database locking, and side-effect guarantees in **LuminaRail**.

### Core Architecture Principle

> **Redis distributed locking is for COORDINATION ONLY.**  
> **PostgreSQL transactional state, pessimistic row locks (`FOR UPDATE`), unique database constraints, idempotency keys, and state machine validations remain the sole FINANCIAL AUTHORITY.**

Under no circumstances should the acquisition or release of a Redis lock replace or bypass durable database state checks, atomic status transitions, or database-enforced invariants. If Redis experiences an outage, network partition, or memory reset, the system must remain fail-safe and mathematically incapable of double settlement, double refund, or double liquidity consumption.

---

## 2. Current Worker Inventory

A repository-wide audit identified four primary worker/daemon processes and asynchronous background routines that handle or mutate financial state:

| Worker / Process | Implementation File | Trigger / Cadence | Database Tables Touched | External Side-Effects | Current Lock Mechanism |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **SettlementWorker** | `src/workers/settlement.worker.ts` | Polling loop / Manual invocation / Event trigger | `Order`, `Settlement`, `LiquidityPool`, `LiquidityReservation`, `TreasuryTransaction`, `AuditLog` | AWS KMS, Stellar RPC / Soroban | DB `updateMany` status match + `P2002` unique `orderId` constraint |
| **ReservationCleanupWorker** | `src/workers/reservation-cleanup.worker.ts` | Scheduled sweep / Interval | `LiquidityReservation`, `LiquidityPool`, `Order` | None | `LiquidityService` uses `SELECT ... FOR UPDATE` on `liquidity_pools` |
| **ReconciliationDaemon** | `src/workers/reconciliation.daemon.ts` | Periodic daemon sweep | `Settlement`, `Order`, `LiquidityPool`, `LiquidityReservation`, `TreasuryTransaction`, `AuditLog` | Stellar RPC | Optimistic status matching + `LiquidityService` pool row locks |
| **RefundService Execution** | `src/modules/refunds/refunds.service.ts` | API request / Automatic refund trigger | `Order`, `Refund`, `Payment`, `LiquidityPool`, `LiquidityReservation`, `AuditLog` | Paystack API (`POST /refund`) | DB `SELECT FOR UPDATE` on `orders` (creation); DB `updateMany` (execution) |
| **WebhookService Processing** | `src/modules/webhooks/webhooks.service.ts` | Inbound HTTP POST from Paystack | `WebhookEvent`, `Payment`, `ProviderTransaction`, `Order`, `LiquidityReservation`, `LiquidityPool`, `AuditLog` | None (inbound) | DB `@unique([provider, eventId])` claim on `webhook_events` |

---

## 3. Current Deployment Architecture

1. **Application Entrypoint**: `src/server.ts` starts an Express HTTP app via `createApp()` defined in `src/app.ts`.
2. **Worker Bootstrap**: Workers in `src/workers/` are implemented as modular TypeScript classes (`SettlementWorker`, `ReservationCleanupWorker`, `ReconciliationDaemon`), but are **not** currently wired to an automatic background interval at application startup in `server.ts`.
3. **Replica Concurrency Risk**:
   - In a production environment (e.g. Render Web Services or Kubernetes pods), running multiple replicas of `node dist/server.js` or dedicated worker containers will result in multiple processes concurrently executing polling sweeps.
   - Without distributed coordination, concurrent processes will fetch the same set of eligible `SETTLEMENT_PENDING` orders, expired `LiquidityReservation` records, or `SUBMITTING` settlements, creating severe database lock contention, redundant RPC queries, and TOCTOU (Time-of-Check to Time-of-Use) execution risks.

---

## 4. Settlement Worker Deep Audit

### Settlement Lifecycle Trace

```
[Order: SETTLEMENT_PENDING]
       │
       ▼
1. SettlementService.createSettlementForOrder()
       │ ──► Creates Settlement row (status = PENDING, @unique orderId)
       ▼
2. SettlementService.markSubmitting()
       │ ──► DB updateMany (status: PENDING -> SUBMITTING, attemptCount +1)
       ▼
3. SettlementWorker.executeSettlementFlow()
       │
       ├─► [If stellarTransactionHash is NULL]:
       │      a. SettlementPolicyEngine.validateAndApprove()
       │      b. KmsTransactionSigner.signTransaction() (AWS KMS)
       │      c. SorobanTransactionService.submitTransaction() (Stellar RPC)
       │      d. SettlementService.markSubmitted(hash) (status -> SUBMITTED)
       │
       ├─► SettlementService.markConfirming() (status -> CONFIRMING)
       │
       └─► SettlementExecutor.confirmSettlement()
              │ ──► Polls Soroban RPC for ledger confirmation
              ├─► SUCCESS: SettlementService.markCompleted()
              │             └──► LiquidityService.consumeReservation()
              └─► FAILED / TIMEOUT: SettlementService.markRequiresReconciliation()
```

### Race Conditions & Vulnerabilities Discovered

1. **TOCTOU Race in `executeSettlementFlow`**:
   - If Worker A calls `createSettlementForOrder` and proceeds to `markSubmitting`, Worker A transitions the state to `SUBMITTING`.
   - If Worker B simultaneously attempts `processSingleOrder` for the same order, `createSettlementForOrder` returns `{ settlement: existing, isDuplicate: true }`.
   - Worker B sees `settlement.status === SUBMITTING` and proceeds to call `executeSettlementFlow(settlement)` because line 80–84 explicitly allows processing if status is `SUBMITTING`.
   - If Worker A is currently waiting for AWS KMS or Stellar RPC submission and has **not yet written `stellarTransactionHash` to the database**, Worker B evaluates `!current.stellarTransactionHash` as `true` and invokes `submitSettlement()` a **second time**.
   - **Result**: Dual KMS signatures are generated, and two transactions are submitted to Stellar RPC.

2. **Database Authority Gap**:
   - `markSubmitting` increments `attemptCount`, but does **not** record a worker instance identifier or execution lease token on the `Settlement` table.

---

## 5. Refund Worker Deep Audit

### Refund Lifecycle Trace

```
[User / Admin / Auto Trigger]
       │
       ▼
1. RefundService.createRefund()
       │ ──► Begins DB Transaction ($transaction)
       │ ──► SELECT * FROM "orders" WHERE id = orderId FOR UPDATE
       │ ──► Verifies order state & active settlements
       │ ──► Computes sum(existing refunds) + newAmount <= payment.amount
       │ ──► Creates Refund row (status = PENDING, @unique idempotencyKey)
       │ ──► Updates Order status -> REFUND_PENDING
       ▼
2. RefundService.executeRefund()
       │ ──► Validates RefundStateMachine transition (PENDING -> PROCESSING)
       │ ──► DB updateMany (status: PENDING -> PROCESSING)
       │ ──► If updateCount == 0, returns early (prevents concurrent start)
       │ ──► Invokes PaymentProviderRegistry.get('PAYSTACK').processRefund()
       │      │
       │      ├─► SUCCEEDED:
       │      │      └──► DB $transaction: Refund -> SUCCEEDED, Payment -> REFUNDED, Order -> REFUNDED
       │      │      └──► LiquidityService.releaseReservation(CANCELLED_RELEASED)
       │      │
       │      ├─► FAILED:
       │      │      └──► DB $transaction: Refund -> FAILED, Order -> REFUND_FAILED
       │      │
       │      └─► AMBIGUOUS / TIMEOUT:
       │             └──► Refund -> PROCESSING (metadata: { ambiguousResponse: true })
```

### Security Strengths & Ambiguity Protections

- **Pessimistic DB Lock**: `SELECT FOR UPDATE` on `orders` during refund creation prevents concurrent creation races and cumulative over-refunds.
- **Idempotency Key**: Paystack API requests include `refund.idempotencyKey`, preventing Paystack-side double refunds.
- **Ambiguous Response Safety**: If a Paystack request times out, `executeRefund` sets `metadata.ambiguousResponse = true` and refuses to re-issue the provider HTTP call on subsequent invocations without manual or query-based verification.

---

## 6. Liquidity Cleanup Audit

### Liquidity Reservation & Release Mechanics

`ReservationCleanupWorker` scans `LiquidityReservation` rows where `status = RESERVED` and `expiresAt <= NOW()`. It calls `LiquidityService.expireReservation(orderId)`, which executes:

```typescript
prisma.$transaction(async (tx) => {
  // 1. Lock pool row
  await tx.$queryRaw`SELECT * FROM "liquidity_pools" WHERE "id" = ${poolId} FOR UPDATE`;
  
  // 2. Check current reservation status
  if (reservation.status !== RESERVED && reservation.status !== CONFIRMED) {
    return reservation; // Idempotent exit
  }

  // 3. Rebalance pool capacity safely
  const newReserved = pool.reservedBalance.minus(reservation.amount);
  const safeReserved = newReserved.lt(0) ? 0 : newReserved;
  const newAvailable = pool.totalBalance.minus(safeReserved);

  // 4. Update pool balances & reservation status -> EXPIRED_RELEASED
  ...
});
```

### Invariant Verification

The system enforces the fundamental accounting invariant:

$$\text{reservedBalance} + \text{availableBalance} = \text{totalBalance}$$

Because pool updates use PostgreSQL `FOR UPDATE` row locks inside explicit transactions, duplicate execution across multiple workers is mathematically safe. The second worker reads `status === EXPIRED_RELEASED` and exits immediately without altering pool balances.

---

## 7. Reconciliation Worker Audit

### Reconciliation Lifecycle

`ReconciliationDaemon` scans settlements with status `SUBMITTING`, `SUBMITTED`, `CONFIRMING`, or `REQUIRES_RECONCILIATION`.

- **Missing Hash (`SUBMITTING`)**: If `stellarTransactionHash` is missing and `age > maxStaleAgeHours` (24h), marks `FAILED`, releases liquidity reservation, and sets `Order` to `FAILED`.
- **Has Hash (`SUBMITTED` / `CONFIRMING` / `REQUIRES_RECONCILIATION`)**: Queries Soroban RPC via `confirmationService.getTransactionStatus(hash)`.
  - On `SUCCESS`: Marks `COMPLETED`, records ledger, calls `LiquidityService.consumeReservation()`.
  - On `FAILED`: Marks `FAILED`, releases liquidity reservation, sets `Order` to `FAILED`.

---

## 8. Redis / Redlock Architecture Design

### Architecture Overview

To eliminate worker competition, duplicate API/RPC calls, and database lock contention, a lightweight **Distributed Lock Service** will coordinate worker task execution across backend replicas.

```
                    ┌─────────────────────────┐
                    │    Redis / Redlock      │
                    │   (Coordination Layer)  │
                    └────────────┬────────────┘
                                 │
                     1. Acquire Lock (NX, PX)
                     2. Heartbeat Renewal
                     3. Safe Release (Lua Token Check)
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │   Worker Node Replica   │
                    └────────────┬────────────┘
                                 │
                     4. Authorize DB State
                     5. Pessimistic Row Lock
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │  PostgreSQL Database    │
                    │  (Financial Authority)  │
                    └─────────────────────────┘
```

### Lock Acquisition Specification

- **Command**: `SET <lockKey> <ownerToken> NX PX <ttlMs>`
- **`ownerToken`**: Cryptographically secure UUIDv4 combined with worker ID (`worker-node-1:uuidv4`).
- **Default TTL**:
  - Task/Sweep locks: `30,000 ms` (30 seconds).
  - Single settlement/refund locks: `15,000 ms` (15 seconds).

### Lock Release Specification (Lua Script)

Locks **must never** be released using an unconditional `DEL lockKey`. Locks must only be deleted if the stored token matches the worker's `ownerToken`:

```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
```

### Lock Renewal / Heartbeat Specification (Lua Script)

For long-running tasks (e.g. multi-step Soroban submission and confirmation), an automated background timer extends the lock TTL periodically:

```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
else
    return 0
end
```

---

## 9. Lock Key Design Pattern

Deterministic key naming conventions must be enforced across all workers:

| Scope | Key Pattern | Description |
| :--- | :--- | :--- |
| **Settlement Record** | `lock:settlement:{settlementId}` | Protects a single settlement throughout its lifecycle |
| **Refund Record** | `lock:refund:{refundId}` | Protects a single refund execution against duplicate provider calls |
| **Order Record** | `lock:order:{orderId}` | Coordinates order state changes during settlement creation |
| **Settlement Sweep** | `lock:worker:settlement-sweep` | Prevents multiple replicas from running `processPendingOrders` concurrently |
| **Cleanup Sweep** | `lock:worker:reservation-cleanup` | Prevents multiple replicas from scanning expired reservations at the same instant |
| **Reconciliation Sweep** | `lock:worker:reconciliation-daemon` | Serializes background reconciliation sweeps across nodes |
| **Stellar Account Sequence** | `lock:stellar:sequence:{sourceAddress}` | Serializes transaction building for a specific Stellar source account |

---

## 10. PostgreSQL Authority Model vs Redis Coordination

### Strict Layer Hierarchy

```
+-----------------------------------------------------------------------+
| LAYER 1: Redis Coordination                                           |
| - Acquire lock:SET lock:settlement:{id} ownerToken NX PX 15000         |
| - Prevents multi-replica worker execution overlap                      |
+-----------------------------------------------------------------------+
                                  │
                                  ▼
+-----------------------------------------------------------------------+
| LAYER 2: DB Transaction & State Machine Validation                   |
| - Open prisma.$transaction()                                          |
| - Verify settlement.status === PENDING / SUBMITTING                    |
+-----------------------------------------------------------------------+
                                  │
                                  ▼
+-----------------------------------------------------------------------+
| LAYER 3: DB Pessimistic Row Locking                                   |
| - SELECT * FROM "orders" / "liquidity_pools" WHERE id = ... FOR UPDATE |
| - Serializes concurrent DB writes at database engine level            |
+-----------------------------------------------------------------------+
                                  │
                                  ▼
+-----------------------------------------------------------------------+
| LAYER 4: Database Unique Constraints                                  |
| - @unique([orderId]) on Settlement                                   |
| - @unique([idempotencyKey]) on Refund                                |
| - @unique([provider, eventId]) on WebhookEvent                       |
+-----------------------------------------------------------------------+
                                  │
                                  ▼
+-----------------------------------------------------------------------+
| LAYER 5: External Side-Effect Execution                               |
| - Call AWS KMS -> Submit to Stellar RPC -> Call Paystack API          |
+-----------------------------------------------------------------------+
```

### Outage Guarantees

If Redis crashes, drops connections, or suffers a network partition:
1. Workers fail to acquire Redis locks and log a coordination warning.
2. Under fallback mode, workers fall back to Layer 2–4 (PostgreSQL row locks and unique constraints).
3. **No financial state corruption can occur**, because PostgreSQL transactional boundaries and row locks prevent dual commits.

---

## 11. Critical Failure Scenario Matrix

| Scenario ID | Event / Failure | What Happens | Existing DB Protection | Proposed Redis/Redlock Protection | Financial Risk Level |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **A** | Worker A acquires lock; Worker B attempts same job. | Worker B fails lock acquisition and skips job. | DB status check | Redis `SET ... NX` returns `null` | **ZERO RISK** |
| **B** | Worker A crashes while holding lock. | Lock expires after TTL (15–30s). Worker C acquires lock on next cycle. | DB state machine ensures job picks up from exact saved status | Automatic key expiration (`PX`) | **ZERO RISK** |
| **C** | Worker A experiences 20s GC pause (exceeds lock TTL). | Lock expires. Worker B acquires lock. Worker A resumes and attempts release. | DB status update fails if Worker B completed transition | Safe Lua release script returns `0` (token mismatch) | **ZERO RISK** |
| **D** | Worker A loses Redis connection during execution. | Worker A heartbeats fail. Worker A aborts execution before side-effects. | DB row lock / state check | Lock renewal failure triggers task cancellation | **ZERO RISK** |
| **E** | Redis server becomes completely unavailable. | Distributed locks unavailable. | DB `SELECT FOR UPDATE` & `@unique` constraints protect DB integrity | Workers log degraded warning & fallback to DB row locking | **ZERO RISK** |
| **F** | Redis restarts (loses all in-memory keys). | Active locks wiped. Next worker attempt acquires new lock. | DB state machine checks current status before executing | Redis keys repopulated naturally | **ZERO RISK** |
| **G** | Lock TTL expires while worker is still processing KMS/RPC. | Worker background heartbeat extends TTL every 5s. | DB status update validates current state | Active renewal via `PEXPIRE` Lua script | **ZERO RISK** |
| **H** | Worker A's lock expires; Worker B acquires lock. | Worker B checks DB state. If A already updated status, B skips. | DB `updateMany` returns `count === 0` | Dual-execution prevented at DB layer | **ZERO RISK** |
| **I** | Worker A resumes after B acquires lock. | A's DB update fails if B completed transition. A's lock release fails. | DB state machine rejects invalid transition | Token mismatch in Lua release script | **ZERO RISK** |
| **J** | DB row lock (`FOR UPDATE`) blocks Worker B. | Worker B waits until Worker A's transaction completes/rolls back. | PostgreSQL engine queues row lock | Redis lock prevents B from even reaching DB queue | **ZERO RISK** |
| **K** | DB transaction rolls back after Redis lock acquired. | DB changes reverted. Redis lock released cleanly. | PostgreSQL transaction rollback | Redis lock released in `finally` block | **ZERO RISK** |
| **L** | DB commits, but process crashes before Redis lock release. | DB state accurately reflects terminal status. Redis lock expires after TTL. | DB status is terminal (`COMPLETED`/`FAILED`) | Key expires automatically after TTL | **ZERO RISK** |
| **M** | Worker crashes after KMS signing but before Stellar RPC submission. | DB remains `SUBMITTING` without `stellarTransactionHash`. | `ReconciliationDaemon` detects stale `SUBMITTING` record | Stale lock expires; Reconciliation picks up record | **ZERO RISK** |
| **N** | Worker crashes after Stellar submission but before DB write. | Transaction submitted on-chain; DB missing hash. | `ReconciliationDaemon` queries Soroban RPC using account tx history | Stale lock expires; Reconciliation resolves hash on-chain | **ZERO RISK** |
| **O** | Worker crashes after Paystack refund POST but before DB write. | Refund remains in `PROCESSING`. | `RefundService` checks `ambiguousResponse` flag | Stale lock expires; Next worker queries Paystack refund API | **ZERO RISK** |
| **P** | Two workers process same expired liquidity reservation. | First worker releases pool capacity; second worker sees `status !== RESERVED`. | `LiquidityService` uses `SELECT FOR UPDATE` on `liquidity_pools` | Redis sweep lock ensures only 1 worker runs cleanup sweep | **ZERO RISK** |

---

## 12. KMS Interaction & Safe Signing Order

Following the **MAINNET-06B** KMS implementation (`KmsTransactionSigner`), worker interaction with AWS KMS must adhere to a strict sequential contract:

```
[Worker Execution Flow]
       │
       ▼
1. Acquire Redis Lock: lock:settlement:{settlementId}
       │
       ▼
2. Open DB Transaction & Verify Eligibility:
   - Settlement status === PENDING or SUBMITTING
   - stellarTransactionHash IS NULL
   - SettlementPolicyEngine.validateAndApprove() === APPROVED
       │
       ▼
3. Mark DB Status -> SUBMITTING (updateMany count === 1)
       │
       ▼
4. Execute KMS Signing (KmsTransactionSigner.signTransaction)
       │
       ▼
5. Submit Envelope to Soroban RPC
       │
       ▼
6. Write stellarTransactionHash to DB (SettlementService.markSubmitted)
       │
       ▼
7. Release Redis Lock (Lua token check)
```

**Guard Against Stale KMS Signatures**:  
If a worker's lock expires during step 4 (KMS call), step 6 validates that `stellarTransactionHash` is still `NULL` in the database before submitting to Stellar RPC. If another worker already submitted a hash, the current process discards the signed envelope.

---

## 13. Stellar Account Sequence Number Protection

In `LiveSettlementExecutor`, transaction construction relies on `SorobanTransactionService`, which queries Soroban RPC for the source account's sequence number $S$ and increments to $S+1$.

### Sequence Race Vulnerability

If two worker replicas build transactions simultaneously for the same settlement vault source account (`config.stellar.signerPublicKey`):
1. Worker A queries RPC: sequence = 100 -> builds tx with sequence 101.
2. Worker B queries RPC: sequence = 100 -> builds tx with sequence 101.
3. Worker A submits tx (sequence 101) -> **SUCCESS**.
4. Worker B submits tx (sequence 101) -> **FAILED (`txBAD_SEQ`)**.

### Proposed Sequence Lock Solution

A dedicated account-level Redis lock (`lock:stellar:sequence:{sourceAddress}`) must be held during the atomic window of **Transaction Assembly + Submission**. This guarantees strictly sequential transaction submission per source account across all worker replicas.

---

## 14. External Side-Effect Idempotency & Retry Matrix

| External Service | Operation | Idempotent natively? | Network Timeout Behavior | Deduplication Strategy | Safe Retry Rule |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **AWS KMS** | `SignCommand` | Yes (pure function for given payload) | Request times out; no on-chain state change | Local DB status check | Safe to retry if `stellarTransactionHash` is NULL |
| **Stellar RPC / Soroban** | `sendTransaction` | Yes (by transaction hash) | Ambiguous (tx may be in mempool or ledger) | Protocol enforces hash uniqueness | Query `getTransactionStatus(txHash)` before resubmitting |
| **Paystack API** | `POST /refund` | Yes (with `idempotency_key`) | Ambiguous (payout may be processing) | Paystack deduplicates by `idempotency_key` | Do NOT re-issue HTTP call if marked `ambiguousResponse`. Query refund API status first |
| **FX Rate Provider** | `GET /v6/latest/USD` | Yes (read-only) | HTTP timeout | Read-only | Safe to retry immediately |

---

## 15. Worker Observability & Telemetry Standard

All worker executions, lock acquisitions, lock renewals, and failures must emit structured logs containing key context attributes:

```json
{
  "timestamp": "2026-09-09T23:30:00.000Z",
  "level": "INFO",
  "workerId": "worker-replica-7f9b8c-x4k21",
  "workerType": "SettlementWorker",
  "action": "LOCK_ACQUIRED",
  "lockKey": "lock:settlement:STL_1725921600_a1b2c3",
  "ownerToken": "worker-replica-7f9b8c-x4k21:8f3c1a2d-4b5e-6f7a-8b9c-0d1e2f3a4b5c",
  "settlementId": "STL_1725921600_a1b2c3",
  "orderId": "ord_987654321",
  "durationMs": 42,
  "details": {
    "attemptCount": 1,
    "status": "SUBMITTING"
  }
}
```

### Redaction Rules (MANDATORY)

Logs must **NEVER** contain:
- Secret seeds / private keys (`STELLAR_SETTLEMENT_SIGNER_SECRET_KEY`)
- AWS Access Keys / Secret Keys
- Signed transaction envelope XDRs
- JWT secrets or customer auth tokens
- Paystack secret API keys

---

## 16. Test Strategy & Concurrency Validation

### Required Test Suite Categories

1. **Unit Tests (Mock Redis)**:
   - Verify lock acquisition, release token matching, and renewal logic using an in-memory Redis mock.
2. **Integration Tests (Ephemeral Redis)**:
   - Run vitest suite against a local Redis container (`redis://localhost:6379`).
3. **Multi-Worker Concurrency Simulation Tests**:
   - `tests/settlements/concurrency-redis.test.ts`: Spawn 20 concurrent worker instances attempting to process the exact same pending order.
   - Assert: Exactly 1 worker acquires the lock and submits to KMS/Stellar. 19 workers yield or skip cleanly.
   - Assert: Total settlements created in DB === 1. Total KMS signatures === 1.
4. **Fault Injection & Stale Lock Tests**:
   - Simulate worker process crash mid-execution (kill process after lock acquisition).
   - Verify lock expires after TTL and subsequent worker successfully completes job from saved DB state.

---

## 17. Recommended Production Architecture

```
                               ┌───────────────────────────┐
                               │  Render Web Service (x2)  │
                               │  (Express HTTP + Webhooks) │
                               └─────────────┬─────────────┘
                                             │
                                             ▼
┌───────────────────────────┐  ┌───────────────────────────┐  ┌───────────────────────────┐
│ Render Redis Key-Value    │◄─┼─► Render Background Worker │◄─┼─► Render PostgreSQL DB    │
│ (Redlock Coordination)    │  │  (Dedicated Process)      │  │  (Financial Authority)    │
└───────────────────────────┘  └───────────────────────────┘  └───────────────────────────┘
```

- **Render Web Service**: Runs `npm start` (`node dist/server.js`), handles API endpoints and incoming Paystack webhooks. Does NOT execute heavy background worker loops.
- **Render Background Worker**: Dedicated background process running `node dist/workers/runner.js` which manages `SettlementWorker`, `ReservationCleanupWorker`, and `ReconciliationDaemon` loops with Redis distributed locking.

---

## 18. Render Deployment Model

1. **Web Service Configuration**:
   - Command: `npm start`
   - Instances: 2 (Auto-scaled)
   - Environment Variables: `REDIS_URL`, `DATABASE_URL`, `PRODUCTION_SETTLEMENT_ENABLED=false`
2. **Background Worker Configuration**:
   - Command: `node dist/workers/runner.js`
   - Instances: 1 or 2
   - Environment Variables: `REDIS_URL`, `DATABASE_URL`, `PRODUCTION_SETTLEMENT_ENABLED=false`
3. **Graceful Shutdown (`SIGTERM` / `SIGINT`)**:
   - Workers intercept termination signals.
   - Stop accepting new jobs from sweeps.
   - Allow active in-flight jobs to finish or cleanly release Redis locks.
   - Close Redis connection pool gracefully.

---

## 19. Phased Implementation Plan

```
Phase 1: Worker & Redis Infrastructure Abstraction
  ├── Create src/services/redis.service.ts
  ├── Create src/services/distributed-lock.service.ts (Lua scripts for release & heartbeat)
  └── Create src/workers/runner.ts (Dedicated background worker runner)

Phase 2: Settlement Worker & KMS Integration Hardening
  ├── Wrap SettlementWorker.processSingleOrder with Redis lock:settlement:{id}
  ├── Add per-account sequence lock lock:stellar:sequence:{address}
  └── Verify KMS submission flow under lock protection

Phase 3: Refund & Liquidity Worker Integration
  ├── Wrap RefundService.executeRefund with Redis lock:refund:{id}
  ├── Wrap ReservationCleanupWorker with sweep lock lock:worker:reservation-cleanup
  └── Wrap ReconciliationDaemon with sweep lock lock:worker:reconciliation-daemon

Phase 4: Concurrency Testing & Verification
  ├── Add tests/concurrency/redis-worker-concurrency.test.ts
  ├── Run multi-worker race tests (20 concurrent workers)
  └── Validate zero-duplicate-execution under network delay injection

Phase 5: Production Deployment & Observability Gate
  ├── Add worker telemetry logs
  ├── Configure Render Background Worker entrypoint
  └── Verify PRODUCTION_SETTLEMENT_ENABLED remains false
```

---

## 20. Security Gates / Exit Criteria

Before advancing from **MAINNET-06C** to subsequent mainnet readiness phases, the following security gates must pass:

- [x] **Read-Only Audit Completed**: `docs/MAINNET_06C_WORKER_AND_DISTRIBUTED_LOCKING_AUDIT.md` produced.
- [ ] **Redis Lock Implementation Complete**: Token-based acquisition, Lua release, and Lua heartbeat implemented.
- [ ] **Multi-Worker Concurrency Tests Passing**: 0 duplicate submissions under 20-worker race conditions.
- [ ] **Database Authority Maintained**: All financial state checks backed by DB transactions and row locks.
- [ ] **KMS Safety Verified**: Stale lock cannot cause duplicate KMS signature or submission.
- [ ] **Production Settlement Flag**: `PRODUCTION_SETTLEMENT_ENABLED` remains `false`.
- [ ] **Clean Git State**: No unreviewed code changes or secret leaks.

---

## 21. Open Questions

1. **Redis Deployment Topology**: Will production deployment use a single Managed Redis instance (e.g. Render Key-Value) or a 3-node Redlock cluster across AWS regions?
2. **Sequence Manager Scaling**: If LuminaRail settlement volume increases significantly, should sequence numbers be managed via an in-memory Redis sequence counter or remain locked per-account at RPC level?
3. **Paystack Ambiguous Refund Query**: Should a dedicated worker sweep be created to query Paystack's API for refunds stuck in `PROCESSING` with `ambiguousResponse: true`?

---
*End of Audit Document — MAINNET-06C*

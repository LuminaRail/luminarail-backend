# MAINNET-08A Implementation Report: Dedicated Worker Entrypoint & Render Blueprint

## Executive Summary

MAINNET-08A separates the HTTP API process (`src/server.ts`) from background financial processing daemons by establishing a dedicated worker process (`src/worker.ts`) and a Render Infrastructure-as-Code blueprint (`render.yaml`).

### Explicit Constraints & Non-Actions
> [!IMPORTANT]
> - 08A does **NOT** provision production infrastructure.
> - 08A does **NOT** activate Paystack Live.
> - 08A does **NOT** deploy mainnet contracts.
> - 08A does **NOT** fund the treasury.
> - 08A does **NOT** execute a canary.
> - 08A does **NOT** inject or commit production secrets.

---

## 1. Process Separation Architecture

Prior to MAINNET-08A, background workers operated within or alongside API execution contexts. MAINNET-08A introduces process isolation:

```
                  +--------------------------+
                  |  Render Platform / Cloud |
                  +------------+-------------+
                               |
         +---------------------+---------------------+
         |                                           |
         v                                           v
+------------------+                       +-------------------+
|  luminarail-api  |                       | luminarail-worker |
|    (Web API)     |                       | (Background Worker|
|  src/server.ts   |                       |   src/worker.ts)  |
+--------+---------+                       +---------+---------+
         |                                           |
         |         +-----------------------+         |
         +-------->| PostgreSQL (Database) |<--------+
         |         +-----------------------+         |
         |                                           |
         |         +-----------------------+         |
         +-------->|   Redis (Locking)     |<--------+
                   +-----------------------+
```

1. **Web API Process (`luminarail-api`)**:
   - Entrypoint: `src/server.ts` -> `src/app.ts`
   - Command: `npm start` (`node dist/server.js`)
   - Binds to HTTP `PORT` and exposes REST endpoints and `/health`.

2. **Background Worker Process (`luminarail-worker`)**:
   - Entrypoint: `src/worker.ts`
   - Command: `npm run start:worker` (`node dist/worker.js`)
   - **Exposes NO HTTP port**.
   - Executes background financial polling loops:
     - `SettlementWorker.processPendingOrders()`
     - `ReservationCleanupWorker.processExpiredReservations()`
     - `ReconciliationDaemon.processPaymentReconciliation()`
     - `ReconciliationDaemon.processReconciliation()`

---

## 2. Dedicated Worker Entrypoint (`src/worker.ts`)

`src/worker.ts` initializes existing application infrastructure safely without duplicating Prisma or Redis connections.

### Key Implementation Details:
- **Startup Safety Enforcement**:
  - `assertProductionSettlementSafety()`: Asserts that production settlement requirements, mainnet USDC issuer, live Paystack key requirements, and KMS configuration pass.
  - `assertContractGovernanceReadiness()`: Enforces that smart contract governance is `multisig` or `dao` (prohibiting single key admin in production).
  - If configuration is invalid, startup immediately throws and halts (fail-closed architecture).
- **Telemetry**:
  - Emits safe structured audit log `WORKER_STARTED` containing environment, worker PID, enabled components, and network settings. Zero secrets logged.
- **Error Handling**:
  - Exceptions inside `runSweep()` loops log `WORKER_LOOP_ERROR` telemetry and preserve financial safety without silently bypassing security checks.

---

## 3. Worker Lifecycle & Shutdown Behavior

The background worker reuses `ShutdownManager` from MAINNET-06C:

1. **Signal Catching**: Registers listeners for `SIGTERM` and `SIGINT`.
2. **In-Flight Task Protection**: `ShutdownManager.incrementActiveJobs()` and `decrementActiveJobs()` track active sweep execution.
3. **Graceful Drain**: Upon receiving a termination signal, `ShutdownManager.isShuttingDown()` returns `true`, preventing new sweeps. Active sweeps are given time to complete cleanly.
4. **Connection Release**: Redis client connection and Prisma database connection are cleanly disconnected before exit (`0` status code).

---

## 4. Render Blueprint Specification (`render.yaml`)

`render.yaml` defines the declarative production service topology:

- **Services**:
  - `luminarail-api` (`type: web`): Runs API web server. Health check at `/health`.
  - `luminarail-worker` (`type: worker`): Dedicated background worker service running `npm run start:worker`.
- **Database**:
  - `luminarail-db` (`type: postgres`): Managed PostgreSQL database linked via `DATABASE_URL`.
- **Zero Secrets In Blueprint**:
  - Sensitive variables (`STELLAR_KMS_KEY_ARN`, `PAYSTACK_SECRET_KEY`, `JWT_SECRET`, etc.) specify `sync: false` to enforce external injection from Render's secure secret manager.

---

## 5. Required Environment Variables

| Variable | Required By | Description / Safety Constraint |
|---|---|---|
| `NODE_ENV` | Both | `production` / `staging` / `development` |
| `DATABASE_URL` | Both | PostgreSQL connection string |
| `REDIS_URL` | Both | Redis connection string for distributed locks |
| `STELLAR_NETWORK` | Both | `public` for mainnet, `testnet` for testing |
| `STELLAR_USDC_ISSUER` | Both | Must match Circle Mainnet USDC Issuer (`GA5Z...4KZVN`) |
| `STELLAR_USDC_CONTRACT_ID` | Both | Soroban SAC contract ID |
| `STELLAR_HORIZON_URL` | Both | Stellar Horizon RPC endpoint |
| `STELLAR_SOROBAN_RPC_URL` | Both | Soroban RPC endpoint |
| `STELLAR_SIGNER_PROVIDER` | Both | `aws_kms` for production |
| `STELLAR_KMS_KEY_ARN` | Both | AWS KMS Key ARN for transaction signing |
| `STELLAR_SETTLEMENT_SIGNER_PUBLIC_KEY` | Both | Stellar G-address of the KMS signer |
| `STELLAR_CONTRACT_ADMIN_GOVERNANCE_TYPE` | Both | Must be `multisig` in production |
| `STELLAR_CONTRACT_ADMIN_ADDRESS` | Both | Multisig address for contract admin |
| `NGN_PROVIDER` | Both | `paystack` |
| `PAYSTACK_SECRET_KEY` | Both | Live key `sk_live_...` for production |
| `JWT_SECRET` | API | Secret key for JWT verification |
| `PORT` | API | HTTP listening port (Default: `3000`) |
| `PRODUCTION_SETTLEMENT_ENABLED` | Both | Must be `true` for mainnet execution |
| `REQUIRE_DISTRIBUTED_LOCKS` | Both | Must be `true` in production |
| `STELLAR_DISTRIBUTED_LOCK_FAIL_CLOSED` | Both | Must be `true` in production |

---

## 6. Distributed Lock Dependency

Worker replica protection is guaranteed by `MAINNET-06C` distributed locks:
- Sweep locks (`lock:worker:reconciliation-daemon`, `lock:worker:payment-reconciliation`, etc.) ensure only one worker replica executes a specific sweep at any time.
- State re-verification in PostgreSQL and KMS token ownership checks prevent race conditions even when scaling worker replicas.

---

## 7. Deployment Prerequisites

Before deploying to production on Render:
1. Provision PostgreSQL (`luminarail-db`) and Redis instances.
2. Inject production secrets in Render dashboard for `luminarail-api` and `luminarail-worker`.
3. Run database migrations (`npm run db:migrate`).
4. Verify KMS permissions and multisig admin address configuration.

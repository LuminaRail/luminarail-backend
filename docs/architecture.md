# LuminaRail Backend — System Architecture

This document details the architectural design, module boundaries, data flows, state machines, and security isolation mechanisms implemented in `luminarail-backend`.

---

## 1. Domain Module Boundaries

The backend uses a **Modular Monolith** structure located under `src/modules/`:

```
src/modules/
├── auth/          # Registration, login authentication & JWT generation
├── users/         # Profile retrieval (/users/me)
├── wallets/       # Non-custodial Stellar wallet address registration & validation
├── quotes/        # FX rates calculation (MockQuoteProvider & RealFxQuoteProvider)
├── orders/        # Order creation, state management, Idempotency-Key deduplication
├── payments/      # Payment engine, state machine, provider interface
├── providers/     # Vendor-agnostic IPaymentProvider implementations
├── webhooks/      # Webhook ingestion, signature validation & event deduplication
├── settlements/   # Settlement status tracking & admin queries
├── transactions/  # Audit-tracked transaction ledger
├── audit/         # Redacted audit logging engine
└── merchants/     # Merchant settings management
```

### High-Level Component Interactions

```
  ┌─────────────────────────────────────────────────────────┐
  │                   HTTP API Clients                      │
  └────────────────────────────┬────────────────────────────┘
                               │
                               ▼
  ┌─────────────────────────────────────────────────────────┐
  │                 Express API & Middleware                │
  │    (JWT Auth, RBAC, Zod Validation, Rate Limiter)       │
  └────────────────────────────┬────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
  ┌───────────────────┐                 ┌───────────────────┐
  │  Payment Engine   │                 │   Stellar Gateway │
  │ (IPaymentProvider)│                 │   (src/stellar/)  │
  └─────────┬─────────┘                 └─────────┬─────────┘
            │                                     │
            ▼                                     ▼
  ┌───────────────────┐                 ┌───────────────────┐
  │ PostgreSQL /      │                 │ Soroban Testnet   │
  │ Prisma ORM        │                 │ Smart Contracts   │
  └───────────────────┘                 └───────────────────┘
```

---

## 2. Idempotency Architecture

Financial mutations (`POST /api/v1/orders`, `POST /api/v1/payments`) require an `Idempotency-Key` HTTP request header:

1. **Request Reception**: The idempotency middleware checks whether the provided key exists in the database for the given tenant/user.
2. **Cache Hit**: If a prior response exists, the previous result is immediately returned without re-executing logic.
3. **Execution**: If new, execution proceeds, and the outcome is atomically persisted with the idempotency key upon completion.
4. **Webhook Deduplication**: Webhooks (`POST /api/v1/webhooks/:provider`) store incoming event IDs in the `WebhookEvent` model to prevent duplicate webhook processing.

---

## 3. Monetary Precision Strategy

JavaScript `Number` types use IEEE 754 floating-point math, introducing rounding errors (e.g., `0.1 + 0.2 = 0.30000000000000004`). 

To preserve precision across financial calculations:
- Database schema defines currency values using PostgreSQL `@db.Decimal(18, 4)`.
- Application logic manipulates monetary values using string representations and Prisma `Decimal` instances.
- Floating-point calculations are strictly forbidden in financial transaction pipelines.

---

## 4. Stellar Gateway (`src/stellar/`)

All interactions with the Stellar network are encapsulated within `src/stellar/`:

- **`config/`**: Network assertions ensuring execution takes place on Stellar Testnet (`STELLAR_NETWORK=testnet`).
- **`horizon/`**: Wrapper for Horizon RPC account and transaction lookups.
- **`soroban/`**: Client wrapper for Soroban RPC interaction, transaction simulation, and contract execution (`SorobanSettlementExecutor`).
- **`accounts/`**: Address format validation ensuring Stellar public keys start with `G` and conform to ed25519 strkey encoding.
- **`balances/`**: Normalizes asset balances (USDC, XLM) with string precision.

---

## 5. Settlement Engine & Worker

The `SettlementWorker` is a background process (`src/workers/settlement.worker.ts`) that polls `PENDING` settlement records:

1. **Claiming**: Selects pending settlements and updates status to `SUBMITTING`.
2. **Simulation**: Simulates Soroban smart contract calls via Soroban RPC (`simulateTransaction`).
3. **Submission**: Signs the transaction with `STELLAR_SETTLEMENT_SIGNER_SECRET_KEY` and submits it to Soroban RPC (`sendTransaction`).
4. **Finality Polling**: Continuously queries transaction state (`getTransaction`) until on-chain inclusion or failure.
5. **State Transition**: Updates `Settlement` and corresponding `Order` status to `COMPLETED` upon confirmation, or `REQUIRES_RECONCILIATION` if RPC timeout occurs.

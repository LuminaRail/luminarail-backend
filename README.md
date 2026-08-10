# LuminaRail Backend (`luminarail-backend`)

> **"Open financial rails for Stellar."**

`luminarail-backend` is the core settlement engine and API layer of LuminaRail. It provides a modular settlement infrastructure connecting local payment rails (starting with Nigeria NGN) to Stellar network assets (USDC).

---

## High-Level Architecture

The backend is built as a **Modular Monolith** using Node.js, Express, TypeScript, Prisma ORM, PostgreSQL, and `@stellar/stellar-sdk`.

```
src/
├── app.ts            # Express application setup, middleware, health endpoint
├── server.ts         # Application entry point
├── config/           # Centralized configuration & Zod startup environment validation
├── db/               # PrismaClient database connection singleton
├── errors/           # Standardized error definitions (AppError, PaymentError, StellarError, etc.)
├── middleware/       # JWT Authentication, RBAC, Validation, Error Handling
├── modules/          # Clean domain module boundaries
│   ├── auth/         # JWT Register, Login, Logout
│   ├── users/        # User profile management (/users/me)
│   ├── wallets/      # Non-custodial Stellar wallet management & address validation
│   ├── quotes/       # FX exchange rates & deterministic mock quote engine
│   ├── orders/       # Order creation, state machine & Idempotency-Key handling
│   ├── payments/     # Payment creation, retrieval, verification & state machine
│   ├── providers/    # Vendor-agnostic IPaymentProvider & MockPaymentProvider
│   ├── webhooks/     # Webhook signature verification, idempotency & event processing
│   ├── transactions/ # Application-level transaction tracking
│   └── audit/        # Sensitive-redacted audit log recording & admin lookup
└── stellar/          # Stellar Integration Layer (Stellar Gateway)
    ├── config/       # Stellar network config & testnet safety assertions
    ├── horizon/      # Dedicated Horizon RPC client
    ├── soroban/      # Dedicated Soroban RPC client
    ├── accounts/     # Non-custodial account service & address validation
    ├── assets/       # Asset service, allowlisting & normalization
    ├── balances/     # Balance normalization with string precision
    ├── transactions/ # Transaction lookup & normalization
    ├── cache/        # Pluggable cache abstraction (memory / Redis)
    └── routes/       # Read-only Stellar API endpoints (/api/v1/stellar/*)
```

### Architectural Safeguards

1. **Payment Provider Abstraction**: Core domains depend strictly on the vendor-agnostic `IPaymentProvider` abstraction. Vendor-specific response formats are never leaked.
2. **Deterministic Sandbox Provider**: Phase 3 operates exclusively on `MockPaymentProvider` (no real payment API credentials, real NGN processing, or live settlement).
3. **Stellar Gateway Boundary**: Application modules communicate with Stellar exclusively via `src/stellar/` services.
4. **Idempotency**: Financial requests (`POST /api/v1/orders`, `POST /api/v1/payments`, `POST /api/v1/webhooks/:provider`) support server-side `Idempotency-Key` and `WebhookEvent` database deduplication.
5. **Non-Custodial Model**: Private keys, secret seeds (`S...`), card numbers, CVVs, and provider secrets are strictly forbidden across all HTTP boundaries.
6. **Monetary Precision**: All financial amounts use string/decimal representations to eliminate JavaScript floating-point rounding errors.

---

## Local Development Setup

### 1. Prerequisites
- Node.js >= 20.x
- Docker & Docker Compose

### 2. Quick Start for New Developers

```bash
# Clone & navigate to backend directory
cd luminarail-backend

# Install dependencies
npm install

# Copy environment variable configuration template
cp .env.example .env

# Start local PostgreSQL database container
docker compose up -d

# Generate Prisma Client
npm run db:generate

# Apply database migrations
npx prisma migrate dev

# Start development server
npm run dev
```

The API will be available at `http://localhost:4000/api/v1`.

---

## PostgreSQL & Database Migrations

Local database services are managed via Docker Compose (`docker-compose.yml`):

```bash
# Start PostgreSQL container
docker compose up -d

# Stop PostgreSQL container
docker compose down

# Validate Prisma schema syntax
npx prisma validate

# Generate Prisma client bindings
npx prisma generate

# Create and apply new migrations locally
npx prisma migrate dev --name <migration_name>

# Deploy migrations in non-interactive CI/CD
npx prisma migrate deploy

# Check migration status
npx prisma migrate status
```

---

## API Endpoint Structure (`/api/v1`)

| Module | Method | Endpoint | Description | Auth Required |
|---|---|---|---|---|
| **Health** | `GET` | `/health` | Service & Stellar Testnet health status | No |
| **Auth** | `POST` | `/api/v1/auth/register` | User registration | No |
| **Auth** | `POST` | `/api/v1/auth/login` | Authenticate user & return JWT | No |
| **Auth** | `POST` | `/api/v1/auth/logout` | End user session | No |
| **Users** | `GET` | `/api/v1/users/me` | Current authenticated user profile | Yes |
| **Wallets** | `POST` | `/api/v1/wallets` | Register Stellar wallet public key | Yes |
| **Wallets** | `GET` | `/api/v1/wallets` | List user wallets | Yes |
| **Wallets** | `DELETE` | `/api/v1/wallets/:id` | Delete user wallet | Yes |
| **Quotes** | `POST` / `GET` | `/api/v1/quotes` | Generate FX quote & fee calculation | Optional |
| **Quotes** | `GET` | `/api/v1/quotes/:id` | Fetch quote details | Optional |
| **Orders** | `POST` | `/api/v1/orders` | Create order (with `Idempotency-Key`) | Yes |
| **Orders** | `GET` | `/api/v1/orders` | List user orders | Yes |
| **Orders** | `GET` | `/api/v1/orders/:id` | Get order details | Yes |
| **Payments** | `POST` | `/api/v1/payments` | Create payment (with `Idempotency-Key`) | Yes |
| **Payments** | `GET` | `/api/v1/payments/:id` | Get payment details | Yes |
| **Payments** | `POST` | `/api/v1/payments/:id/verify` | Verify payment status with provider | Yes |
| **Webhooks** | `POST` | `/api/v1/webhooks/:provider` | Provider webhook endpoint (Signature & Idempotency) | Signature Header |
| **Transactions** | `GET` | `/api/v1/transactions` | Query user transactions | Yes |
| **Transactions** | `GET` | `/api/v1/transactions/:id` | Get transaction details | Yes |
| **Audit** | `GET` | `/api/v1/audit` | Query audit logs | Admin / SuperAdmin |
| **Settlements** | `GET` | `/api/v1/settlements` | List pending settlements | Admin / SuperAdmin |
| **Settlements** | `GET` | `/api/v1/settlements/:id` | Get settlement details | Yes |
| **Settlements** | `GET` | `/api/v1/settlements/order/:orderId` | Get settlement by order ID | Yes |
| **Stellar** | `GET` | `/api/v1/stellar/accounts/:address` | Normalized Stellar account lookup | No |
| **Stellar** | `GET` | `/api/v1/stellar/accounts/:address/balances` | Normalized Stellar account balances | No |
| **Stellar** | `GET` | `/api/v1/stellar/transactions/:hash` | Normalized Stellar transaction lookup | No |

---

## Phase 5A — Settlement Engine Foundation

### Overview & Security Constraints
> **Note on Phase 5A**: Live Soroban transaction submission, transaction signing, and secret key custody are **NOT implemented** in Phase 5A. The settlement engine creates durable database records, enforces state transitions, and halts cleanly before live on-chain submission.

- **Network Scope**: Stellar Testnet ONLY.
- **Non-Custodial Enforcement**: Secret keys, seed phrases (`S...`), and private key signing remain strictly forbidden.
- **On-Chain Submission Status**: Live Soroban transaction submission is disabled in Phase 5A.
- **Monetary Safety**: Settlement amounts are derived server-side from `Order` / `Quote` records. Untrusted user inputs for amounts are strictly rejected.

### Database Model (`Settlement`)

```prisma
model Settlement {
  id                     String           @id @default(uuid())
  settlementId           String           @unique @map("settlement_id")
  orderId                String           @unique @map("order_id")
  userId                 String           @map("user_id")
  status                 SettlementStatus @default(PENDING)
  asset                  String           @map("asset")
  amount                 Decimal          @db.Decimal(18, 4)
  source                 String?          @map("source")
  destination            String?          @map("destination")
  contractAddress        String?          @map("contract_address")
  stellarTransactionHash String?          @map("stellar_transaction_hash")
  stellarLedger          Int?             @map("stellar_ledger")
  attemptCount           Int              @default(0) @map("attempt_count")
  lastError              String?          @map("last_error")
  submittedAt            DateTime?        @map("submitted_at")
  confirmedAt            DateTime?        @map("confirmed_at")
  createdAt              DateTime         @default(now()) @map("created_at")
  updatedAt              DateTime         @updatedAt @map("updated_at")
}
```

### Settlement State Machine

```
PENDING
  ├──> SUBMITTING
  └──> FAILED

SUBMITTING
  ├──> SUBMITTED
  ├──> FAILED
  └──> REQUIRES_RECONCILIATION

SUBMITTED
  ├──> CONFIRMING
  └──> REQUIRES_RECONCILIATION

CONFIRMING
  ├──> COMPLETED
  └──> REQUIRES_RECONCILIATION

COMPLETED (terminal)
FAILED (terminal)
REQUIRES_RECONCILIATION (terminal for current phase)
```

### Settlement Lifecycle & Worker Responsibilities

1. **Order State Check**: Settlement creation only accepts orders in `OrderStatus.SETTLEMENT_PENDING`. Any other state is rejected (`InvalidOrderStateForSettlementError`).
2. **Idempotent Claiming**: Concurrent creation requests for the same order are guarded by PostgreSQL unique index on `order_id` and Prisma `P2002` error handling.
3. **Worker Processing (`src/workers/settlement.worker.ts`)**:
   - Queries `SETTLEMENT_PENDING` orders.
   - Atomically claims the order and creates a `Settlement` record in `PENDING` status.
   - Transitions settlement to `SUBMITTING`.
   - Halts prior to live Stellar network submission.
4. **Stellar Integration Boundary (`SettlementExecutor`)**:
   - Abstracts Stellar operations via `SettlementExecutor` interface (`submitSettlement`, `getSettlementStatus`, `confirmSettlement`).
   - Uses `MockSettlementExecutor` for test environment boundaries.

---

---

## Authentication & Security

- **Password Hashing**: Passwords are hashed using `bcrypt` with cost factor 10. Plaintext passwords are never logged or stored.
- **JWT Authentication**: Secured using `Authorization: Bearer <token>`.
- **Role-Based Access Control (RBAC)**: Support for `USER`, `MERCHANT`, `ADMIN`, `SUPER_ADMIN`.
- **Non-Custodial Security**: Secret keys (`S...`), seed phrases, card details, CVVs, and provider secrets are strictly rejected across all endpoints.
- **Security Headers & Rate Limiting**: Enforced via `helmet` and `express-rate-limit`.
- **Sensitive Data Redaction**: Audit logs automatically redact sensitive fields (`password`, `token`, `secret`, `privateKey`, etc.).

---

## Testing & Quality

```bash
# TypeScript type check
npm run type-check

# ESLint linting
npm run lint

# Build production bundle
npm run build

# Run Vitest test suite
npm test
```

---

## License

[MIT License](./LICENSE)
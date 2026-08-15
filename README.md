# LuminaRail Backend (`luminarail-backend`)

> **Open financial rails for Stellar.**

`luminarail-backend` is the core modular settlement engine and API service for LuminaRail. It provides a settlement infrastructure connecting local payment rails (such as Nigerian NGN fiat processing) to Stellar network assets (USDC) with automated on-chain Soroban settlement execution.

---

## Overview

### What the Project Does
`luminarail-backend` serves as the backend infrastructure for LuminaRail. It manages user authentication, wallet registrations, foreign exchange (FX) quotes, order lifecycles, payment processing, webhook ingestion, transaction tracking, audit logging, and automated testnet settlement on the Stellar blockchain via Soroban smart contracts.

### The Problem It Solves
Cross-border settlements between local payment rails and digital asset networks often suffer from high transaction costs, lack of transaction transparency, manual settlement processing, floating-point currency rounding errors, and security vulnerabilities. `luminarail-backend` solves these issues by providing:
- **Vendor-Agnostic Payment Abstraction**: Clean separation between local fiat payment providers and core settlement logic.
- **Idempotency Guarantees**: Protection against duplicate orders, payments, and webhook events across concurrent network requests.
- **Automated Soroban Settlement**: Background workers (`SettlementWorker`) that execute, simulate, sign, and monitor on-chain settlement transactions.
- **Strict Non-Custodial Architecture**: User private keys and secret seeds are never stored, logged, or accepted over HTTP boundaries.

### Ecosystem Purpose
Within the broader LuminaRail ecosystem, `luminarail-backend` acts as the bridge between client applications (`luminarail-frontend`) and Stellar smart contracts (`luminarail-contracts`).

### Who Can Contribute
Developers with experience in Node.js, Express, TypeScript, Prisma ORM, PostgreSQL, financial APIs, or Stellar/Soroban blockchain integration are welcome to contribute.

---

## Features

- **User Authentication & RBAC**: JWT-based authentication with bcrypt password hashing (cost factor 10) and Role-Based Access Control (`USER`, `MERCHANT`, `ADMIN`, `SUPER_ADMIN`).
- **User Profile Management**: Retrieve current authenticated user details (`GET /api/v1/users/me`).
- **Non-Custodial Wallet Management**: Register public Stellar addresses (`G...`), list user wallets, delete registered wallets, and perform address format validation.
- **FX Quote Generation**: Support for both deterministic sandbox quotes (`MockQuoteProvider`) and real-time exchange rate calculation (`RealFxQuoteProvider`). Calculates exchange rates, fee percentages, and expiration timestamps.
- **Order State Machine & Idempotency**: Creation and management of order lifecycles (`CREATED` → `PAYMENT_PENDING` → `PAYMENT_RECEIVED` → `SETTLEMENT_PENDING` → `COMPLETED` / `FAILED` / `CANCELLED`). Idempotency enforcement via `Idempotency-Key` headers.
- **Payment Processing & Provider Abstraction**: Provider-agnostic `IPaymentProvider` interface. Phase 3 includes `MockPaymentProvider` for deterministic local payment processing simulation.
- **Webhook Processing & Verification**: Secure webhook handling (`POST /api/v1/webhooks/:provider`) with HMAC signature verification (`x-webhook-signature`) and database deduplication via `WebhookEvent`.
- **Transaction & Audit Logging**: User transaction history tracking and sensitive-redacted audit logs accessible to system administrators.
- **Stellar Integration Gateway**: Dedicated Stellar gateway (`src/stellar/`) providing normalized account lookup, balance inspection, asset allowlisting (USDC, XLM), and transaction history queries.
- **Soroban Testnet Settlement Engine**: Automated background process (`SettlementWorker`) managing a 7-state settlement lifecycle (`PENDING` → `SUBMITTING` → `SUBMITTED` → `CONFIRMING` → `COMPLETED` / `FAILED` / `REQUIRES_RECONCILIATION`), pre-flight transaction simulation, and testnet Soroban RPC polling.

---

## Architecture

`luminarail-backend` is structured as a **Modular Monolith** using TypeScript, Express, Prisma ORM, and PostgreSQL.

```
Client App (luminarail-frontend / HTTP API Clients)
       │
       ▼
Express API Layer (src/app.ts & src/modules/*)
       │
       ├── Middleware (JWT Auth, RBAC, Rate Limiter, Helmet, Error Handling)
       │
       ├── Core Services
       │     ├── Auth & User Service
       │     ├── Wallet Service (Non-custodial address validation)
       │     ├── Quote Service (MockQuoteProvider / RealFxQuoteProvider)
       │     ├── Order & Payment Engine (Idempotency-Key & Provider abstraction)
       │     └── Webhook Engine (HMAC Verification & Deduplication)
       │
       ├── Database Layer (Prisma Client & PostgreSQL)
       │
       └── Stellar Gateway (src/stellar/) & Settlement Engine (src/workers/)
             │
             ├── Soroban RPC Client & Simulation Engine
             └── Stellar Testnet Soroban Contracts (SettlementVault)
```

### Architectural Safeguards

1. **Payment Provider Abstraction**: Core domains interact strictly through the vendor-agnostic `IPaymentProvider` interface. Vendor response details are never leaked.
2. **Deterministic Sandbox Provider**: Operates with `MockPaymentProvider` for safe local development without external API keys or live fiat processing.
3. **Stellar Gateway Isolation**: Blockchain interactions are centralized in `src/stellar/` services.
4. **Idempotency**: Server-side deduplication using `Idempotency-Key` headers for financial requests (`orders`, `payments`) and `WebhookEvent` records for webhooks.
5. **Non-Custodial Model**: Private keys, secret seeds (`S...`), card details, and provider secrets are rejected across HTTP boundaries.
6. **Monetary Precision**: All monetary values use string/decimal representations (`Decimal` in Prisma) to avoid floating-point rounding issues.

---

## Tech Stack

- **Runtime**: Node.js >= 20.x
- **Framework**: Express 4.21
- **Language**: TypeScript 5.7
- **Database & ORM**: PostgreSQL with Prisma ORM 6.3
- **Blockchain SDK**: `@stellar/stellar-sdk` 16.2
- **Testing Framework**: Vitest 3.0 with Supertest 7.2
- **Security & Utilities**: Zod (environment & payload validation), bcryptjs, jsonwebtoken, Helmet, express-rate-limit

---

## Project Structure

```
luminarail-backend/
├── .env.example           # Configuration template (NO real secrets)
├── docker-compose.yml     # Local PostgreSQL container specification
├── package.json           # Node.js dependencies & development scripts
├── tsconfig.json          # TypeScript compiler configuration
├── CONTRIBUTING.md        # Basic contribution guidelines
├── SECURITY.md            # Security policy and disclosure process
├── LICENSE                # MIT License
├── prisma/
│   ├── schema.prisma      # Database schema definitions & models
│   └── migrations/        # PostgreSQL SQL migration history
├── src/
│   ├── app.ts             # Express application configuration & routes mounting
│   ├── server.ts          # Server entry point & HTTP listener setup
│   ├── config/            # Centralized configuration & Zod environment validation
│   ├── db/                # Prisma client singleton connection
│   ├── errors/            # Standardized application error classes
│   ├── middleware/        # Authentication, validation, and rate-limiting middleware
│   ├── modules/           # Domain modules
│   │   ├── admin/         # Administrative actions
│   │   ├── audit/         # Audit logging service & endpoints
│   │   ├── auth/          # Authentication (Register, Login, Logout)
│   │   ├── merchants/     # Merchant management
│   │   ├── orders/        # Order management & state transitions
│   │   ├── payments/      # Payment processing & verification
│   │   ├── providers/     # Payment provider interfaces & implementations
│   │   ├── quotes/        # FX rate generation & providers
│   │   ├── settlements/   # Settlement records & management
│   │   ├── transactions/  # System transaction logs
│   │   ├── users/         # User profile management
│   │   ├── wallets/       # Non-custodial Stellar wallet address storage
│   │   └── webhooks/      # Webhook handling & signature verification
│   ├── stellar/           # Stellar Network Gateway
│   │   ├── accounts/      # Address validation & account lookup
│   │   ├── assets/        # Asset definitions & allowlisting
│   │   ├── balances/      # Balance normalization
│   │   ├── cache/         # Memory & Redis cache abstractions
│   │   ├── config/        # Network configuration & safety assertions
│   │   ├── horizon/       # Horizon RPC client wrappers
│   │   ├── routes/        # Read-only Stellar REST API routes
│   │   ├── soroban/       # Soroban RPC client & contract executor
│   │   └── transactions/  # Stellar transaction lookup
│   ├── types/             # Common TypeScript interfaces
│   └── workers/           # Background process workers (SettlementWorker)
├── docs/                  # Developer & architecture documentation
│   ├── architecture.md    # System architecture & state machines
│   └── contributing.md    # In-depth contributor guide
└── tests/                 # Vitest automated test suite (25 test files)
```

---

## Getting Started

### Prerequisites
- Node.js >= 20.x
- npm >= 10.x
- Docker & Docker Compose (for local PostgreSQL database)

### Quick Start Instructions

1. **Clone the repository**:
   ```bash
   git clone https://github.com/LuminaRail/luminarail-backend.git
   cd luminarail-backend
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   ```bash
   cp .env.example .env
   ```
   *Note: Never place real secrets in `.env` files.*

4. **Start PostgreSQL Container**:
   ```bash
   docker compose up -d
   ```

5. **Generate Prisma Client & Run Database Migrations**:
   ```bash
   npm run db:generate
   npx prisma migrate dev
   ```

6. **Start Development Server**:
   ```bash
   npm run dev
   ```
   The API will be running at `http://localhost:4000/api/v1`.

---

## Environment Variables

The backend relies on environment variables validated at application startup using Zod schemas (`src/config/index.ts`). Below is the configuration specification:

```env
# Application Settings
NODE_ENV=development
PORT=4000
API_PREFIX=/api/v1

# Database Configuration (PostgreSQL)
DATABASE_URL=postgresql://<user>:<password>@localhost:5432/<dbname>?schema=public

# Cache Configuration (Optional)
REDIS_URL=redis://localhost:6379

# Stellar Network Configuration (Testnet ONLY)
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
STELLAR_SETTLEMENT_VAULT_CONTRACT_ID=<soroban_contract_id>
SOROBAN_SETTLEMENT_VAULT_CONTRACT_ID=<soroban_contract_id>
SOROBAN_ESCROW_CONTRACT_ID=<soroban_contract_id>
SOROBAN_FEE_MANAGER_CONTRACT_ID=<soroban_contract_id>
STELLAR_SETTLEMENT_SIGNER_PUBLIC_KEY=<stellar_public_key>
STELLAR_SETTLEMENT_SIGNER_SECRET_KEY=<stellar_secret_key>

# JWT Authentication
JWT_SECRET=<your_jwt_secret_placeholder>
JWT_EXPIRES_IN=1d

# Payment Provider Configuration
PAYMENT_PROVIDER_ID=default_provider
PAYMENT_PROVIDER_API_KEY=<provider_api_key_placeholder>
PAYMENT_PROVIDER_WEBHOOK_SECRET=<webhook_secret_placeholder>

# FX Quote Provider Configuration
FX_API_URL=https://open.er-api.com/v6/latest/USD
FX_API_KEY=<fx_api_key_placeholder>
QUOTE_PROVIDER=real
QUOTE_EXPIRY_SECONDS=30
QUOTE_FEE_PERCENTAGE=0.01
```

> [!CAUTION]
> **NEVER** commit real API keys, database credentials, JWT secrets, or Stellar secret keys (`S...`) to version control.

---

## Development

Available npm scripts in `package.json`:

```bash
# Start dev server with auto-reload (tsx watch)
npm run dev

# Compile TypeScript to dist/
npm run build

# Start production server from dist/
npm run start

# Run ESLint across src/
npm run lint

# Run TypeScript type check (no emit)
npm run type-check

# Generate Prisma client bindings
npm run db:generate

# Create and apply Prisma migrations locally
npm run db:migrate
```

---

## Testing

The project uses [Vitest](https://vitest.dev/) for unit and integration testing.

```bash
# Run full Vitest test suite
npm test
```

### Test Coverage Summary
The test suite contains 25 test files covering:
- **Authentication**: User registration, login, JWT validation (`auth.test.ts`).
- **Orders**: Order creation, state transitions, idempotency handling (`orders.test.ts`).
- **Payments**: Mock payment provider logic, concurrency safety, state transitions (`payments/`).
- **Quotes**: Quote generation, fee calculation, expiration, and real FX provider (`quotes.test.ts`, `real-fx-provider.test.ts`).
- **Settlements**: Settlement service logic, state transitions, and live Soroban settlement worker lifecycle (`settlements/`).
- **Stellar Gateway**: Address validation, asset allowlisting, balance parsing, Horizon/Soroban endpoints (`stellar/`).
- **Webhooks**: Signature verification and event idempotency (`webhooks.test.ts`).

---

## API Documentation

All API routes are prefixed with `/api/v1`.

| Module | Method | Endpoint | Description | Auth Required |
|---|---|---|---|---|
| **Health** | `GET` | `/health` | Application & Stellar Testnet health status | No |
| **Auth** | `POST` | `/api/v1/auth/register` | Register new user account | No |
| **Auth** | `POST` | `/api/v1/auth/login` | Authenticate user & return JWT | No |
| **Auth** | `POST` | `/api/v1/auth/logout` | End authenticated session | No |
| **Users** | `GET` | `/api/v1/users/me` | Retrieve profile of authenticated user | Yes |
| **Wallets** | `POST` | `/api/v1/wallets` | Register public Stellar wallet address | Yes |
| **Wallets** | `GET` | `/api/v1/wallets` | List user registered wallets | Yes |
| **Wallets** | `DELETE` | `/api/v1/wallets/:id` | Unlink registered wallet | Yes |
| **Quotes** | `POST` | `/api/v1/quotes` | Create FX quote & calculate fees | Optional |
| **Quotes** | `GET` | `/api/v1/quotes` | List generated FX quotes | Optional |
| **Quotes** | `GET` | `/api/v1/quotes/:id` | Fetch specific quote details | Optional |
| **Orders** | `POST` | `/api/v1/orders` | Create order (requires `Idempotency-Key`) | Yes |
| **Orders** | `GET` | `/api/v1/orders` | List user orders | Yes |
| **Orders** | `GET` | `/api/v1/orders/:id` | Get specific order status | Yes |
| **Payments** | `POST` | `/api/v1/payments` | Create payment (requires `Idempotency-Key`) | Yes |
| **Payments** | `GET` | `/api/v1/payments/:id` | Retrieve payment details | Yes |
| **Payments** | `POST` | `/api/v1/payments/:id/verify` | Verify payment status with provider | Yes |
| **Webhooks** | `POST` | `/api/v1/webhooks/:provider` | Webhook listener (requires `x-webhook-signature`) | Header |
| **Transactions** | `GET` | `/api/v1/transactions` | Query transaction records | Yes |
| **Transactions** | `GET` | `/api/v1/transactions/:id` | Get transaction details | Yes |
| **Audit** | `GET` | `/api/v1/audit` | Query audit logs | Admin |
| **Settlements** | `GET` | `/api/v1/settlements` | List pending/completed settlements | Admin |
| **Settlements** | `GET` | `/api/v1/settlements/:id` | Get settlement record details | Yes |
| **Settlements** | `GET` | `/api/v1/settlements/order/:orderId` | Get settlement record by Order ID | Yes |
| **Stellar** | `GET` | `/api/v1/stellar/accounts/:address` | Account details from Horizon RPC | No |
| **Stellar** | `GET` | `/api/v1/stellar/accounts/:address/balances` | Stellar balance breakdown | No |
| **Stellar** | `GET` | `/api/v1/stellar/transactions/:hash` | Stellar transaction details | No |

---

## Stellar & Soroban Integration

### Network & Safety Scope
- **Network Scope**: Enforced strictly to Stellar Testnet (`STELLAR_NETWORK=testnet`). Live operation halts automatically if configured for Mainnet without authorization.
- **Soroban Contracts**: Integrates with `SettlementVaultContract` deployed on Soroban Testnet.
- **Signer Key Safety**: The backend settlement signer secret (`STELLAR_SETTLEMENT_SIGNER_SECRET_KEY`) is stored exclusively in environment variables and is never exposed in logs, database fields, or API responses.

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
  ├──> COMPLETED (terminal)
  └──> REQUIRES_RECONCILIATION

COMPLETED (terminal)
FAILED (terminal)
REQUIRES_RECONCILIATION (terminal)
```

### Soroban Settlement Execution Flow
1. **Order Processing**: Orders transitioning to `SETTLEMENT_PENDING` trigger settlement record creation.
2. **Worker Claiming**: `SettlementWorker` queries pending records and marks them as `SUBMITTING`.
3. **Simulation**: `SorobanTransactionService` simulates the `create_settlement` transaction via Soroban RPC to verify footprint and fee parameters.
4. **Signing & Submission**: Transaction is signed with the backend settlement key and submitted to the Soroban RPC endpoint.
5. **Confirmation Polling**: `SorobanConfirmationService` polls transaction status until finality. Upon confirmation, the settlement and order status update to `COMPLETED`.

---

## Contributing

We welcome contributions! Please follow this workflow:

1. **Fork & Clone** the repository.
2. **Create a Feature Branch**: `git checkout -b feature/my-feature`
3. **Install Dependencies**: `npm install`
4. **Make Your Changes**: Implement clean, well-tested TypeScript code.
5. **Run Tests**: Ensure all tests pass with `npm test`.
6. **Run Code Quality Checks**: Execute `npm run type-check` and `npm run lint`.
7. **Commit Changes**: Follow standard commit conventions (e.g., `feat: add new provider`).
8. **Open a Pull Request**: Provide a detailed description of your changes and reference any related issues.

Detailed developer guidelines can be found in [docs/contributing.md](file:///home/whiteghost/LuminaRail/luminarail-backend/docs/contributing.md).

---

## Good First Contributions

If you are looking for places to start contributing, check out these areas:
- **Unit Tests**: Add unit tests for edge cases in module services (`src/modules/`).
- **Validation**: Improve Zod request schema error messages for endpoint validation.
- **Documentation**: Expand API usage examples or inline JSDoc annotations.
- **Developer Experience**: Improve local seed scripts or Docker setup scripts.
- **Mock Payment Extension**: Add mock scenario helpers for edge-case payment provider responses.

---

## Issue Guidelines

When opening an issue, please include:
- **Title**: Short, descriptive summary of the bug or proposal.
- **Description**: Clear description of the issue or feature request.
- **Expected Behavior**: What should happen.
- **Actual Behavior**: What currently happens (with error logs/stack traces if applicable).
- **Reproduction Steps**: Detailed steps to reproduce the behavior.
- **Acceptance Criteria**: For feature requests, list explicit criteria for completion.

---

## Security

Security is critical to LuminaRail. Contributors must adhere to the following principles:
- **Never commit secrets**: No API keys, JWT secrets, database credentials, or private keys (`S...`).
- **Audit sensitive data**: Ensure sensitive fields remain masked in audit logs and error messages.
- **Report Security Issues**: See [SECURITY.md](file:///home/whiteghost/LuminaRail/luminarail-backend/SECURITY.md) for vulnerability reporting procedures.

---

## License

This project is licensed under the [MIT License](./LICENSE).

---

## Project Status

- **Current Status**: Active Development / Testnet Integration
- **Network Target**: Stellar Testnet (Soroban RPC)
- **Production Warning**: This codebase is configured for testnet experimentation and sandbox testing. Do NOT deploy to production without full security audits and mainnet compliance verification.
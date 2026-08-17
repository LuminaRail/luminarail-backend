# LuminaRail

> **NGN → USDC On-Ramp and Stellar/Soroban Settlement Platform**

LuminaRail is an open financial infrastructure connecting Nigerian Naira (NGN) local fiat payment rails directly to the Stellar blockchain. It enables seamless NGN deposits, live foreign exchange rate conversions, and automated settlement of USDC digital dollars to non-custodial Stellar wallets via Soroban smart contracts.

> [!IMPORTANT]
> **Development/Testnet Notice:**
> LuminaRail currently uses Paystack Test Mode and Stellar Testnet/Soroban Testnet for development and demonstration. Production NGN deposits and production Stellar settlement require production provider credentials, compliance/KYB, and production network configuration.

---

## NGN Deposit & Settlement Flow

```
User
  → quote
  → order
  → payment initialization
  → Paystack checkout
  → Paystack confirmation/webhook
  → payment SUCCEEDED
  → Stellar wallet association
  → settlement pending
  → Soroban settlement
  → USDC destination wallet
```

---

## Features

### Authentication
- **User Registration & Login**: Secure account registration (`POST /api/v1/auth/register`) and login (`POST /api/v1/auth/login`) with bcrypt password hashing (cost factor 10).
- **JWT Authentication**: Token-based authentication using JSON Web Tokens (JWT).
- **Protected API Routes**: Middleware (`authenticateToken`, `requireRole`) safeguarding sensitive endpoints.
- **Production `JWT_SECRET` Requirement**: Strict startup validation ensuring default development secrets are rejected when running in production mode (`NODE_ENV=production`).
- **JWT Expiration Configuration**: Configurable token expiration period (`JWT_EXPIRES_IN=1d`).

### FX Quotes
- **NGN → USDC Real-Time Quotes**: Dynamic quote generation connecting NGN fiat source currency to USDC destination assets.
- **Live FX Provider (`RealFxQuoteProvider`)**: Retrieves live exchange rates from external rate providers (`open.er-api.com`).
- **Quote Expiration & Fee Calculation**: Quotes include fixed 30-second expiry windows and configurable platform fee percentages (e.g., 1.0%).
- **Source & Destination Amount Support**: Supports both fixed-source NGN deposit amounts and fixed-destination USDC target amounts.
- **Dynamic Exchange Rates Notice**: Exchange rates are retrieved dynamically from live market feeds and subject to market fluctuations. Quotes are valid until their specified expiration timestamp.

### NGN Fiat On-Ramp
- **Paystack Payment Provider Abstraction**: Vendor-agnostic `IPaymentProvider` interface separating fiat processing from core order logic.
- **Hosted Paystack Checkout**: Generates hosted checkout authorization URLs (`paymentUrl`) for NGN payment completion.
- **Paystack TEST MODE Support**: Configured by default for Paystack TEST MODE (`sk_test_...`) for safe sandbox experimentation without live capital.
- **Payment Reference**: Unique reference generation for each initialized payment transaction.
- **Payment Status Verification**: Programmatic status check endpoint (`POST /api/v1/payments/:id/verify`) querying Paystack's verification service (`GET /transaction/verify/:reference`).
- **Webhook Handling**: Ingestion of Paystack webhook events (`POST /api/v1/webhooks/paystack`) verified via HMAC-SHA512 request signatures (`x-paystack-signature`).
- **Idempotency**: Strict deduplication using `Idempotency-Key` headers on payment initialization and `WebhookEvent` database records.
- **Payment Lifecycle**: `PENDING` → `SUCCEEDED` (or `FAILED` / `EXPIRED`).
- **Current Integration Mode**: Operating in **Paystack TEST MODE** using test API keys (`sk_test_...`).

### Orders
- **ON_RAMP Orders**: Dedicated order creation (`POST /api/v1/orders`) linked to FX quotes and authenticated user accounts.
- **Quote Association**: Direct link to valid, non-expired FX quotes for locked rate calculations.
- **Idempotency Keys**: Required `Idempotency-Key` header prevents duplicate order creation across network retries.
- **Ownership Protection**: Strict user ownership validation preventing unauthorized users from accessing or modifying orders.
- **Wallet Association**: Endpoint `PATCH /api/v1/orders/:id/wallet` links destination Stellar address to the order.
- **Order Lifecycle**:
  - `CREATED`: Initial order record created from FX quote.
  - `AWAITING_PAYMENT`: Payment initialized with Paystack; awaiting user NGN deposit.
  - `PAYMENT_CONFIRMED`: NGN deposit verified by Paystack; awaiting destination Stellar wallet association (if unlinked).
  - `SETTLEMENT_PENDING`: Destination wallet confirmed; order queued for Soroban worker execution.
  - `PROCESSING`: Settlement worker currently submitting on-chain transaction.
  - `COMPLETED`: USDC successfully transferred to user wallet on Stellar network (terminal).
  - `FAILED`: Terminal failure state due to payment expiration, invalid address, or execution failure.
  - `REQUIRES_RECONCILIATION`: Terminal reconciliation state requiring administrative inspection.

### Stellar Wallet
- **Freighter & Connected Wallet Integration**: Browser extension connection using `@stellar/freighter-api` via custom `useStellarWallet` React hook.
- **Wallet Address Association**: `PATCH /api/v1/orders/:id/wallet` connects user's public Stellar key (`G...`) to an order.
- **Address Validation**: Strict public key format validation using `@stellar/stellar-sdk` (`StrKey.isValidEd25519PublicKey`).
- **Settlement Gate**: Order settlement transitions are gated until a valid, verified destination wallet address is associated.

### Soroban Settlement
- **Automated Settlement Worker**: Background worker (`SettlementWorker`) polling and executing pending settlement orders.
- **Settlement State Machine**: `PENDING` → `SUBMITTING` → `SUBMITTED` → `CONFIRMING` → `COMPLETED` (or `FAILED` / `REQUIRES_RECONCILIATION`).
- **Soroban Execution & Simulation**: Pre-flight transaction simulation via Soroban RPC to verify footprint, auth entries, and fee parameters prior to signing.
- **Transaction Submission & Confirmation**: Signs transactions with server settlement key (`STELLAR_SETTLEMENT_SIGNER_SECRET_KEY`), submits to RPC, and polls status until finality.
- **Transaction Hash Recording**: Stores 64-character hex transaction hash for block explorer lookup.
- **Error Handling & Reconciliation**: Automatic retry handling with final state marking (`REQUIRES_RECONCILIATION`) for manual review.
- **Network Scope Notice**: Currently executing strictly on **Stellar Testnet** (Soroban RPC). Mainnet settlement is NOT currently active.

### Dashboard
- **Frontend UI Application**: Next.js 15 App Router client app for users, merchants, and administrators.
- **Deposit NGN / Buy USDC Calculator**: Interactive FX quote calculator and conversion form.
- **Live Quote Display**: Real-time display of current exchange rates, fee deductions, and output amounts.
- **Active Orders & Lifecycle Timeline**: Real-time progress bar tracking order states (`CREATED` → `COMPLETED`).
- **Total NGN Deposited & Total USDC Settled**: Aggregate summary metrics displayed on user dashboard.
- **Wallet Connection Status**: Header badge showing current Stellar wallet connection state and truncated public key (`G...`).
- **Payment Modal**: Modal displaying Paystack hosted checkout link and reference details.
- **Transaction History**: Tabular view of user settlement orders and completed transactions.

### Transaction History
- **Search & Filtering**: Searchable transaction logs accessible via UI dashboard (`/transactions`) and API (`GET /api/v1/transactions`).
- **Identifiers**: Includes Order ID, payment reference, and internal transaction IDs.
- **Stellar Transaction Hash**: Displays on-chain transaction hash with direct links to Stellar Expert Testnet Explorer.
- **Settlement Status**: Clear status indicators (`COMPLETED`, `PENDING`, `FAILED`).

---

## Architecture

```mermaid
graph TD
    subgraph Client Layer
        Frontend["Frontend Application<br/>(Next.js 15 / Vercel)"]
        Wallet["Stellar Wallet<br/>(Freighter Extension)"]
    end

    subgraph LuminaRail Backend Service
        Backend["API Engine<br/>(Node.js / Express / Render)"]
        DB[("PostgreSQL Database<br/>(Prisma ORM)")]
        Worker["Settlement Worker<br/>(Background Process)"]
    end

    subgraph External Systems & Providers
        FX["FX Rate Provider<br/>(open.er-api.com)"]
        Paystack["Paystack Payment Rail<br/>(TEST MODE API)"]
        Stellar["Stellar Network / Soroban<br/>(Testnet RPC)"]
    end

    Frontend -->|HTTP REST / JWT| Backend
    Frontend -->|Sign / Connect| Wallet
    Backend -->|Persist State| DB
    Backend -->|Fetch Live Rates| FX
    Backend -->|Initialize Payments| Paystack
    Backend -->|Account & Balance Lookup| Stellar
    Paystack -->|Signed Webhooks| Backend
    Worker -->|Poll Settlement Queue| DB
    Worker -->|Simulate & Execute| Stellar
```

### Component Responsibilities
- **Frontend (Next.js / Vercel)**: Client UI delivering self-service user dashboards, FX conversion tools, Freighter wallet connection primitives, and order tracking views.
- **LuminaRail Backend (Node.js / Express / Render)**: Modular monolith API managing user authentication, FX quotes, orders, Paystack payment initialization, webhooks, and rate limiting.
- **PostgreSQL / Prisma ORM**: Relational database storing persistent records (`User`, `Order`, `Payment`, `Quote`, `Wallet`, `SettlementRecord`, `WebhookEvent`, `AuditLog`).
- **FX Rate Provider (`open.er-api.com`)**: Fetches real-time exchange rates for NGN → USDC conversion calculations.
- **Paystack**: Handles NGN fiat checkout sessions, issuing checkout URLs and signed webhook payloads.
- **Stellar / Soroban Network**: Executes smart contract token settlement operations and records on-chain transactions on Stellar Testnet.
- **Settlement Worker**: Independent background process executing transaction simulation, signing, submission, and confirmation polling for queued settlements.

---

## Tech Stack

The technologies used in this repository include:

- **Next.js**: 15.1 (App Router architecture)
- **React**: 19.0
- **TypeScript**: 5.7
- **Node.js**: >= 20.x
- **Express**: 4.21
- **Prisma**: 6.3 (PostgreSQL ORM)
- **PostgreSQL**: Relational database storage
- **Vitest**: 3.0 (Backend & Frontend automated unit/integration testing)
- **Stellar SDK**: `@stellar/stellar-sdk` 16.2
- **Soroban**: Stellar smart contract settlement engine
- **Paystack API**: NGN payment rail provider integration
- **Vercel**: Frontend deployment target
- **Render**: Backend web service and PostgreSQL hosting target

---

## Repository Structure

```
LuminaRail/
├── luminarail-backend/               # Core Express Backend API Service
│   ├── prisma/                       # Prisma database schema & migrations
│   ├── src/
│   │   ├── config/                   # Zod environment validation & app configuration
│   │   ├── db/                       # Prisma client connection singleton
│   │   ├── middleware/               # Auth, validation, rate limiter, error handling
│   │   ├── modules/
│   │   │   ├── admin/                # Admin endpoints
│   │   │   ├── audit/                # Audit logging service
│   │   │   ├── auth/                 # User registration & login authentication
│   │   │   ├── merchants/            # Merchant portal backend logic
│   │   │   ├── orders/               # Order lifecycle & state transitions
│   │   │   ├── payments/             # Payment processing & verification controllers
│   │   │   ├── providers/            # Vendor-agnostic IPaymentProvider (Paystack & Sandbox)
│   │   │   ├── quotes/               # FX quote providers (RealFxQuoteProvider & MockQuoteProvider)
│   │   │   ├── settlements/          # Settlement records & state management
│   │   │   ├── transactions/         # System transaction logging
│   │   │   ├── users/                # User profile management
│   │   │   ├── wallets/              # Non-custodial Stellar wallet address storage
│   │   │   └── webhooks/             # Webhook processing & HMAC signature verification
│   │   ├── stellar/                  # Stellar Horizon & Soroban RPC gateway
│   │   └── workers/                  # Background SettlementWorker process
│   └── tests/                        # Vitest automated test suite (27 test files)
│
└── luminarail-frontend/              # Next.js 15 Client Web Application
    ├── app/                          # Next.js App Router pages (dashboard, orders, quotes, transactions)
    ├── components/                   # React UI components (layout, orders, payments, wallet)
    ├── hooks/                        # Custom React hooks (useAuth, useOrders, useQuotes, useStellarWallet)
    ├── lib/                          # API client & helper utilities
    ├── services/                     # Type-safe API service wrappers
    └── types/                        # TypeScript interface declarations
```

---

## API Reference

All API routes are prefixed with `/api/v1`. Protected routes require an `Authorization: Bearer <token>` HTTP header.

| Category | Method | Path | Auth Required | Purpose |
|---|---|---|---|---|
| **Health** | `GET` | `/health` | No | Application health check & Stellar RPC connectivity status |
| **Auth** | `POST` | `/api/v1/auth/register` | No | Register a new user account |
| **Auth** | `POST` | `/api/v1/auth/login` | No | Authenticate user credentials & issue JWT token |
| **Auth** | `POST` | `/api/v1/auth/logout` | No | Terminate user session |
| **Users** | `GET` | `/api/v1/users/me` | Yes | Retrieve authenticated user profile |
| **Wallets** | `POST` | `/api/v1/wallets` | Yes | Register a public Stellar wallet address (`G...`) |
| **Wallets** | `GET` | `/api/v1/wallets` | Yes | List user's registered Stellar wallets |
| **Wallets** | `DELETE` | `/api/v1/wallets/:id` | Yes | Unlink/delete a registered wallet address |
| **Quotes** | `POST` | `/api/v1/quotes` | Optional | Generate a live FX rate quote (NGN → USDC) |
| **Quotes** | `GET` | `/api/v1/quotes` | Optional | Query live FX quote via query parameters |
| **Quotes** | `GET` | `/api/v1/quotes/:id` | Optional | Retrieve FX quote by ID |
| **Orders** | `POST` | `/api/v1/orders` | Yes | Create an ON_RAMP settlement order (Header `Idempotency-Key` required) |
| **Orders** | `GET` | `/api/v1/orders` | Yes | List user's orders (supports `limit` and `offset`) |
| **Orders** | `GET` | `/api/v1/orders/:id` | Yes | Get status details for a specific order |
| **Orders** | `PATCH` | `/api/v1/orders/:id/wallet` | Yes | Associate/update Stellar destination wallet for an order |
| **Payments** | `POST` | `/api/v1/payments` | Yes | Initialize NGN payment via Paystack (Header `Idempotency-Key` required) |
| **Payments** | `GET` | `/api/v1/payments/:id` | Yes | Get payment details by ID |
| **Payments** | `POST` | `/api/v1/payments/:id/verify` | Yes | Manually trigger payment verification with provider |
| **Webhooks** | `POST` | `/api/v1/webhooks/:provider` | Signature Header | Ingest provider webhook payload (requires `x-paystack-signature`) |
| **Settlements** | `GET` | `/api/v1/settlements` | Admin | List pending and completed settlement records |
| **Settlements** | `GET` | `/api/v1/settlements/:id` | Yes | Retrieve settlement record by ID |
| **Settlements** | `GET` | `/api/v1/settlements/order/:orderId` | Yes | Retrieve settlement record for a specific order ID |
| **Transactions** | `GET` | `/api/v1/transactions` | Yes | Query transaction history records |
| **Transactions** | `GET` | `/api/v1/transactions/:id` | Yes | Get transaction log detail by ID |
| **Audit** | `GET` | `/api/v1/audit` | Admin | Query system audit logs |
| **Stellar** | `GET` | `/api/v1/stellar/accounts/:address` | No | Fetch account details from Horizon RPC |
| **Stellar** | `GET` | `/api/v1/stellar/accounts/:address/balances` | No | Fetch balance breakdown for Stellar address |
| **Stellar** | `GET` | `/api/v1/stellar/transactions/:hash` | No | Query Horizon for Stellar transaction by hash |

### Example API Requests

#### Register Account
```http
POST /api/v1/auth/register HTTP/1.1
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "SecurePassword123!",
  "fullName": "Jane Doe"
}
```

#### Request FX Quote
```http
POST /api/v1/quotes HTTP/1.1
Content-Type: application/json

{
  "sourceCurrency": "NGN",
  "destinationAsset": "USDC",
  "amount": "50000"
}
```

#### Create Order
```http
POST /api/v1/orders HTTP/1.1
Authorization: Bearer <jwt_token>
Idempotency-Key: 7b8c9d0e-1f2a-3b4c-5d6e-7f8a9b0c1d2e
Content-Type: application/json

{
  "quoteId": "cm6...quote_id",
  "walletAddress": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
}
```

#### Link Wallet to Order
```http
PATCH /api/v1/orders/cm6...order_id/wallet HTTP/1.1
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "walletAddress": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
}
```

---

## Environment Variables

### Backend Configuration (`luminarail-backend/.env.example`)

Backend configuration settings validated at startup via Zod schemas (`src/config/index.ts`). **Backend secrets must be stored on Render / server environment settings and NEVER committed to Git.**

```env
# Application Settings
NODE_ENV=development
PORT=4000
API_PREFIX=/api/v1

# Database Configuration (SECRET)
DATABASE_URL=postgresql://luminarail:luminarail@localhost:5432/luminarail?schema=public

# Redis Configuration (Optional)
REDIS_URL=redis://localhost:6379

# Stellar Network Configuration (Testnet)
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
STELLAR_SETTLEMENT_VAULT_CONTRACT_ID=
SOROBAN_SETTLEMENT_VAULT_CONTRACT_ID=
SOROBAN_ESCROW_CONTRACT_ID=
SOROBAN_FEE_MANAGER_CONTRACT_ID=
STELLAR_SETTLEMENT_SIGNER_PUBLIC_KEY=
STELLAR_SETTLEMENT_SIGNER_SECRET_KEY=

# Authentication & JWT Configuration (SECRET)
JWT_SECRET=your_jwt_secret_key_placeholder
JWT_EXPIRES_IN=1d

# NGN Fiat Payment Provider (Paystack TEST MODE)
NGN_PROVIDER=paystack
PAYSTACK_SECRET_KEY=sk_test_placeholder
PAYSTACK_BASE_URL=https://api.paystack.co

# Real FX Quote Provider Configuration
FX_API_URL=https://open.er-api.com/v6/latest/USD
FX_API_KEY=
QUOTE_PROVIDER=real
QUOTE_EXPIRY_SECONDS=30
QUOTE_FEE_PERCENTAGE=0.01
```

### Frontend Configuration (`luminarail-frontend/.env.example`)

Frontend environment variables use `NEXT_PUBLIC_` prefixes and are bundled directly into browser-accessible client code.

```env
# Stellar Network Configuration ('testnet' or 'public')
NEXT_PUBLIC_STELLAR_NETWORK=testnet

# LuminaRail Backend API Base URL
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1

# Optional WalletConnect Project ID
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=
```

> [!CAUTION]
> **Security Rule**: `NEXT_PUBLIC_*` variables are exposed to the user's browser. Never store database credentials, Paystack secret keys (`sk_...`), JWT secrets, or Stellar secret keys (`S...`) in frontend environment files.

---

## Local Development

### Running the Backend (`luminarail-backend`)

1. **Install dependencies**:
   ```bash
   cd luminarail-backend
   npm install
   ```

2. **Run TypeScript type-check**:
   ```bash
   npm run type-check
   ```

3. **Run automated test suite**:
   ```bash
   npm test
   ```

4. **Build production distribution**:
   ```bash
   npm run build
   ```

5. **Start local development server**:
   ```bash
   npm run dev
   ```
   The backend API will run at `http://localhost:4000/api/v1`.

### Running the Frontend (`luminarail-frontend`)

1. **Install dependencies**:
   ```bash
   cd luminarail-frontend
   npm install
   ```

2. **Run TypeScript type-check**:
   ```bash
   npm run type-check
   ```

3. **Run automated test suite**:
   ```bash
   npm test
   ```

4. **Build production bundle**:
   ```bash
   npm run build
   ```

5. **Start Next.js development server**:
   ```bash
   npm run dev
   ```
   The client application will run at `http://localhost:3000`.

---

## Testing & Quality Status

The repository has been fully verified with automated test suites:

- **Backend (`luminarail-backend`)**:
  - **Test Files**: 27 / 27 passed
  - **Tests**: 143 / 143 passed
  - **Status**: 100% passing
- **Frontend (`luminarail-frontend`)**:
  - **Test Files**: 3 / 3 passed
  - **Tests**: 16 / 16 passed
  - **Status**: 100% passing
- **TypeScript Verification**: Passed cleanly across backend and frontend (`npm run type-check`).
- **Production Builds**: Passed (`npm run build` compiled cleanly for both services).

---

## Deployment Architecture

- **Frontend Application**: Deployed on **Vercel**.
  - `NEXT_PUBLIC_API_URL` points to the deployed backend URL on Render.
- **Backend API Engine**: Deployed as a web service on **Render**.
  - All secret environment variables (`JWT_SECRET`, `PAYSTACK_SECRET_KEY`, `DATABASE_URL`, `STELLAR_SETTLEMENT_SIGNER_SECRET_KEY`) reside exclusively on Render.
  - The frontend never has access to backend secrets.
- **Database**: Managed **PostgreSQL** hosted on Render.
- **Paystack Webhook Hookup**: Webhook URL configured in Paystack developer portal pointing to `https://<backend-render-domain>/api/v1/webhooks/paystack`.

---

## Paystack Integration Architecture

- **Backend-Only Secret Calls**: All Paystack API communication involving `PAYSTACK_SECRET_KEY` occurs strictly on the LuminaRail backend.
- **Frontend-Backend Contract**: The frontend requests payment initialization from the LuminaRail backend (`POST /api/v1/payments`). The backend calls Paystack (`POST https://api.paystack.co/transaction/initialize`) and returns the hosted checkout URL (`paymentUrl`).
- **Payment Verification**: Opening or submitting the Paystack checkout page does **not** mark an order as paid. Payment completion is strictly verified server-side through HMAC-SHA512 webhook events (`POST /api/v1/webhooks/paystack`) and verification requests (`GET /transaction/verify/:reference`).
- **TEST MODE Status**: LuminaRail is currently configured in **Paystack TEST MODE** using `sk_test_...` keys. Test deposits are completed using Paystack test bank accounts or test cards. No real bank accounts are charged.

---

## Security Architecture & Policies

- **JWT Token Protection**: Authenticated endpoints require valid JWT tokens.
- **Production `JWT_SECRET` Enforcement**: Startup validation rejects default development keys in production (`NODE_ENV=production`).
- **Webhook Signature Validation**: Ingestion of Paystack webhooks requires valid HMAC-SHA512 `x-paystack-signature` matching raw request payloads against `PAYSTACK_SECRET_KEY`.
- **Idempotency Safeguards**: `Idempotency-Key` headers prevent duplicate payment or order submissions.
- **Order & Payment Ownership**: Users can only view or manage their own orders and payments.
- **Stellar Wallet Address Validation**: Validates public key syntax via `@stellar/stellar-sdk`.
- **Server-Calculated Amounts**: All monetary and token settlement values are calculated server-side from active FX quotes.
- **Non-Custodial Architecture**: Private keys and secret seeds (`S...`) are never accepted, stored, or logged.

---

## Current Project Status

### Implemented Functionality
- Real FX quote provider integration (`RealFxQuoteProvider`).
- Complete NGN → USDC order lifecycle state machine.
- Paystack NGN payment initialization and verification.
- HMAC-SHA512 signed webhook handling and deduplication.
- Stellar wallet address registration and order association.
- Soroban testnet settlement worker.
- Interactive user dashboard with quote calculator, order timeline, and transaction history.
- Verified test suite: 27 backend test files (143 tests) and 3 frontend test files (16 tests) passing 100%.

### Current Limitations
- **Paystack TEST MODE**: Paystack integration currently operates in TEST MODE (`sk_test_...`). Production NGN deposits require live Paystack account credentials.
- **Stellar Testnet Settlement**: Settlement transactions execute on Stellar Testnet RPC.

---

## Roadmap

- [ ] Production Paystack account activation and live API key deployment.
- [ ] Integration of additional Nigerian fiat payment providers (e.g., Monnify, Flutterwave).
- [ ] Automated KYC/AML compliance checking integration.
- [ ] Production application monitoring and alerting setup (Sentry, Prometheus metrics).
- [ ] Advanced administrative reconciliation dashboard.
- [ ] Stellar Mainnet readiness and Soroban smart contract security auditing.

---

## Contributing

We welcome contributions to LuminaRail! Please follow standard practices:

1. Fork the repository on GitHub.
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Install dependencies: `npm install`
4. Run tests: `npm test`
5. Run type checks: `npm run type-check`
6. Build project: `npm run build`
7. Submit a Pull Request.

---

## License

This project is licensed under the [MIT License](./LICENSE).
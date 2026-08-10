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
├── errors/           # Standardized error definitions (AppError, ValidationError, etc.)
├── middleware/       # JWT Authentication, RBAC, Validation, Error Handling
├── modules/          # Clean domain module boundaries
│   ├── auth/         # JWT Register, Login, Logout
│   ├── users/        # User profile management (/users/me)
│   ├── wallets/      # Non-custodial Stellar wallet management & address validation
│   ├── quotes/       # FX exchange rates & deterministic mock quote engine
│   ├── orders/       # Order creation, state machine & Idempotency-Key handling
│   ├── transactions/ # Application-level transaction tracking
│   └── audit/        # Sensitive-redacted audit log recording & admin lookup
└── stellar/          # Stellar Horizon & Soroban client integration
```

### Architectural Safeguards

1. **Provider Isolation**: Payment providers implement abstract interfaces. Mock engines are explicitly isolated for Phase 1.
2. **Off-Chain Data Rules**: Sensitive user information, PII, and bank account metadata are kept strictly off-chain in PostgreSQL.
3. **Idempotency**: Financial operations (`POST /api/v1/orders`) support server-side `Idempotency-Key` headers backed by PostgreSQL deduplication.
4. **Key Safety**: The backend never accepts, requests, or stores private keys or seed phrases.
5. **Server-Side Financial Rules**: Exchange rates, amounts, fees, and quotes are strictly generated server-side. Client-supplied amounts are never trusted.

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

# Check migration status
npx prisma migrate status
```

---

## API Endpoint Structure (`/api/v1`)

| Module | Method | Endpoint | Description | Auth Required |
|---|---|---|---|---|
| **Health** | `GET` | `/health` | Service health status | No |
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
| **Transactions** | `GET` | `/api/v1/transactions` | Query user transactions | Yes |
| **Transactions** | `GET` | `/api/v1/transactions/:id` | Get transaction details | Yes |
| **Audit** | `GET` | `/api/v1/audit` | Query audit logs | Admin / SuperAdmin |

---

## Authentication & Security

- **Password Hashing**: Passwords are hashed using `bcrypt` with cost factor 10. Plaintext passwords are never logged or stored.
- **JWT Authentication**: Secured using `Authorization: Bearer <token>`.
- **Role-Based Access Control (RBAC)**: Support for `USER`, `MERCHANT`, `ADMIN`, `SUPER_ADMIN`.
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
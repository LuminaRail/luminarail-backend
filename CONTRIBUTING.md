# Contributing to LuminaRail Backend

Thank you for your interest in contributing to **LuminaRail Backend**! LuminaRail is an open-source settlement infrastructure API connecting local payment rails (such as NGN via Paystack) with programmable USDC stablecoin settlement on the Stellar network using Soroban smart contracts.

---

## Drips Wave & Stellar Open Source Ecosystem

LuminaRail is part of the Stellar open-source ecosystem and Drips Wave contributor program. We welcome open-source contributions from backend developers and open-source engineers.

### 1. What LuminaRail Backend Is
The LuminaRail Backend is a modular TypeScript / Node.js API service built with Express, PostgreSQL (Prisma ORM), and `@stellar/stellar-sdk`. It manages foreign exchange quote calculations, ON_RAMP order state machines, Paystack payment initialization and webhook verification, and automated background Soroban settlement workers.

### 2. Why We Use Stellar & Soroban
- **Stellar Horizon / RPC**: Interacts directly with Stellar Testnet nodes to query ledger state, account balances, and asset trustlines.
- **Soroban Smart Contracts**: Invokes WASM smart contracts (`settlement_vault`, `escrow`, `fee_manager`) to execute atomic, verifiable token settlement transfers.

### 3. Which Repository Should You Work In?
- **`luminarail-backend`** (This repository): Node.js, Express, PostgreSQL, Prisma API service handling Paystack webhooks, order state machines, and Soroban contract invocation.
- **`luminarail-frontend`**: Next.js 16 UI application for users, merchants, and order dashboards.
- **`luminarail-contracts`**: Soroban Rust smart contracts (`settlement_vault`, `escrow`, `fee_manager`).

---

## Contributor Skill Breakdown

### Good for Beginner / Intermediate Backend Contributors (TypeScript, Node.js, Express)
- Adding new REST API endpoints, request validation schemas (Zod), and middleware
- Structured JSON logging, error handling, and request correlation IDs
- Provider abstraction helpers and FX quote caching
- Expanding unit test coverage for services and controllers (Vitest)
- OpenAPI / Swagger documentation definitions

### Requires Deeper Database & Stellar / Web3 Knowledge
- Settlement worker polling optimization & lock mechanisms (PostgreSQL / Redis)
- Paystack webhook replay protection and automated payment reconciliation worker
- Soroban RPC transaction footprint simulation and gas fee estimation
- Stellar Horizon RPC error recovery and transaction retry policies

---

## Development Setup & Workflow

### Prerequisites
- Node.js >= 20.x
- npm >= 10.x
- PostgreSQL database (or Docker Compose container)

### 1. Clone & Branch Strategy
We follow a strict branching model. All work should branch off and merge into `develop`:
```bash
git checkout develop
git pull origin develop
git checkout -b feature/your-feature-name
```

### 2. Environment Setup
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
*(Never commit real secrets, database passwords, or private keys).*

### 3. Install Dependencies & Generate Database Client
```bash
npm install
npm run db:generate
```

### 4. Running Verification Commands
Before submitting code, all of the following commands MUST pass cleanly:
```bash
npm run type-check   # Strict TypeScript check
npm run lint         # ESLint checks
npm run build        # TypeScript compiler build (tsc)
npm test             # Vitest test suite (27 test files, 143+ tests)
```

---

## Submitting a Pull Request

1. Push your branch to GitHub:
   ```bash
   git push origin feature/your-feature-name
   ```
2. Open a Pull Request targeting the **`develop`** branch.
3. Complete the PR description detailing the problem solved, changes made, and verification results.
4. Request review from maintainers.

---

## Security & Secrets Policy
- **No Secrets**: Never commit `JWT_SECRET`, `PAYSTACK_SECRET_KEY`, database credentials, or private Stellar keys (`S...`).
- **Idempotency**: Maintain `Idempotency-Key` header checks on all payment and order creation routes.

---

## License
This project is licensed under the [MIT License](./LICENSE).

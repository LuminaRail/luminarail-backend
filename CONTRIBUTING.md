# Contributing to LuminaRail Backend

Thank you for contributing to **LuminaRail Backend**. LuminaRail is a modular settlement infrastructure platform connecting local payment rails with assets on the Stellar network.

---

## Architecture & Principles

- **Modular Monolith**: The backend is architected as a clean modular monolith inside `src/modules/`. Do not create separate microservices.
- **Provider Abstraction**: All payment provider integrations (e.g. Flutterwave, Paystack, local rails) must implement a core interface pattern under `src/modules/providers/`. Provider-specific logic must never leak into core business modules.
- **Off-Chain Isolation**: Sensitive user PII and banking metadata remain strictly off-chain in PostgreSQL.
- **Idempotency**: All financial state machine operations (orders, payments, payouts, settlements) must support server-side idempotency.

---

## Branching Strategy

- `main`: Stable production branch.
- `develop`: Integration branch. Create feature/fix branches off `develop`.
- `feature/*`: New modules or backend capability additions.
- `fix/*`: Bug fixes.

---

## Getting Started

1. **Prerequisites**: Node.js v20+, PostgreSQL v15+, Redis-ready infrastructure.
2. **Setup**:
   ```bash
   git checkout develop
   cp .env.example .env
   npm install
   ```
3. **Database Migrations**: Database schema resides inside `src/database/`. Run migrations using `npx prisma migrate dev` (or repository migration script).

---

## Pull Request Checklist

1. Code compiles without errors: `npm run build`
2. Type check passes: `npm run type-check`
3. Linter passes: `npm run lint`
4. All unit/integration tests pass: `npm test`
5. No hardcoded credentials or real network keys committed.

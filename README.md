# LuminaRail Backend (`luminarail-backend`)

> **"Open financial rails for Stellar."**

`luminarail-backend` is the core settlement engine and API layer of LuminaRail. It provides modular settlement infrastructure connecting local payment rails (starting with Nigeria NGN) to Stellar network assets (USDC).

---

## High-Level Architecture

The backend is built as a **Modular Monolith** using TypeScript, Node.js, Express, PostgreSQL, and `@stellar/stellar-sdk`.

```
src/
├── modules/          # Clean domain module boundaries
│   ├── auth/         # Authentication & token verification
│   ├── users/        # User accounts & role management
│   ├── wallets/      # Stellar wallet registration & public keys
│   ├── quotes/       # FX exchange rates & fee quotes
│   ├── orders/       # Order management & status transitions
│   ├── payments/     # Local fiat payment processing boundary
│   ├── settlements/  # Stellar & Soroban settlement coordination
│   ├── merchants/    # Merchant accounts & API key management
│   ├── providers/    # Abstract payment provider interfaces
│   ├── webhooks/     # Webhook reception & merchant dispatch
│   └── audit/        # Immutable audit logging
├── database/         # PostgreSQL schema, migrations, and seed scripts
├── stellar/          # Stellar Horizon & Soroban client integration
└── config/           # Centralized configuration management
```

### Architectural Safeguards

1. **Provider Isolation**: Payment providers (e.g. Flutterwave, Paystack) implement the `IPaymentProvider` interface. Country-specific or vendor-specific logic is strictly isolated from core domain modules.
2. **Off-Chain Data Rules**: Sensitive user information, PII, and bank account metadata are kept strictly off-chain in PostgreSQL.
3. **Idempotency**: All payment and settlement state transitions support server-side idempotency keys.
4. **Server-Side Financial Rules**: Rates, amounts, and settlement checks are calculated and verified server-side. Client-supplied amounts are never trusted.

---

## Database Schema (PostgreSQL)

Database models are managed via Prisma ORM inside `prisma/schema.prisma`. Entities include:

- `users`, `roles`, `wallets`
- `quotes`, `orders`, `payments`, `payouts`, `settlements`, `transactions`
- `payment_providers`, `provider_transactions`
- `merchants`, `api_keys`, `webhooks`, `webhook_deliveries`
- `audit_logs`, `notifications`

---

## Development Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy environment variable template
cp .env.example .env

# 3. Generate Prisma client
npm run db:generate

# 4. Run development server
npm run dev
```

---

## Testing & Quality

```bash
# Type check
npm run type-check

# Linting
npm run lint

# Build
npm run build

# Unit & Integration Tests
npm test
```

---

## License

[MIT License](./LICENSE)
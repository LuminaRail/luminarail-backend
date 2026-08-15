# Contributing to LuminaRail Backend

Thank you for your interest in contributing to `luminarail-backend`! This guide explains how to set up your environment, write tests, and submit pull requests.

---

## Local Environment Setup

### 1. Prerequisites
Ensure you have installed:
- **Node.js**: v20.x or higher
- **npm**: v10.x or higher
- **Docker Desktop** or **Docker Engine** (with Compose)

### 2. Step-by-Step Setup

```bash
# Clone the repository
git clone https://github.com/LuminaRail/luminarail-backend.git
cd luminarail-backend

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Start local PostgreSQL database container
docker compose up -d

# Generate Prisma Client code
npm run db:generate

# Apply database migrations
npx prisma migrate dev

# Start development server
npm run dev
```

---

## Development Workflow

### Creating a Branch
Create a new branch from `develop`:
```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

### Adding Database Migrations
If your changes require updating `prisma/schema.prisma`:
1. Edit `prisma/schema.prisma`.
2. Run `npx prisma migrate dev --name <descriptive_migration_name>`.
3. Verify the generated SQL migration script in `prisma/migrations/`.

### Writing & Running Tests
We use [Vitest](https://vitest.dev/) for unit and integration testing.

- **Run all tests**:
  ```bash
  npm test
  ```
- **Run a specific test file**:
  ```bash
  npx vitest run tests/orders.test.ts
  ```

Every new feature or bug fix must include corresponding tests under `tests/`.

---

## Quality Checks

Before submitting a Pull Request, run the following verification checks:

```bash
# Check TypeScript types
npm run type-check

# Run ESLint linter
npm run lint

# Ensure all Vitest tests pass
npm test
```

---

## Pull Request Guidelines

1. Ensure all local tests and linter checks pass cleanly.
2. Commit with conventional commit messages (e.g., `feat(quotes): add cache expiry logic`, `fix(orders): validate idempotency key`).
3. Keep pull requests focused on a single feature or bug fix.
4. Do **NOT** commit `.env` files or secret values.
5. Submit your PR against the `develop` branch.

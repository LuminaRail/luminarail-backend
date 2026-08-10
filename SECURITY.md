# Security Policy — LuminaRail Backend

Security is a foundational pillar of LuminaRail's financial infrastructure platform.

---

## Core Security Standards

1. **Secret & Key Management**:
   - Private keys, seed phrases, database passwords, JWT secrets, and payment provider API keys must never be committed to source control.
   - Use `.env.example` as a template for required environment variables.
2. **Financial Data Integrity & Auditing**:
   - Financial ledger entries, settlements, orders, and provider transaction records must support immutability and auditability (`audit_logs` module).
   - Server-side verification of Stellar Horizon/RPC transactions is mandatory before settling orders.
3. **Database Security**:
   - Access to PostgreSQL must use parametrized queries or ORM interfaces (Prisma) to prevent SQL injection.
   - Sensitive user information (KYC, banking tokens) must be encrypted at rest.
4. **Idempotency & Replay Protection**:
   - Webhook processing (`src/modules/webhooks/`) and payment processing must verify signatures and enforce idempotency key checks.

---

## Vulnerability Reporting

Please report security issues directly to `security@luminarail.org`. Do not open public issues for security vulnerabilities.

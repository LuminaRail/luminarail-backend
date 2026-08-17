# LuminaRail Backend — Proposed Contributor Issues

This document contains 10 repository-grounded, production-relevant contributor issues for `luminarail-backend`.

---

### Issue 1: Implement automated Paystack payment reconciliation background worker
- **Problem**: When a Paystack webhook is dropped or delayed due to network hiccups, orders in `AWAITING_PAYMENT` state remain pending indefinitely unless manually verified via endpoint.
- **Scope**: Create `src/workers/reconciliation.worker.ts` that periodically queries Paystack verification API for stale pending payments (>15 mins old) and updates database state.
- **Acceptance Criteria**:
  - Background job identifying stale payments awaiting confirmation.
  - Safely verify status with Paystack and trigger order state transition.
  - Comprehensive unit and integration tests.
- **Relevant Area**: Backend
- **Difficulty**: Medium
- **Potential Skills**: TypeScript, Node.js, Express, Prisma, Vitest

---

### Issue 2: Implement webhook payload replay protection using database message IDs
- **Problem**: Duplicate Paystack webhook deliveries could trigger multiple payment state checks if processed concurrently before the idempotency record finishes writing.
- **Scope**: Enhance `src/modules/webhooks/webhooks.service.ts` with atomic database locks and unique constraint checks on Paystack event IDs.
- **Acceptance Criteria**:
  - Idempotency guard rejecting duplicate webhook event IDs (`event.id`).
  - Return HTTP 200 OK for already-processed webhook events without re-executing handlers.
  - Integration test testing concurrent duplicate webhook requests.
- **Relevant Area**: Backend
- **Difficulty**: Medium
- **Potential Skills**: TypeScript, Node.js, PostgreSQL, Prisma

---

### Issue 3: Implement exponential backoff and maximum retry policy for Soroban RPC submission failures
- **Problem**: `SettlementWorker` currently retries failed Soroban RPC submissions immediately, which can exhaust RPC rate limits during brief Testnet node downtime.
- **Scope**: Refactor `src/workers/settlements.worker.ts` to implement exponential backoff (e.g., 2s, 4s, 8s, 16s) with a maximum retry count before marking an order as `REQUIRES_RECONCILIATION`.
- **Acceptance Criteria**:
  - Configurable max retry attempts (e.g. 5) with exponential backoff delay.
  - Log structured retry count and delay duration.
  - Unit tests verifying backoff schedule.
- **Relevant Area**: Backend
- **Difficulty**: Medium
- **Potential Skills**: TypeScript, Node.js, Stellar SDK / Soroban RPC

---

### Issue 4: Add provider fallback and failure handling in RealFxQuoteProvider
- **Problem**: `RealFxQuoteProvider` relies solely on `open.er-api.com`. If that external rate provider is unreachable or times out, quote generation fails without falling back to backup FX rate sources.
- **Scope**: Enhance `src/modules/quotes/real-fx-provider.ts` to support fallback FX provider APIs and rate caching when external endpoints fail.
- **Acceptance Criteria**:
  - Gracefully catch network timeouts from primary FX API.
  - Use cached exchange rates (with freshness check) or fallback rate endpoint.
  - Unit tests for fallback scenarios.
- **Relevant Area**: Backend
- **Difficulty**: Medium
- **Potential Skills**: TypeScript, Axios / Fetch, Caching

---

### Issue 5: Implement structured JSON logging middleware with correlation IDs across all request handlers
- **Problem**: Current backend logs use standard console strings without request correlation IDs (`x-request-id`), making log tracing across API endpoints and background workers difficult.
- **Scope**: Add request ID generation middleware in `src/middleware/request-id.ts` and structured JSON logger wrapper (`src/utils/logger.ts`).
- **Acceptance Criteria**:
  - Middleware generating or forwarding `X-Request-ID` header.
  - Structured JSON logs containing timestamp, log level, requestId, path, and duration.
  - Unit test for request-id middleware.
- **Relevant Area**: Backend
- **Difficulty**: Easy
- **Potential Skills**: TypeScript, Express Middleware, Logging

---

### Issue 6: Generate OpenAPI / Swagger 3.0 API documentation spec and interactive UI
- **Problem**: The backend currently relies on markdown documentation; external developers lack an interactive Swagger UI or OpenAPI 3.0 specification for endpoint testing.
- **Scope**: Add `swagger-ui-express` or `zod-to-openapi` schema generation in `src/docs/openapi.ts` exposing `/api/v1/docs`.
- **Acceptance Criteria**:
  - Interactive Swagger UI accessible at `/api/v1/docs`.
  - Valid OpenAPI 3.0 JSON specification matching Zod request schemas.
  - Integration test verifying docs endpoint loads cleanly.
- **Relevant Area**: Backend
- **Difficulty**: Easy / Medium
- **Potential Skills**: TypeScript, Express, OpenAPI, Swagger

---

### Issue 7: Implement IP-based and user-based API rate limiting middleware
- **Problem**: Public endpoints (`POST /quotes`, `POST /auth/login`) need explicit rate limit rules to prevent brute-force attacks and quote endpoint abuse.
- **Scope**: Add `express-rate-limit` configurations for quote requests (e.g. 30 requests/minute) and login attempts (e.g. 5 attempts/minute).
- **Acceptance Criteria**:
  - Rate limiters applied to `/api/v1/auth/login` and `/api/v1/quotes`.
  - Return HTTP 429 Too Many Requests with retry-after headers when exceeded.
  - Unit tests for rate limiter middleware.
- **Relevant Area**: Backend
- **Difficulty**: Easy
- **Potential Skills**: TypeScript, Express, Rate Limiting

---

### Issue 8: Implement settlement timeout handling and notification trigger for stuck processing orders
- **Problem**: If the background `SettlementWorker` process crashes mid-execution, an order may remain stuck in `PROCESSING` status forever.
- **Scope**: Add a watchdog monitor in `src/modules/settlements/settlements.service.ts` that detects orders in `PROCESSING` state for over 10 minutes and resets them to `SETTLEMENT_PENDING` or flags them for review.
- **Acceptance Criteria**:
  - Timeout detector identifying orders stuck in `PROCESSING` > 10 mins.
  - Automatic reset to queue or status transition to `REQUIRES_RECONCILIATION`.
  - Unit test for watchdog logic.
- **Relevant Area**: Backend
- **Difficulty**: Medium
- **Potential Skills**: TypeScript, Node.js, Prisma, Vitest

---

### Issue 9: Add Paystack transaction batch verification CLI tool
- **Problem**: Operators need a CLI command to reconcile NGN transactions directly against Paystack's API for accounting and audit audits.
- **Scope**: Add a CLI script `scripts/reconcile-paystack.ts` that fetches transaction lists from Paystack and compares them against database `Payment` records.
- **Acceptance Criteria**:
  - Executable CLI script with date range and status flags.
  - Report output highlighting discrepancies between Paystack and database.
  - Unit tests for reconciliation logic.
- **Relevant Area**: Backend
- **Difficulty**: Medium
- **Potential Skills**: TypeScript, Node.js CLI, Paystack API

---

### Issue 10: Expand integration test suite for multi-user concurrency and order idempotency
- **Problem**: While unit test coverage is high (143 tests), integration tests testing rapid concurrent order creation with duplicate idempotency keys need expanded test coverage.
- **Scope**: Extend `tests/payments/concurrency.test.ts` to test high-concurrency order submissions with identical `Idempotency-Key` headers under load.
- **Acceptance Criteria**:
  - Concurrency test firing 20 simultaneous requests with duplicate idempotency key.
  - Exactly 1 order created; 19 requests return the cached original response.
  - 100% test pass rate.
- **Relevant Area**: Backend
- **Difficulty**: Medium
- **Potential Skills**: TypeScript, Vitest, Supertest, Concurrency

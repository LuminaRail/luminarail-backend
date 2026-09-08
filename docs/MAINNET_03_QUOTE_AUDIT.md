# MAINNET-03 — NGN → USDC Quote Engine Audit

## Executive Summary
This document provides a comprehensive security, precision, and architecture audit of the quote engine in `luminarail-backend` prior to MAINNET-03 production hardening.

---

## Current Architecture Flow

```
Client -> GET/POST /api/v1/quotes -> QuoteService.createQuote()
                                             |
                                  QuoteProvider.calculate()
                                             |
                              Persist Quote in DB (Status: ACTIVE)
                                             |
                                  Return Quote JSON to Client
                                             |
Client -> POST /api/v1/orders (with quoteId) -> OrderService.createOrder()
                                                     |
                                        Validate Quote Freshness & Status
                                                     |
                                   Atomic Liquidity Reservation (MAINNET-02)
                                                     |
                                        Mark Quote as USED in DB
                                                     |
                                        Order Created (Status: CREATED)
```

---

## Detailed Components Audit

### 1. Quote Endpoints (`src/modules/quotes/index.ts`)
- **GET `/api/v1/quotes`**: Accepts query parameters (`sourceCurrency`, `destinationAsset`, `amount`).
- **POST `/api/v1/quotes`**: Accepts JSON body (`sourceCurrency`, `destinationAsset`, `amount`, `side`).
- **GET `/api/v1/quotes/:id`**: Fetches quote details and updates status to `EXPIRED` if `expiresAt` has passed.

### 2. Quote Service (`src/modules/quotes/quotes.service.ts`)
- Provider Selection: Checks `config.quotes.provider` or `NODE_ENV`. If `'mock'`, uses `MockQuoteProvider`; otherwise uses `RealFXQuoteProvider`.
- Expiry Calculation: `config.quotes.expirySeconds || 30` seconds.
- Persistence: Stores `sourceAmount`, `destinationAmount`, `exchangeRate`, `fee`, `provider`, `status`, `expiresAt`.

### 3. FX Rate Providers (`src/modules/quotes/providers/`)
- **`MockQuoteProvider`**:
  - Uses static dictionary of rates (`NGN_USDC: 0.00066667`).
  - Applies hardcoded 1% fee.
  - Floating point calculations (`parseFloat(sourceAmt.toFixed(4))`).
- **`RealFXQuoteProvider`**:
  - Fetches external rate from Open Exchange Rates API (`https://open.er-api.com/v6/latest/USD`).
  - 5-second timeout via `AbortController`.
  - Calculates `rawRate = 1 / rateNgn`.
  - Uses standard JavaScript floating point arithmetic (`number`), resulting in potential floating point rounding errors (`0.1 + 0.2 !== 0.3`).

### 4. Order Service Integration (`src/modules/orders/orders.service.ts`)
- Retrieves `Quote` by `quoteId`.
- Checks `status !== EXPIRED`, `status !== USED`, `status !== CANCELLED`, `now <= quote.expiresAt`.
- Uses `quote.destinationAmount` and `quote.sourceAmount` to construct the order.
- Reserves liquidity atomically via `LiquidityService.reserveForOrderInTx` inside a Prisma transaction with PostgreSQL row locking (`SELECT FOR UPDATE`).

---

## Identified Risks & Vulnerabilities

1. **Floating Point Precision Risk**: Quote calculations currently use JS `number` types. Financial calculations must use exact fixed-point `Decimal` arithmetic to avoid fractional cent rounding drift.
2. **Missing Liquidity Awareness**: Generating a quote currently does not check if the treasury has sufficient liquidity for the requested amount. The user only discovers liquidity shortages at order creation time.
3. **FX Stale Rate Protection**: `RealFXQuoteProvider` reads `time_last_update_unix` from the provider response, but does not reject rates older than an acceptable max age (e.g., 5 minutes).
4. **Transaction Limits**: Lack of explicit min/max NGN boundaries allows zero, negative, fractional, or excessively large amounts to be quoted.
5. **Quote Model Gaps**: The current `Quote` model lacks explicit tracking for base FX rate vs. applied FX rate (with spread), gross USDC amount, network fees, and liquidity availability.

---

## Recommendations for MAINNET-03 Hardening

1. **Canonical Quote Model**: Extend `Quote` model and return structure to include `grossUsdcAmount`, `networkFeeUsdc`, `spread`, `baseFxRate`, `rateTimestamp`, `liquidityAvailable`, and `version`.
2. **Exact Decimal Arithmetic**: Refactor all provider calculations and quote service logic to use `Prisma.Decimal` with explicit rounding modes (`ROUND_DOWN` for payout destination, `ROUND_UP` for platform fees).
3. **Liquidity-Aware Quote Generation**: Check `LiquidityService.getAvailableLiquidity()` during quote creation without creating a reservation. Set `liquidityAvailable = (availableBalance >= destinationAmount)`.
4. **Stale Rate & Circuit Breaker Enforcement**: Reject FX rates older than `FX_RATE_MAX_AGE_SECONDS`. Reject zero, negative, NaN, infinite, or malformed rates with explicit `502 Bad Gateway` errors.
5. **Quote Expiration & Limits**: Enforce configurable `QUOTE_TTL_SECONDS` (default: 300s) and bounds (`MIN_NGN_AMOUNT: 1000`, `MAX_NGN_AMOUNT: 10,000,000`).

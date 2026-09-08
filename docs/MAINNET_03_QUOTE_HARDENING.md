# MAINNET-03 — Production Quote Hardening Specification

## Overview
This document specifies the production quote hardening rules, canonical quote model, calculation formulas, precision policies, and safety checks for the LuminaRail NGN → USDC quote engine.

---

## 1. Canonical Quote Model

The quote model standardizes all NGN → USDC conversion metadata:

| Field | Type | Description |
| :--- | :--- | :--- |
| `quoteId` | String (UUID) | Unique identifier for the quote |
| `sourceCurrency` | String | Source currency (`NGN`) |
| `destinationAsset` | String | Destination asset (`USDC`) |
| `sourceAmount` | Decimal (18, 4) | User input NGN amount |
| `grossUsdcAmount` | Decimal (18, 7) | USDC amount before platform fees/spread |
| `fee` | Decimal (18, 4) | Platform fee in NGN |
| `networkFeeUsdc` | Decimal (18, 7) | On-chain network gas fee in USDC |
| `spread` | Decimal (18, 6) | FX spread percentage applied (e.g., `0.005` for 0.5%) |
| `baseFxRate` | Decimal (18, 6) | Raw FX rate from provider (1 NGN = X USD/USDC) |
| `appliedFxRate` | Decimal (18, 6) | Effective rate = `baseFxRate * (1 - spread)` |
| `destinationAmount` | Decimal (18, 7) | Net USDC amount delivered to user |
| `provider` | String | FX rate source identifier (`REAL_FX_PROVIDER`, `MOCK_QUOTE_PROVIDER`) |
| `rateTimestamp` | DateTime | Timestamp when FX provider produced the rate |
| `liquidityAvailable` | Boolean | True if treasury currently has sufficient unreserved USDC |
| `version` | Int | Quote schema version (default: `1`) |
| `status` | Enum | `ACTIVE`, `EXPIRED`, `USED`, `CANCELLED` |
| `expiresAt` | DateTime | Expiration timestamp (`createdAt + QUOTE_TTL_SECONDS`) |

---

## 2. Deterministic Calculation Formula

For an input NGN amount ($A_{\text{NGN}}$):

1. **Platform Fee**:
   $$\text{Fee}_{\text{NGN}} = \text{ceil}(A_{\text{NGN}} \times \text{feePercentage}, 4 \text{ decimals})$$
2. **Net NGN Amount**:
   $$\text{Net}_{\text{NGN}} = A_{\text{NGN}} - \text{Fee}_{\text{NGN}}$$
3. **FX Spread & Applied Rate**:
   $$\text{AppliedRate} = \text{baseFxRate} \times (1 - \text{spread})$$
4. **Gross USDC**:
   $$A_{\text{USDC, gross}} = \text{trunc}(A_{\text{NGN}} \times \text{baseFxRate}, 7 \text{ decimals})$$
5. **Net USDC Payout**:
   $$A_{\text{USDC, net}} = \text{trunc}(\text{Net}_{\text{NGN}} \times \text{AppliedRate} - \text{networkFeeUsdc}, 7 \text{ decimals})$$

### Rounding & Precision Rules
- **Decimal Library**: All monetary calculations use `Prisma.Decimal` (fixed-point arithmetic). Floating point (`number`) operations are strictly forbidden.
- **Payout Amount Rounding**: `Decimal.ROUND_DOWN` (truncated at 7 decimals) ensures the payout never exceeds the authorized quote.
- **Platform Fee Rounding**: `Decimal.ROUND_UP` (at 4 decimals) ensures platform fee collection is exact and non-lossy.

---

## 3. FX Freshness & Fail-Safe Policy

- **Max FX Age**: FX rates older than `FX_RATE_MAX_AGE_SECONDS` (default: 300 seconds / 5 minutes) are rejected.
- **Circuit Breaker**: Zero, negative, NaN, infinite, or missing FX rates cause an immediate `502 Bad Gateway` error (`FX_PROVIDER_INVALID_RATE`).
- **Fail-Safe**: If the FX provider fails, the quote engine **NEVER** silently falls back to a hardcoded or stale rate.

---

## 4. Quote TTL & Expiration

- Default `QUOTE_TTL_SECONDS` is set to 300 seconds (5 minutes) in test/dev configuration.
- Quotes transition automatically to `EXPIRED` if `now > expiresAt`.
- **Order Creation Re-validation**: `OrderService.createOrder` re-verifies quote freshness (`now <= quote.expiresAt`) and status (`ACTIVE`) before creating an order.

---

## 5. Liquidity-Aware Quoting vs. Order Reservation

> [!IMPORTANT]
> **QUOTE CREATION DOES NOT RESERVE LIQUIDITY.**
> **ORDER CREATION DOES.**

- During quote generation, `LiquidityService.getAvailableLiquidity()` checks whether $\text{availableBalance} \ge A_{\text{USDC, net}}$ without placing a lock or reservation.
- During order creation, `OrderService.createOrder` calls `LiquidityService.reserveForOrderInTx()` within a database transaction holding a PostgreSQL row lock (`SELECT FOR UPDATE`), guaranteeing atomic reservation.
- If liquidity vanishes between quote creation and order creation, order creation fails safely with `400 Bad Request` (`INSUFFICIENT_LIQUIDITY`).

---

## 6. Limits & Security Protections

- `MIN_NGN_AMOUNT`: 1,000 NGN
- `MAX_NGN_AMOUNT`: 10,000,000 NGN
- `MAX_QUOTE_USDC_AMOUNT`: 10,000 USDC
- Client requests cannot specify or override the FX rate, fee, spread, or USDC payout amount.
- Re-using a `USED`, `EXPIRED`, or `CANCELLED` quote for order creation is strictly blocked.

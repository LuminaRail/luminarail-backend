# MAINNET-05: Observability, Metrics & Incident Response Architecture

> **Notice**: This document outlines the audit of existing logging/observability capabilities in LuminaRail backend commit `edb74b2`, and designs the minimum production observability model, metrics framework, and incident runbooks. No application source code has been altered during this audit.

---

## Executive Summary

Operating real-money payment routing and automated smart contract settlement requires immediate, unambiguous visibility into every state transition. 

Currently, the LuminaRail backend uses basic `console.log()` and `console.error()` statements without correlation IDs, structured JSON format, or unified metric collectors. In a production incident, operators cannot reliably trace an individual customer order across HTTP requests, webhook callbacks, liquidity reservations, and Stellar RPC invocations.

This document establishes the **Production Observability Model**, defining structured audit event schemas, correlation ID propagation rules, critical alerts, and 5 step-by-step **Incident Runbooks**.

---

## 1. Audit of Operator Visibility Capabilities

| Diagnostic Question | Current Ability to Answer | Audit Finding & Gap |
| :--- | :---: | :--- |
| **What happened to order X?** | ⚠️ Partial | Can view `Order` record in database via `GET /api/v1/orders/:id`, but cannot view state transition timeline or error cause if order failed silently. |
| **Was customer charged in NGN?** | ⚠️ Partial | `Payment` record exists if webhook arrived; if webhook failed or was delayed, database shows `UNPAID` even if customer bank was debited. |
| **Was liquidity reserved?** | ✅ Yes | `LiquidityReservation` record linked to `orderId` shows status (`RESERVED`, `CONFIRMED`, `RELEASED`, `EXPIRED`). |
| **Was payment confirmed?** | ✅ Yes | `Payment.status` shows `SUCCEEDED` or `FAILED`. |
| **Was settlement attempted?** | ⚠️ Partial | `SettlementTransaction` record is created when signing starts, but attempt retry count and RPC round-trips are not logged. |
| **Was transaction submitted to Stellar?** | ⚠️ Partial | Transaction hash stored if submission succeeded; if RPC timed out during submission, state remains `PENDING` with unknown blockchain status. |
| **Did Stellar confirm transaction?** | ✅ Yes | `txHash`, `ledgerSequence`, `settledAt` saved on completion. |
| **Was USDC delivered to recipient?** | ✅ Yes | Confirmed via Soroban event / Horizon transaction status. |
| **Was liquidity consumed / released?** | ✅ Yes | `LiquidityReservation` updated to `RELEASED` or `CONSUMED`. |
| **Was a refund initiated / completed?** | ❌ No | **ZERO VISIBILITY**. No refund model or refund audit events exist in current code. |

---

## 2. Production Observability Model Design

### 2.1 Correlation ID Propagation Middleware
Every incoming HTTP request, background worker iteration, and webhook callback MUST generate or preserve a unique `traceId` (UUID v4) and attach it to the request context (`req.traceId`) and async local storage.

```typescript
// Proposed Correlation ID Middleware Structure
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const traceId = (req.headers['x-correlation-id'] as string) || crypto.randomUUID();
  req.traceId = traceId;
  res.setHeader('X-Correlation-ID', traceId);
  
  // Store in AsyncLocalStorage for automatic inclusion in all logger calls
  loggerStore.run({ traceId }, () => {
    next();
  });
}
```

### 2.2 Standardized Structured JSON Audit Logs
All logs MUST be output as single-line JSON to `stdout`/`stderr` using a high-performance logger (e.g. Pino). Every log entry MUST contain context metadata.

#### Standard Log Schema:
```json
{
  "timestamp": "2026-09-09T12:00:00.123Z",
  "level": "info",
  "service": "luminarail-backend",
  "environment": "production",
  "traceId": "c8f91a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b",
  "orderId": "ord_99481204812",
  "userId": "usr_1029384",
  "eventType": "ORDER_SETTLEMENT_SUBMITTED",
  "message": "Settlement transaction submitted to Stellar RPC",
  "details": {
    "amountUsdc": 250.00,
    "destinationAddress": "G...XYZ",
    "stellarTxHash": "a1b2c3d4e5f6...",
    "ledgerSequence": 5120491
  }
}
```

---

## 3. Essential System Metrics & Alerts

The production deployment MUST expose Prometheus metrics via `/metrics` (restricted to internal scraper IPs).

### 3.1 Key Operational Metrics
1. `luminarail_orders_created_total{status}`: Counter of orders created by status.
2. `luminarail_payments_received_total{status, provider}`: Counter of Paystack payments processed.
3. `luminarail_settlements_completed_total{status}`: Counter of Stellar settlements (`SUCCESS`, `FAILED`).
4. `luminarail_settlement_duration_seconds`: Histogram of end-to-end settlement latency.
5. `luminarail_treasury_usdc_balance`: Gauge of hot wallet available USDC balance.
6. `luminarail_treasury_reserved_usdc`: Gauge of locked liquidity reservation total.
7. `luminarail_reconciliation_mismatches_total`: Counter of detected ledger vs. Paystack mismatches.
8. `luminarail_refunds_processed_total{type, status}`: Counter of automated and manual refunds.

### 3.2 Critical Production Alerts

| Alert Name | Trigger Condition | Severity | Action Required |
| :--- | :--- | :---: | :--- |
| `HotWalletLowBalance` | `luminarail_treasury_usdc_balance < 5000` for > 5m | 🔴 **CRITICAL** | Page Treasury Operator to top up hot wallet. |
| `SettlementFailureSpike` | `rate(luminarail_settlements_completed_total{status="FAILED"}[5m]) > 0.05` | 🔴 **CRITICAL** | Page On-Call Engineer. Check Stellar RPC health & hot wallet sequence numbers. |
| `ReconciliationDivergence` | `luminarail_reconciliation_mismatches_total > 0` | 🔴 **CRITICAL** | Page Finance & Operations. Halt automated settlement worker. |
| `LateWebhookLiquidityDeadlock` | Log event `LATE_WEBHOOK_RESERVATION_EXPIRED` triggered | 🟠 **HIGH** | Trigger automated refund worker; alert support. |
| `PaystackVerificationFailure` | `rate(paystack_api_errors_total[5m]) > 0.1` | 🟠 **HIGH** | Inspect Paystack API status; trigger fallback reconciliation worker. |

---

## 4. Operational Incident Runbooks

---

### RUNBOOK 1: Emergency Global Pause Execution & Recovery

#### Trigger:
* Severe vulnerability detected, smart contract exploit attempt, double-spend anomaly, or rogue admin action.

#### Execution Procedure (Activating Pause):
1. **Trigger Emergency Pause via API or CLI**:
   * Issue HTTP POST to `/api/v1/treasury/pause` with Admin JWT.
   * Or set environment variable `EMERGENCY_GLOBAL_PAUSE=true` and perform rolling restart.
2. **Verify System Halt**:
   * Check that all incoming `/quotes`, `/orders`, `/payments`, and `/settlements` return HTTP 503 `SERVICE_PAUSED`.
   * Confirm that background settlement workers halt loop processing immediately.
3. **Notify Stakeholders**: Broadcast incident banner on status page and inform Compliance/Finance teams.

#### Recovery Procedure (Unpausing):
1. **Resolve Root Cause**: Verify that vulnerability, RPC issue, or financial divergence is fully patched and verified in staging.
2. **Dual-Control Authorization**: Require signature/approval from 2 Super Admins and 1 Compliance Officer.
3. **Execute Unpause**:
   * Issue HTTP POST to `/api/v1/treasury/unpause` with dual authorization tokens.
4. **Monitor First 50 Transactions**: Validate liquidity reservation lifecycle, Paystack webhook matching, and Stellar ledger finality for 30 minutes.

---

### RUNBOOK 2: Hot Wallet Low Liquidity / Exhaustion

#### Trigger:
* Alert `HotWalletLowBalance` fires (`treasury_usdc_balance < $5,000`).

#### Step-by-Step Resolution:
1. **Inspect Active Outflow Velocity**: View dashboard for pending `SETTLEMENT_PENDING` volume.
2. **Initiate Cold-to-Hot Treasury Transfer**:
   * Transfer required USDC from Multisig Cold Storage to Hot Wallet Address (`STELLAR_SETTLEMENT_SIGNER_PUBLIC_KEY`).
3. **Verify On-Chain Deposit**:
   * Inspect Stellar Explorer / Horizon endpoint to confirm USDC balance increase.
4. **Trigger Manual Worker Refresh**:
   * Force `LiquidityService.checkTreasuryBalance()` run to clear low-balance circuit breaker.
5. **Clear Alert**: Confirm `luminarail_treasury_usdc_balance` returns above threshold.

---

### RUNBOOK 3: Paystack Webhook Outage / Reconciliation Recovery

#### Trigger:
* Paystack webhook delivery service experiences downtime, resulting in customers being charged in NGN while LuminaRail orders remain stuck in `PENDING_PAYMENT`.

#### Step-by-Step Resolution:
1. **Confirm Paystack API Operational Status**: Check `https://status.paystack.com`.
2. **Trigger Reconciliation Worker**:
   * Execute manual CLI trigger: `npm run worker:reconcile -- --hours=4`.
   * The worker queries Paystack `/transaction/verify/:reference` for all `PENDING_PAYMENT` orders created in the last 4 hours.
3. **Process Missing Webhook Events**:
   * For verified payments:
     * If `LiquidityReservation` is `CONFIRMED`: Transition order to `SETTLEMENT_PENDING` and queue for settlement.
     * If `LiquidityReservation` is `EXPIRED`: Mark order for `AUTOMATED_REFUND` (late webhook recovery).
4. **Verify Zero Customer Loss**: Ensure all debited customers either received USDC settlement or have an active refund tracking record.

---

### RUNBOOK 4: Stellar RPC / Network Outage Handling

#### Trigger:
* Stellar RPC endpoint times out or returns 500 errors during transaction submission or status polling.

#### Step-by-Step Resolution:
1. **Inspect Stellar RPC Health**: Query primary (`STELLAR_RPC_URL`) and secondary RPC nodes.
2. **Failover RPC Endpoint**:
   * Update `STELLAR_RPC_URL` to backup endpoint (e.g. switch from primary FastStellar to QuickNode fallback) via runtime config or container environment reload.
3. **Handle Unknown Blockchain Submission State**:
   * For settlements marked `SUBMITTED_UNKNOWN`:
   * **DO NOT RESUBMIT IMMEDIATELY** (prevents double payout).
   * Query Horizon `/transactions/:hash` using pre-calculated transaction hash.
   * If transaction exists on ledger: Mark `SettlementTransaction` as `SUCCESS`, transition order to `COMPLETED`.
   * If transaction does NOT exist after 100 ledgers (~10 minutes): Clear submission lock and allow retry engine to resubmit with fresh sequence number.

---

### RUNBOOK 5: Double Payout / Ledger Divergence Investigation

#### Trigger:
* Alert `ReconciliationDivergence` fires, or treasury balance drops faster than recorded order volume.

#### Step-by-Step Resolution:
1. **IMMEDIATE HALT**: Activate `EMERGENCY_GLOBAL_PAUSE=true` immediately.
2. **Export Treasury Ledger vs. On-Chain History**:
   * Dump `SettlementTransaction` DB records for last 24 hours.
   * Fetch all outgoing USDC payment operations from Stellar Horizon for hot wallet address.
3. **Run Automated Hash Diff Script**:
   ```bash
   npm run audit:diff-treasury -- --from="2026-09-08" --to="2026-09-09"
   ```
4. **Identify Divergent Transaction**:
   * Match each on-chain transaction hash to `SettlementTransaction.stellarTxHash`.
   * Identify any on-chain transfer missing a corresponding `COMPLETED` order record.
5. **Freeze Affected Customer / Wallet**: Suspend user account and place destination wallet on blocklist.
6. **Generate Post-Mortem Incident Report**: Document root cause (e.g. worker race condition, sequence number reuse) and issue fix before unpausing system.

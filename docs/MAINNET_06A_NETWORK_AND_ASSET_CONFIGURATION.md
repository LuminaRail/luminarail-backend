# MAINNET-06A — Network & Asset Configuration Specification

**Date:** September 9, 2026  
**System:** LuminaRail Modular Settlement Infrastructure  
**Scope:** Production Network, Configuration & USDC Safety Specification  
**Status:** **ACTIVE & ENFORCED**

---

## 1. Environment Model

LuminaRail defines three explicit environment tiers managed by `NODE_ENV`:

| Environment | Purpose | Network Allowed | Signer Allowed | Settlement Enablement |
| :--- | :--- | :--- | :--- | :--- |
| `development` / `test` | Local development & unit/integration testing | `testnet` / `futurenet` | `testnet_local` | Disabled (`false`) |
| `staging` | Staging / UAT pre-production sandbox | `testnet` / `public` / `mainnet` | `testnet_local` / KMS | Conditional |
| `production` | Public Mainnet real-money production | `public` / `mainnet` | KMS / HSM (`aws_kms`, `gcp_kms`, `fireblocks`) | Fail-Closed Guard |

---

## 2. Fail-Closed Production Rules

The system implements a fail-closed Zod configuration validation model (`src/config/index.ts`) combined with an explicit runtime safety guard (`assertProductionSettlementSafety()` in `src/stellar/config/index.ts`).

### Fail-Closed Validation Invariants
1. **No Silent Fallback:** Testnet network, testnet asset issuers, and local process memory signers are strictly forbidden in production mode.
2. **Explicit Mainnet Network:** `NODE_ENV === 'production'` requires `STELLAR_NETWORK === 'public' | 'mainnet'`.
3. **Canonical USDC Asset Alignment:**
   - Public/Mainnet networks require Circle Official Mainnet USDC Issuer: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
   - Public/Mainnet networks require Circle Official Mainnet Soroban Contract ID: `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`
4. **Signer Safety Barrier:** `STELLAR_SIGNER_PROVIDER` cannot be `testnet_local` when running in `production` or on `public`/`mainnet` networks.
5. **Paystack Key Protection:** If `NGN_PROVIDER === 'paystack'`, production mode requires live keys (`sk_live_...`) and rejects test keys (`sk_test_...`).
6. **Settlement Enablement Guard:** Setting `PRODUCTION_SETTLEMENT_ENABLED=true` fails validation unless mainnet network, Circle mainnet issuer, and non-local signer provider are all present simultaneously.

---

## 3. Canonical Stellar & Soroban Asset Identities

### Stellar Public Mainnet
- **Stellar Classic USDC Issuer:** `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
- **Soroban SEP-41 Contract ID:** `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`
- **Network Passphrase:** `"Public Global Stellar Network ; September 2015"`
- **Production RPC Endpoint:** High-availability Stellar Soroban RPC provider (e.g. Blockdaemon, Ankr, QuickNode).

### Stellar Testnet
- **Stellar Classic USDC Issuer:** `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
- **Soroban Contract ID:** `CBIELTK6YBZJU5UP2WWHLRHJB4EBHVGQZ22VJ2J53AEX4H5MHRG5U6PE`
- **Network Passphrase:** `"Test SDF Network ; September 2015"`
- **Testnet RPC Endpoint:** `https://soroban-testnet.stellar.org`

---

## 4. Single-Source Configuration Ownership

All settlement components (services, executors, state machines, policy engines, and asset validators) consume authoritative configuration strictly from `src/config/index.ts` and `src/stellar/config/index.ts`. No component may define ad-hoc asset identifiers or network overrides.

---

## 5. Security & Signer Dependency (Phase 6B Handoff)

While Phase 6A establishes complete fail-closed configuration and network safety, live production settlement submission remains blocked until **Phase 6B (Production KMS Signer)** is implemented, as `resolveTransactionSigner()` rejects `testnet_local` for mainnet transactions.

# Broker restart and account risk guard (SPX option entry)

## What was wrong before

- The legacy SPX scanner restores open trades from local SQLite, which may miss an order transmitted just before a crash.
- Local SQLite entries are not authoritative for what is actually held or working at IBKR.
- Legacy `SPX_MAX_PREMIUM = 5.00` is a price filter **not** permission to spend $500 when the broker account holds less.
- The TradingView route currently supports paper-only decisions; it does not prove that live orders are tracked after reconnect.

## New mandatory fail-closed check

The IBKR client reads *both* broker positions (`reqPositions` + `positionEnd`) and all visible open orders (`reqAllOpenOrders` + `openOrderEnd`), plus current buying power and available cash from IBKR, **before** transmitting a new options bracket entry.

- If another position exists (SPX or any other symbol), **no new option entry**.
- If an order is pending/submitted from any prior bot session or manual user, **no new option entry**.
- If a response is missing, partial, timed out, stale, from a different account or disconnected, **no new option entry**.
- If a local trade is still open, legacy engine's local-entry guards remain. At startup the bot also logs and warns when local and broker state differ.
- Only a single option contract is eligible. Cost = actual entry limit premium × 100; broker available funds **and** buying power must each cover that cost plus a $5 preliminary fee reserve.
- The account must match `IBKR_REQUIRED_ACCOUNT_ID` (no default/implicit account).
- Concurrent option entry requests within one bot process are rejected while one entry is pending.

### Current sizing interpretation

`SPX_MAX_PREMIUM = $5.00` stays unchanged as a separate maximum bid/ask contract filter in the legacy SPX scanner. **Real affordability is a stricter additional limit**, not the same thing as a premium cap. An account with $410.87 available could hypothetically cover one $3.00-premium ($300) contract plus fees but not one $5.00 ($500) contract. Quote validity, brokerage approval, risk limits and live permissions must also pass. This is **not authorization to enter any trade**.

## What this does NOT claim

- No live orders were placed, no IB Gateway connection from GitHub was started, and the code was not deployed to the server.
- The safety gate prevents additional entries on broker exposure, but it **does not yet recover ownership** of a pre-existing orphaned position and trail its stop. Correct recovery must match broker contract ID, position quantity, parent/child orders, stop permId/orderId, and fill history; ambiguous positions require intervention, not blind adoption.
- Broker snapshots aren't perfectly atomic across external clients/processes; multiple independent bots on the same account must not run.
- Stops and fills may slip; a 45% premium stop is not a guaranteed maximum loss.
- For low-latency SPX the old scanner still has 90-second entry and 30-second price-update timers. The paper event-driven engine is separate and not live integrated.

## Verification

`npx vitest run server/trading/broker-exposure-guard.test.ts`

Run production compile with `npm run build`. These are **code-level tests, not an IBKR paper gateway integration test**. Before live deployment, validate `reqPositions`, `reqAllOpenOrders` event flows through the installed `ib` library, simulate reconnects and unconfirmed bracket fills, and persist the last known broker-order identifiers.

Live status remains blocked until these broker-integration tests and server deployment are explicitly verified.


## Gateway interruption recovery fixes in this branch

- The supervisor checks the local IBKR Gateway socket every 5 seconds and retries reconnection with bounded backoff (5–60 seconds), without placing any trades.
- Interprets IBKR error 1100/2110 as backend interruption even if the local socket stays up, and 1101 as recovered backend **with lost subscriptions**. On 1101 the SPX/VIX market streams are explicitly re-requested. 1102 means subscriptions were retained. 1300 blocks; update the configured port separately.
- A routine price refresh must **not** declare recovery complete. The supervisor must verify account identity, completed positions and open-order snapshots, and fresh market data.
- Account-summary requests capture the original socket, clean up listeners safely after a disconnect, and reject incomplete/timeout snapshots instead of treating synthetic zeros as valid.
- Existing positions remain at the broker. An unmatched existing broker position is surfaced as a critical warning; its protective stop still requires full contract/order reconstruction, which is not implemented here.
- Any weekly IBKR Gateway reauthentication is not bypassed; user interaction may be required. Root cause of historical outages remains unverified without PM2/Gateway logs.

This change prevents new orders on a lost/unknown broker session but does NOT promise sub-second execution or uninterrupted Gateway uptime.

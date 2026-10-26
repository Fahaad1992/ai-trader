# SPX market-data and recovery mock verification — October 26, 2026

## Owner's delta question
Delta is **NOT an entry signal**. Uptrend/downtrend entry confirmation comes from the strategy, not a target Greek. Delta is a **soft ranking feature** for otherwise affordable/liquid SPX calls or puts, preferring ~0.32 when possible. An absolute-delta band 0.18–0.55 remains an outer risk/liquidity guard (reject ultra-far OTM lottery wings). No matching eligible SPX call/put means **no order**. Call delta should be positive, put delta negative; both are bought long.

## Code defect fixed
In `ibkr-client.ts`, the 13/model Greeks event used to clear the quote request timeout and erase the pending callback immediately, even though bid, ask and volume might not have arrived. This could keep the polling subscription alive indefinitely when price ticks never came. Now only the actual complete snapshot `finish()` owns timeout cleanup. Purely receiving delta does not mark the quote complete.

## Simulated Gateway cases
`server/trading/ibkr-option-snapshot.mock.test.ts` uses a mocked request interface — no socket, no broker connection, no real orders:
- Greeks arrive before bid/ask and no subsequent quote: timeout returns null, cancels quote subscription and erases in-memory request mapping.
- Greeks then verified live bid, ask and volume: returns matching requested SPX option with a real quote timestamp and cleans up the subscription.
- Delayed option data is rejected rather than counted as live.
- Missing volume or Greeks must time out; no indefinitely pending quote promise.

## Broker stop recovery strengthening
`server/options/stop-recovery.ts` now counts only `Submitted` and `PreSubmitted` as visible working protective stops. It rejects `PendingSubmit`, `ApiPending`, `Cancelled` and `Filled` as proof of a still-working stop after restart. These cases were added to the recovery tests.

## Verification boundary
GitHub Actions mock tests, TypeScript no-emit and production bundle build passed (workflow `spx-gateway-mock.yml`). **This is a synthetic mock only.** It does not prove broker acceptance, stop modification, a running persistent Gateway service, exchange option quote entitlements or recovery after a real IBKR process crash.

**Operational status:** NO-GO for unattended real-money order placement until actual IBKR paper Gateway tests cover a filled bracket, broker-acknowledged stop amendment using the original stop order, and process crash/reconnect with order reconciliation. DRY_RUN remains enabled.

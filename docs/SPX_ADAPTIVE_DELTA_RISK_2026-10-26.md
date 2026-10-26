# SPXW adaptive delta and funding-aware contract selection

**Status:** PAPER-ONLY selection logic. No real order placement, continuous bid stream or verified stop amendment adapter.

## Final scope
- **BUY one long SPXW CALL** for a confirmed uptrend, or **BUY one long SPXW PUT** for a confirmed downtrend.
- No short option sales, MES/futures, FOP, SPY or other markets; no order if broker ownership/reconciliation is unknown.
- Only IBKR verified live BID and ASK, quote age ≤2 seconds and matching requested strike/expiry.
- Select contracts with absolute delta **0.18–0.55**, target **0.32** (higher score for tighter spread and greater measured volume); correct sign: CALL positive, PUT negative.
- Never buy a very low-delta (<0.18) 'lottery wing' just to consume buying power.
- Option minimum ask $0.50, hard maximum ask $5.00, absolute spread ≤$0.30 **and** relative spread ≤8%, option volume ≥1; unknown values fail closed.
- Scan affordable out-of-the-money SPX strikes at 5–100 index points rather than only ±10 points; bounded IBKR parallel subscriptions (up to six), shared short-lived contract-chain cache; verify same contract. Uses **America/New_York** exchange-local expiry dates, skips 0DTE after 14:45 ET; IBKR chain must also validate actual listed holiday/session expiries.

## Account-aware limits (pure strategy policy, not guaranteed loss)
Before *every* paper selection the code retrieves IBKR account NetLiquidation, AvailableFunds, BuyingPower. Age at decision time ≤5s.

The maximum ask is bounded by the tightest of:
- $5.00 fixed hard limit.
- 55% of the minimum of IBKR available funds/buying power **after an $8 fee reserve**, divided by 100.
- 20% of IBKR net liquidating value divided by 45% initial planned premium loss and by 100.

With a sample $410.87 account, this gives **$1.82 maximum premium per share / $182 contract**, and about **$81.90 intended initial stop risk (20% equity)**, before slippage, fees and potential gap-through losses. A $3.00 option would be blocked at this portfolio size even if broker buying power technically allowed it. The full premium can still be lost.

**No matching affordable contract = no trade**. The bot must never relax risk thresholds or pretend capital is $1,000. Increasing account equity automatically increases the allowable per-contract premium up to the stated hard limits.

## Broker runtime compatibility
The historical code imported `ib` but `package.json` only installed `@stoqey/ib`. The adapter now instantiates the installed `IBApi` and parses its `(error,code,reqId)` error signature. CI checks a real class import and SQLite native module load; a live Gateway handshake is still required before deployment.

## Important unfinished features blocking live launch
- No complete IBKR paper Gateway validation of order fill and working bracket stop.
- No persistent streaming option BID after SPX order fill; legacy scan frequency remains 90 seconds, price refresh 30 seconds.
- Existing recovery journal is read-only unless a matched, broker-confirmed stop already exists; new real order mappings are not yet persisted from executions.
- No verified same-order-ID stop amendment/ACK loop after reconnect. Broker-side stops may not fill at the limit in fast conditions.
- The full historical test suite includes obsolete source-text assertions and network-dependent tests; **passing focused regression tests + TypeScript + production bundle is not equivalent to full end-to-end readiness**.

**Release decision: leave DRY_RUN enabled and don't deploy to live trading until an actual paper Gateway end-to-end test proves protection and restart behavior.**

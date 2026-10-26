# SPX pre-live safety audit — 2026-10-26

## VERDICT: **NO-GO for unattended real-money launch**

This review inspected GitHub source on `main`, IBKR account/market read-only snapshots, and GitHub Actions isolated and full-unit tests. It is **not** an end-to-end test of the persistent server, IB Gateway, or live bracket orders. No trading orders were sent and no server processes were started.

### Owner's permitted scope

- Instrument: **SPX / SPXW OPT, long single-leg BUY CALL or BUY PUT**; a purchased PUT is LONG PUT, **not a naked short**.
- No MES/MNQ/ES/NQ futures, no FOP options on futures, no SPY/QQQ/options on stocks, and no naked SELL to open.
- One long option contract maximum, provided sufficient funds and account risk limits are verified in real time.
- A confirmed broker-side protective SELL STP must be attached to the purchase before the bot treats the position as protected. Stops are not guaranteed execution prices.
- Existing live position or broker order, including an unknown one after reconnect, must block additional entries.

### Observed account / option snapshot

- IBKR account net-liquidation and available funds: **USD 410.87**, no open positions or working orders when read on 2026-10-26.
- IBKR connected market-data snapshot for SPX index showed `REALTIME`.
- Example 0DTE 2026-10-26 SPXW strike 7675: CALL ASK **$14.50**, delta ~+0.54, notional **$1,450**; PUT ASK **$10.70**, delta ~-0.46, notional **$1,070** (100x multiplier).
- Legacy scanner requires delta magnitude 0.40–0.60, maximum premium $5, max spread $0.30. This may yield **no affordable qualified contracts** for this account. Do not relax delta blindly into high-risk far-OTM 0DTE contracts.
- Separate preflight requires option premium × 100 + preliminary $5 commission reserve <= broker available funds and buying power. At $410.87 it imposes an illustrative **$4.05 max ask**, subject to contract tick, actual costs and other risk rules.
- A $3.00 long option with a $1.65 stop exposes **$135 theoretical per-contract premium risk** (32.9% of $410.87 equity) before slippage and fees; a gap or stop non-fill could risk up to all $300 premium.

### Principal critical findings and current branch remediations

| Area | Finding | State |
| --- | --- | --- |
| Long CALL/PUT | Legacy code labeled purchased PUT as SHORT; missing trend defaulted to PUT | Scope guard: both BUY-to-open, confirmed trend required; no naked short |
| Futures / other markets | Old MES/futures order paths and generic stock/option order API still exist | All futures order entry/modify and generic unsafeguarded orders fail closed; SPX-only runtime |
| TradingView alerts | Webhook was locked to `MES` rather than `SPX`; action BUY/SELL ambiguous | Webhook now accepts `SPX` only and direction `CALL`/`PUT` only, **paper/no live order**; existing alerts need change |
| Stale option data | Option snapshot used request completion time for bid/ask, and might silently substitute another strike | Require actual fresh live bid AND ask event receipt timestamps; reject unknown/delayed, crossed or substituted quotes |
| SPX monitor | Monitoring fell back to Polygon and old model updated stop from midpoint, not verified live option bid | SPX monitor fallback blocked until proper continuous IBKR option-BID stream |
| Initial stop / ladder | Initial 45% policy unified but legacy SPX profit-lock code differs from new isolated ladder | Legacy live stop amendments blocked; **full event-driven live integration still missing** |
| Duplicate stop | Legacy `syncBrokerStop` sent a new stand-alone SELL STP then canceled the previous | SPX legacy replace path blocked until in-place same-order-id ACK/reconciliation is built |
| Unprotected close | UI/manual or local close could cancel working broker STP then mark trade closed with no broker exit fill | Unsafe SPX local/manual close disabled; verified broker-close adapter required |
| Broker reboot | Matching journal and recovery are read-only; new real SPX fills do not populate journal | Existing recovery checks protect against guessed IDs; **actual live recovery / trailing not implemented** |
| DB initialization | Additive migration happened before the `trades` table existed on a fresh DB | Table now created before migration; existing trade records preserved |
| API control | Start, stop, settings, manual close and broker-connect write routes had no operator authentication | Require a strong Bearer `BOT_CONTROL_TOKEN`, fail closed if absent |
| Secrets | Webhook secret was saved in JSON log payload | Redacted in logged/stored JSON |
| False success | Start/close endpoints could return `ok:true` when action did nothing | Return blocked/error outcome where needed |
| Trade price updates | Updating copies returned by `getOpenTrades` discarded mutations | Update the actual in-memory `Trade` references |

### Test scenario coverage

**Covered by automated isolated/full-code tests (NOT broker end-to-end):**
- Long CALL and long PUT accepted by scope validator; naked SELL, wrong underlying/secType, extra quantity and MES/FUT rejected.
- Unknown/down/up trend decision semantics; no implicit PUT default.
- Stale/delayed/future/missing bid+ask, crossed quote and unsuitable price source are blocked.
- Account mismatch, insufficient buying power, pending orders, local/broker position mismatch, partially delivered broker snapshot, disconnected broker, duplicated entry.
- Stop recovery with matching contract, quantity, stop order ID and permId; missing/cancelled/mismatched stop blocked.
- Broker-protection-child status: PendingSubmit/ApiPending/Cancelled/Rejected/Filled is **not** accepted as a working stop.
- Paper stop ladder levels and never lower verified stop, gap-through mock exit, rejected amendment.
- TypeScript diagnostics and production bundle build without starting an app.

**UNTESTED / NO-GO until proven in real IBKR paper Gateway on actual server:**
1. Verify dedicated user/client ID/account, option permissions, SPXW tradingClass, conId, real minTick and live data subscriptions.
2. Submit single SPXW long option bracket in PAPER at an executable ASK; ensure broker confirms parent and child stop and the correct OCA/parent relationship. Never confuse request submission with accepted protection.
3. Force disconnect **between order submission and ACK**, after a partial fill, after parent fill, and during stop modification. Confirm one and only one position/stop on recovery.
4. Persist actual filled quantity, brokerage commission, parent/stop permIds/orderIds, and highest live bid **before** recovery decisions.
5. Restart the persistent process and Gateway. On recovery identify the original working stop; resume listening to the exact option contract live BID, modify the **same** stop ID and verify live broker ACK, price and quantity before updating SQLite.
6. Confirm broker side stop stays active through bot crash, market data outages, nightly Gateway maintenance / two-factor reauthentication.
7. Verify stop fills on fast gap/illiquid 0DTE SPXW, slippage, freeze/halts, expiration and cutoff; no overnight/expired stop assumption.
8. Restore order fills/executions during downtime and suppress any duplicate entries, orphaned protective stops, or duplicate close orders.
9. Confirm low-latency price subscription, exchange permissions/quote entitlement, stale quote fail-closed and reconnect metrics; current entry scan is **90 seconds**, position refresh **30 seconds**, unsuitable for SPX scalping.
10. Security review of reverse proxy and read endpoints, process lock preventing concurrent bots, secure operator token distribution, watchdog/alerts, encrypted credentials and database backup/recovery.
11. Validate real economic feasibility: option prices under cash cap with risk-per-trade, fees, buying-power, daily drawdown and minimum option price increments. Never widen allowable risk merely to force a trade.

### Stop schedule caveat

The user's illustrative 3.00 entry -> 1.65 stop, 3.50 -> 3.20, 4.00 -> 3.50, >4.00 -> 4.00 is covered in **pure preview/paper** modules only. The preview uses a provisional $0.01 price tick, whereas SPX option minimum increments vary by contract/price (the existing `spx-tick.ts` encodes $0.05 below $3, $0.10 at/above $3 for full-size contracts). The example 4.01 premium may not be a valid market quote. Use verified exchange contract increments and no live trailing until integration proves it.

### Explicit operational controls

- Keep `DRY_RUN=true` and `BE_FORCE_DRY_RUN=true`. `TRADE_MODE=spx_options`; default `options` is blocked at engine start.
- Do not interpret GitHub CI success as a successful API Gateway deployment, session authentication, price feed or broker stop ACK.
- Do not use the generic manual close UI to close an actual SPX position; use the broker's verified position management until safe closing adapter exists.
- No real-money test orders were placed, no live order was changed, and no running server was touched during this audit.

**Release decision:** Require paper broker round-trip including crash recovery and same-order-ID stop amendments, then independent server deployment and observation. Until then keep new live entries disabled.

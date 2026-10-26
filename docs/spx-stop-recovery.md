# SPX stop survival across disconnects — current implementation

## What currently works in code

1. **Initial broker bracket:** the legacy `ibkr-client.ts` has a BUY limit parent and GTC SELL stop child transmitted as one bracket; `live-safety.ts` checks broker child status. Actual paper/real broker acceptance must be proven on the server.
2. **Broker-first restart audit:** at startup and reconnect the engine obtains broker positions and all visible open orders, not just SQLite's local trades. New entry is blocked whenever exposure is present or the snapshot cannot be verified.
3. **Persistent stop journal:** `spx_stop_recovery` stores account ID, option conId, parent and stop IDs, stop permId, premium paid, last broker-confirmed stop, peak bid, quantity and contract identity. This table is **additive** and does not remove existing trades.
4. **Exact recovery check:** compare saved position to the account's actual SPX option (conId and quantity), exactly one working SELL STP child (ID, parent, permId, conId, quantity), and broker stop price. Never trust a canceled/missing stop, different contract, different account, stale or partial broker snapshot, or a lower stop.
5. **Never reset the stop:** if IBKR has a higher confirmed stop than the previous saved level, adopt and journal the broker's higher stop. Never mark a pending requested change as confirmed.
6. **Stop ladder preview:** the recovered state includes original entry premium and previous peak; a pure function can propose a raise from a new fresh LIVE bid, but cannot itself change IBKR.
7. **No repeated order:** no automatic second stop is created when the original stop is unknown. Ambiguous existing positions are blocked and highlighted.

## What is NOT ready (do not assume working live)

- Existing SPX-specific entry in `engine.ts` remains **DRY_RUN**. The new stop journal is not yet populated automatically from real SPX fills. Its write API `createVerifiedSPXStopRecord` / `saveVerifiedSPXStop` must be called only after broker-confirmed fills and protective stops, from an unimplemented live SPX adapter.
- Recovered-stop matching is currently **read-only**: no continuously running option bid subscription or IBKR in-place stop adjustment is wired to the recovered state. **Automatic live stop upgrades after a reconnect have not been completed**.
- The existing generic stop-updating method can create a replacement order rather than verify same-ID amendment; it should NOT be used to resume orphaned stops.
- Broker-side stop prices are not guaranteed fills. Exchange sessions and option tick sizes, expiring stops, partial fills, unsupported order types and Gateway reconnects need paper-Gateway integration tests.
- The GitHub CI job validates isolated algorithm tests and `npm run build`. It does not connect to IBKR, deploy to the server, place orders, or simulate actual exchange execution.

## Minimum acceptance tests before live SPX

- One 100-multiplier option entered with confirmed working protective STP GTC, parent and child IDs persisted after confirmed fill.
- Disconnect the bot after a fill; verify IBKR's broker-side stop remains working, including during a Gateway restart.
- Restart process and match conId, exact quantity, stop order ID, parent and permId; do not submit another order.
- Receive fresh option BID stream; on a new ladder level modify the exact existing stopOrderId, confirm working broker state and persist it; on rejection/disconnect leave the previous confirmed stop in place and alert.
- Gap through stop, partial fill, stop fill during downtime, manual stop cancellation, duplicate bot sessions, invalid option increments, and SPX expiration.
- Verify actual subscription market-data type LIVE, round trip latency, and recovery from IBKR maintenance reauthentication.

This feature is a **safe recovery foundation**, not a deployed self-trading system.

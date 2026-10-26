# Option premium trailing stop — isolated preview

This folder is a **non-executing, standalone** policy for long SPX/equity option positions. No service or production engine imports it yet. It does not place, amend, or cancel orders, start the bot, connect to IBKR, or mutate the environment. Futures behavior is unchanged.

## User's specified ladder — entry premium $3.00

| Highest verified live **BID** | Proposed stop premium |
| --- | --- |
| Initial entry $3.00 | $1.65 (45% initial premium risk) |
| $3.50 | $3.20 |
| $4.00 exactly | $3.50 |
| Above $4.00, e.g. $4.01 | $4.00 |
| Retraces to $4.00 | Leave existing confirmed stop in place; never lower |

Above $4.00, this **preview** uses a provisional, configurable additional $0.50 step, strictly *after* exceeding each new increment. Example: $4.51 proposes a $4.50 stop. This post-$4 continuation rule is **not approved for live**.

## Safeguards already in pure decision logic

- Validated live option **bid** only (not underlying index, last trade or midpoint), maximum age 2 seconds.
- Reject delayed, disconnected, stale, future, out-of-order and invalid market quotes.
- Never lower the last confirmed stop.
- Never propose another amendment while the prior one awaits broker acknowledgment.
- Do not mark a proposed stop as confirmed until a matching broker confirmation has been recorded by the integration.
- Reject stop proposals at or above current bid.
- Use the qualified contract's actual minimum tick in any future integration. The 0.01 default is only an example for testing.

## Required before any live trades (NOT implemented)

- Confirm active account, qualified option contract (right, strike, expiration, exchange), option quotes and exchange trading permissions.
- A broker-side emergency stop accepted and confirmed for every position; match the actual filled quantity, including partial fills.
- Broker order amendment by existing order ID, appropriate acknowledgments, rejected modifications, disconnect recovery, persistent peak/stop/order state, timeout handling and session controls.
- Realistic paper end-to-end tests covering slippage, gaps, market halts, execution rejects, stale data and wrong minimum tick.
- Verify affordability, costs and account risk limits. At $11.51 available funds, a standard option with a $3.00 premium generally costs around $300 (assuming 100 multiplier), before transaction fees.
- Stop orders are not guaranteed to fill at their stop price; broker supports and order types vary.

## Run checks

`npx vitest run server/options/premium-stop-ladder.test.ts`

The file remains completely disconnected from the existing engine until separate integration tests demonstrate its operational safety. **Do not disable DRY_RUN, modify .env, restart IB Gateway, or deploy live execution based on this preview.**

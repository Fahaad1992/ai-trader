# SPX Options — Real-Time Data Rule

> Owner decision. This rule is mandatory for all SPX Options work.

## Data Source

**IBKR is the required primary data source for SPX Options.**

- No Polygon fallback for SPX trading decisions.
- DRY_RUN must use the same data source as future LIVE (IBKR).
- Polygon $199 plan is not required now.

## Quote Freshness (owner-approved)

- `quoteAge = now - last option bid/ask timestamp`
- `quoteAge > 2000ms` → block with `SPX_QUOTE_STALE`
- Preferred quoteAge: `< 1000ms`
- Missing timestamp → block with `SPX_REALTIME_DATA_REQUIRED`
- Missing bid/ask → block with `SPX_PREMIUM_MISSING`

## Hard Rules

1. Never use 120 seconds or any arbitrary stale threshold as "fresh" for SPX.
2. Never call data fresh if it is delayed.
3. Telegram must show stale/delayed warnings clearly.
4. Frontend must show stale/delayed warnings clearly.
5. Trade entry must be blocked if quote freshness is not acceptable.
6. Reports must not present delayed data as current.
7. If data source is delayed, missing, or uncertain: block with `SPX_REALTIME_DATA_REQUIRED`.
8. Do not silently fall back to stale data.
9. Do not silently use MES or index price as option premium.
10. Do not use delayed data to justify any SPX trade.

## IBKR Requirements

- OPRA / US Options real-time data subscription
- CBOE Streaming Market Indexes for SPX index price
- SPX Options trading permission on account
- IBKR Gateway authenticated and connected
- No delayed/frozen data

## Architecture

- No full SPX option chain scan in LIVE.
- Monitor only 3–5 near-ATM SPX option contracts.
- Use `reqContractDetails` before accepting a selected contract.
- Use `reqMktData` for selected contracts.
- Require bid/ask, timestamp, quoteAge, and spread.
- IBKR disconnected → block all SPX trades.
- dataFarm disconnected → block all SPX trades.
- No Polygon fallback.

## Blocker Codes

| Code | Trigger |
|------|---------|
| `SPX_QUOTE_STALE` | quoteAge > 2000ms |
| `SPX_REALTIME_DATA_REQUIRED` | missing timestamp or no real-time source |
| `SPX_PREMIUM_MISSING` | bid=0 or ask=0 |

These block trade entry. No degraded/delayed mode is acceptable.

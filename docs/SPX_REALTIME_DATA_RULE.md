# SPX Options — Real-Time Data Rule

> Owner decision. This rule is mandatory for all SPX Options work.

## Rule

SPX Options scalping requires **real-time or near real-time data only**.

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

## Implementation Requirement

Before implementing any exact freshness threshold (e.g. 5 seconds, 10 seconds, 30 seconds), the developer **must ask the owner for explicit approval**.

Do not choose critical timing values silently.

## Applies To

- SPX index live price
- SPX option bid/ask
- Selected option quote
- Option chain data
- Telegram reports
- Bot dashboard / frontend
- Daily or live trade reports when describing active market state

## Blocker Code

If real-time data is not available:
```
SPX_REALTIME_DATA_REQUIRED
```

This blocks trade entry. No degraded/delayed mode is acceptable.

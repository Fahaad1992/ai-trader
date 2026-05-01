# ai-trader

Internal trading automation project (TypeScript + Express + better-sqlite3 + IBKR via @stoqey/ib).

## Status

Active development. **All execution paths are gated by DRY_RUN/effective-mode flags.** No trades are sent to live brokers without explicit operator authorization and matching environment configuration.

## Layout

```
server/         # backend, IBKR client, engine, telegram notify
src/            # frontend (React + Vite)
shared/         # shared TypeScript types
scripts/        # operator scripts (report-today, ibkr probes, …)
data/           # local SQLite DB (NOT committed)
docs/           # internal notes
```

## Scripts

- `npm run dev` — backend dev (tsx watch).
- `npm run dev:vite` — frontend dev.
- `npm run build` — production build (vite + esbuild).
- `npm run start` — start production bundle.
- `npm run report:trades:today` — read-only daily report from `data/trades.db`.

## Environment

Create a `.env` (NOT committed) with the keys your deployment needs. Example variables referenced in code:

```
# IBKR
IBKR_HOST=127.0.0.1
IBKR_PORT=4001
IBKR_CLIENT_ID=2
IBKR_REQUIRED_ACCOUNT_ID=               # MUST be set to lock trading to a specific account
USE_IBKR=true

# Mode flags (all should be set explicitly)
DRY_RUN=true
BE_FORCE_DRY_RUN=true
IBKR_MODE=paper        # paper | live
TRADING_MODE=paper     # paper | live
BOT_MODE=paper         # paper | live

# Data providers
POLYGON_API_KEY=
FINNHUB_API_KEY=

# Telegram
TG_TOKEN=
TG_CHAT_ID=
```

## Safety notes

- The bot enforces a per-account lock at runtime via `IBKR_REQUIRED_ACCOUNT_ID`. If unset, the gate denies trading.
- Multiple internal "DRY_RUN" mirrors must all be true to prevent any live order from being sent. Refer to `server/trading/engine.ts` and `isDryRunActive()` for the precise logic.
- `data/trades.db` and rotating PM2 logs are intentionally excluded from version control.

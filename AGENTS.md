# AGENTS.md

## Cursor Cloud specific instructions

### Overview

ai-trader is a TypeScript automated trading bot (Express backend + React/Vite frontend + SQLite). Target: SPX Options scalping. See `README.md` for layout and `HANDOVER_CURSOR_DEVELOPER.md` for full context.

### Running the app

- **Backend**: `pnpm run dev` (tsx watch on port 3000)
- **Frontend**: `pnpm run dev:vite` (Vite on port 5173, proxies `/api` to backend)

> **WARNING**: Do not run backend/frontend servers unless explicitly requested by the owner. For setup verification, prefer `pnpm run build` only.

### Key gotchas

- **Missing `ib` dependency**: The code imports `from "ib"` in `server/trading/ibkr-client.ts`, but `package.json` only declares `@stoqey/ib`. Run `pnpm add ib` if the package is missing after a clean install.
- **`better-sqlite3` native build**: `pnpm-workspace.yaml` sets `allowBuilds: better-sqlite3: false`, which blocks the native addon compilation. After `pnpm install`, you must manually build it:
  ```
  cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npm run build-release && cd /workspace
  ```
- **Fresh DB schema mismatch**: On a fresh `data/trades.db`, the migration in `database.ts` runs *before* `CREATE TABLE`, causing a crash. **Never delete `data/trades.db`. It may contain trade history.** If a schema mismatch happens, stop and report. Use a NULL-safe migration only after explicit owner approval.
- **DRY_RUN mode**: Always set `DRY_RUN=true` and `BE_FORCE_DRY_RUN=true` in `.env`. **Never flip `DRY_RUN=false`. Never call `/api/bot/start`. Never connect IBKR or Gateway unless explicitly instructed.**
- **MES Futures disabled**: `TRADE_MODE=futures` is no longer supported. The project target is SPX Options only. Set `TRADE_MODE=spx_options`.
- **IB Gateway** (Docker): Optional for dev. The bot runs in dry-run mode without it.

### SPX Options real-time data rule

Owner decision: SPX Options scalping requires real-time or near real-time data only.

- Never use 120 seconds or any arbitrary stale threshold as "fresh" for SPX.
- Never call data fresh if it is delayed.
- Trade entry must be blocked if quote freshness is not acceptable.
- If data source is delayed, missing, or uncertain: block with `SPX_REALTIME_DATA_REQUIRED`.
- Do not silently fall back to stale data.
- Do not silently use MES or index price as option premium.
- Do not use delayed data to justify any SPX trade.
- Telegram/frontend must show stale/delayed warnings clearly.
- Reports must not present delayed data as current.
- Before implementing any exact freshness threshold, ask owner for explicit approval.

### Testing

- `npx vitest run` runs all tests. Some test files fail due to pre-existing issues.
- `trading.test.ts` passes (14 tests) and `be-stop.test.ts` passes internally (25 checks).
- No ESLint config exists; `npx tsc --noEmit` is the lint/type-check command.

### Build

- `pnpm run build` — Vite builds frontend to `dist/public`, esbuild bundles server to `dist/index.js`.

### Communication format

- Owner communication can be in Arabic.
- Technical/code instructions to Cursor should be in English.
- Final reports must be easy to copy and send to the owner.
- Put every final report inside one fenced code block.
- Avoid wide tables if possible. Use compact `key: value` format.
- Required fields in every final report:
  ```
  summary:
  files_changed:
  commands_run:
  build_result:
  tests_result:
  risks:
  next_step:
  ```
- Do not bury important results in long prose.

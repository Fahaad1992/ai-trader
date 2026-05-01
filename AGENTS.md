# AGENTS.md

## Cursor Cloud specific instructions

### Overview

ai-trader is a TypeScript automated trading bot (Express backend + React/Vite frontend + SQLite). See `README.md` for layout and environment variables.

### Running the app

- **Backend**: `pnpm run dev` (tsx watch on port 3000)
- **Frontend**: `pnpm run dev:vite` (Vite on port 5173, proxies `/api` to backend)
- Both must run simultaneously for full dev experience.

### Key gotchas

- **Missing `ib` dependency**: The code imports `from "ib"` in `server/trading/ibkr-client.ts`, but `package.json` only declares `@stoqey/ib`. Run `pnpm add ib` if the package is missing after a clean install.
- **`better-sqlite3` native build**: `pnpm-workspace.yaml` sets `allowBuilds: better-sqlite3: false`, which blocks the native addon compilation. After `pnpm install`, you must manually build it:
  ```
  cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npm run build-release && cd /workspace
  ```
- **Fresh DB schema mismatch**: On a fresh `data/trades.db`, the migration in `database.ts` runs *before* `CREATE TABLE`, causing a crash because the INSERT statement references columns (`side`, `mode_effective`, etc.) not in the base `CREATE TABLE`. Workaround: delete `data/trades.db` and pre-seed it with the full schema including all migration columns, or ensure the DB already exists with the correct schema before starting the server.
- **DRY_RUN mode**: Always set `DRY_RUN=true` and `BE_FORCE_DRY_RUN=true` in `.env` to prevent any live order submission. The `.env` file is gitignored.
- **IB Gateway** (Docker): Optional for dev. The bot runs in dry-run mode without it. Only needed for live/paper trading with IBKR.

### Testing

- `npx vitest run` runs all tests. Some test files fail due to pre-existing issues:
  - `engine.test.ts` and `trailing-stop.test.ts` fail because `ib` package import fails in `ibkr-client.ts`
  - `polygon.test.ts` fails without a `POLYGON_API_KEY`
  - `news-filter.test.ts` has 4 failing assertions (source code / test expectations mismatch)
  - `trading.test.ts` passes (14 tests) and `be-stop.test.ts` passes internally (25 checks, custom runner)
- No ESLint config exists; `npx tsc --noEmit` is the lint/type-check command (has pre-existing TS errors in frontend pages).

### Build

- `pnpm run build` — Vite builds frontend to `dist/public`, esbuild bundles server to `dist/index.js`.

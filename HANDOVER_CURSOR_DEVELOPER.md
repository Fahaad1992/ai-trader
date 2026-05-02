# AI-Trader / MES Futures Bot — FULL Developer Handover

> Purpose: this file is the handover document for the new developer / Cursor.
> It is intentionally detailed. This is a trading/risk system, not a generic app.
> Do not simplify, refactor, or execute anything unless the owner explicitly asks.

---

## 0) Owner communication rules

- Owner-facing communication: Arabic.
- Bot UI, Telegram alerts, daily reports, and owner-facing summaries: Arabic.
- Code, technical implementation, commit messages, function names, and Cursor prompts: English.
- Final Cursor reports must be easy to copy to the owner:
  - one fenced code block
  - compact `key: value` format
  - no wide tables unless explicitly requested
  - proof, not claims

Required final report format:

```text
summary:
files_changed:
commands_run:
build_result:
tests_result:
risks:
next_step:
```

The owner wants direct answers, no philosophy, no background monitoring, no hidden decisions.

---

## 1) Project identity

Project: `ai-trader`

Type:
- Arabic-first automated trading bot.
- Main product focus: MES Futures scalping / short-term trading.
- Broker/account route: Derayah Global / Interactive Brokers.
- Runtime/server path: `/opt/ai-trader`.
- PM2 process name: `bot`.
- Main built server app: `/opt/ai-trader/dist/index.js`.
- GitHub repo: `Fahaad1992/ai-trader`.

Main instrument:
- MES Futures.
- Test/current contract used: `MES FUT 202606`.
- Exchange: CME.
- secType: FUT.
- MES point value: `$5 per 1 point per contract`.

Trading style:
- Short-term scalping / "milking" strategy.
- Current observed stop/target profile in tests:
  - fixed initial stop around `6 MES points`
  - initial target around `8 MES points`
  - trailing/profit-lock may close beyond target when the move continues.
- These are not to be changed unless explicitly requested.

---

## 2) Capital / risk envelope

Known recent live account NLV:
- Around `$1,574.60`.
- User often refers to account/testing capital around `1.5K–2K`.
- This is a small account relative to MES margin.

MES risk math:
- 1 MES contract = `$5 / point`.
- 6-point stop:
  - 1 contract = about `-$30`.
  - 2 contracts = about `-$60`.
- 8-point target:
  - 1 contract = about `+$40`.
  - 2 contracts = about `+$80`.
- 12.25-point move:
  - 1 contract = about `+$61.25`.

Current sizing policy / preference:
- Live must start with `1 MES contract only`.
- 2 contracts is an idea for later or DRY_RUN testing, not automatically approved for Live.
- Owner discussed dynamic sizing:
  - confidence/strong setup could later use 2 contracts
  - but do not enable this in Live without explicit approval.
- Do not increase size above 1 in Live without owner approval.

Daily loss / account guard context:
- Earlier configuration observed:
  - testing/simulated capital around `$1,500`
  - daily loss limit around `$450` (about 30%) or observed around `$472.38` depending status/config
- Treat daily loss values as config-dependent. Verify exact source before relying on it.
- Do not loosen daily loss limit.
- Do not bypass daily loss guard.
- If snapshot is zero/invalid, prior issue existed where `$0/$0` could block or miscalculate; verify guard is robust.

Live safety:
- No Live is approved by default.
- No real order should be sent unless owner explicitly says Live and exact conditions are met.
- Any uncertainty = stop/report, not execute.

---

## 3) Current operating state / most recent known state

Known from latest handoff/push:
- GitHub repo has been pushed successfully.
- Main branch exists.
- Initial import commit was pushed.
- `.env`, backups, logs, database WAL/SHM, Gateway configs, dist, node_modules were excluded.
- Bot should not be assumed running from GitHub/Cursor.
- Cursor is connected to GitHub and has Cloud Environment active.

Server state may differ from GitHub state:
- Server has `.env` and runtime files.
- GitHub does not contain `.env`.
- Do not assume GitHub-only environment can trade or connect IBKR.

Recent safe evidence:
- During tests, NLV and availableFunds remained `$1,574.60`.
- No confirmed real IBKR orders were sent during DRY_RUN sessions.
- Earlier DB/internal trades were simulated objects only.

---

## 4) Hard safety rules

Never do these without explicit owner approval:

- Do not start live trading.
- Do not flip `DRY_RUN=false`.
- Do not modify `.env`.
- Do not print secrets.
- Do not touch IBKR credentials.
- Do not ask owner to paste broker passwords into chat.
- Do not restart Gateway unless explicitly instructed.
- Do not call `/api/bot/start` unless explicitly instructed.
- Do not run `npm start`, `pnpm run dev`, backend server, frontend server, or daemons unless explicitly requested.
- Do not place real IBKR orders.
- Do not change strategy, stop, target, trailing, sizing, or risk rules unless task explicitly says so.
- Do not delete `data/trades.db`.
- Do not make broad refactors.
- Do not "smart fix" outside the requested scope.
- Do not monitor/poll continuously unless owner asks.

When making code changes:
- Backup changed files first.
- Build after changes.
- Do not restart PM2 unless asked.
- If PM2 restart is approved, confirm whether `running=false` or `running=true`.
- Return proof, not claims.

---

## 5) GitHub / Cursor status

GitHub repo:
```text
https://github.com/Fahaad1992/ai-trader
```

Push status:
- Code pushed to branch `main`.
- Sensitive files were excluded.
- `.gitignore` blocks:
  - `.env`, `.env.*`, `*.env`
  - `node_modules/`, `dist/`, `build/`, `.vite/`
  - DB files: `data/*.db`, `data/*.db-shm`, `data/*.db-wal`, backups
  - `logs/`, `*.log`
  - `backups/`, `*.bak`, `*.backup`, `*.pre-restore.*`
  - Gateway configs like `ibkr-live-clean*/`
  - temp/quarantine files
- `REQUIRED_ACCOUNT_ID` hardcoded value was removed from public code and changed to env-driven:
  - `process.env.IBKR_REQUIRED_ACCOUNT_ID || ""`
- `.env` was not modified on server.

Important:
- If server runtime relies on `IBKR_REQUIRED_ACCOUNT_ID`, add it to server `.env` only by explicit owner decision.
- Do not push `.env`.

Cursor:
- Cursor Cloud Environment is active.
- Cursor should work from the mobile app/PWA via Cloud Agents.
- Use small bounded tasks:
  - one task
  - one report
  - stop

---

## 6) Market sessions / operational timing

Do not use vague phrase "market closed" without specifying which market.

Relevant sessions:
- US regular cash session: 09:30–16:00 ET.
- CME Globex / futures can trade outside regular equity hours.
- Bot strategy was primarily discussed around US regular session behavior.
- First 10 minutes after market open are blocked for entries.
- Last 15 minutes block exists / should remain active unless explicitly changed.

Operational rule:
- If referring to "market close/open", specify:
  - regular equity session
  - CME futures session
  - local owner time if needed

---

## 7) IBKR / Derayah / Gateway authentication

Broker path:
- Derayah Global account backed by Interactive Brokers.
- IBKR Gateway used for API/data.
- Account id observed in runtime: real live account. Do not expose hardcoded account IDs in public code.

Recurring issue:
- Gateway login often requires SMS OTP or IBKR Mobile approval.
- Owner wants a permanent smoother workflow.
- Current SMS/IBKR Mobile state may cause repeated login friction.
- Do not rely on noVNC hacks as a permanent workflow.
- Do not ask for or store passwords.
- If Gateway is up but `ibkrConnected=false` or `accountId=""`, authentication is incomplete.

Important states:
- `Gateway running` does not always mean API authenticated.
- `port 4001 listening` does not always mean logged into account.
- `ibkrConnected=true` + correct account id + market data = better signal.

---

## 8) Market data / subscriptions / dataFresh

Market data issues encountered:
- MES futures data requires the correct IBKR/Derayah data subscriptions.
- Subscriptions discussed/confirmed:
  - US Equity and Options Add-On Streaming Bundle
  - US Securities Snapshot and Futures Value Bundle
- Historical/data farm statuses can show:
  - HMDS inactive on demand
  - usfuture/usfarm connecting/broken
- Some problems were not subscription problems but code/request definition problems.

Known data concepts:
- `dataFresh=true` is required before relying on signals.
- `dataFresh=false` means bot may be blind/stale.
- VIX contract had earlier definition bug:
  - VIX must be `secType=IND`, `exchange=CBOE`, `currency=USD`.
- MES contract should be FUT/CME, not OPT/SMART.

Do not Live if:
- `dataFresh=false`
- MES price missing/stale
- IBKR not authenticated
- contract route not FUT/CME/MES

---

## 9) Major discovered bug: Futures vs Options mixing

This was the most dangerous issue found.

Old bad behavior:
- Bot appeared to trade MES Futures but DB/Telegram/live route used Options-style structures.
- Bad old symptoms:
  - `contract_type = call`
  - symbol like `MES 2026-05-08 $7283C`
  - `strike` present
  - `expiry` present
  - `right C/P`
  - option route using `secType=OPT`, exchange `SMART`, multiplier `100`

Risk:
- If sent Live, bot could route an option order instead of MES futures.
- This could be catastrophic relative to the small account.

Fixes added:
- `buildFuturesContract`
- `placeFuturesBracket`
- `[OPT_BLOCKED_IN_FUTURES]`
- `[FUT_ROUTE]`
- `[FUTURES_CONTRACT_PREVIEW]`
- Futures DB markers:
  - `contract_type=future`
  - `symbol=MES FUT 202606`
  - `strike=null`
- Telegram futures entry formatter.
- Telegram close formatter cleanup:
  - avoid `0 202606 MES FUT 202606`
  - avoid options-style `C/P` for futures exits.

Evidence previously observed:
- FUT route logs appeared.
- Futures contract preview showed:
  - `symbol=MES`
  - `secType=FUT`
  - `exchange=CME`
  - `contractMonth=202606`
  - `multiplier=5`
- `OPT_BLOCKED_IN_FUTURES` self-test rejected an option route before IBKR.

Do not remove these guards.

---

## 10) DRY_RUN confusion / execution-mode blocker

Known architecture issue:
- Inside `engine.ts`, `openTrade()` has a hardcoded:
```ts
const DRY_RUN = true
```
- This is separate from `isDryRunActive()` and `.env`.
- `.env` may say `live`, while effective execution remains DRY_RUN due to hardcoded branch.
- This protected the account during testing but creates dangerous confusion.

Do not change this in a mixed task.

Dedicated future task needed:
- unify effective execution mode into one source of truth
- status must show `effectiveExecutionMode=DRY_RUN|LIVE`
- DB must save `mode_effective`
- Telegram/report must show DRY_RUN clearly
- no real order path unless explicit Live gate is passed

---

## 11) Strategy behavior: LONG, SHORT, buy-the-dip

Observed behavior:
- Bot historically acted LONG-biased.
- Owner correctly noticed he had not seen true short/downside trading.
- Existing "buying a dip" means LONG after drop / bounce, not SHORT.
- SHORT logic was enabled for DRY_RUN only later.
- Live SHORT remains blocked.

SHORT state:
- DRY_RUN SHORT may be allowed.
- Live SHORT must remain blocked unless explicitly approved.
- Need proof from DB/logs that SHORT trades save:
  - `side=SHORT`
  - stop above entry
  - target below entry
  - PnL = `(entry - currentPrice) * 5 * qty`
  - Telegram shows `MES FUT 202606 SHORT`
- Do not infer SHORT from price movement if DB does not save side.

Live:
- Live is LONG-only until owner approves otherwise.
- Keep `LIVE_SHORT_BLOCKED`.

---

## 12) P0 fixes already done

Problem found:
- After a fixed stop-loss, a new SHORT simulated trade object opened 13ms later.
- It was not sent to IBKR, but it proved re-entry/cooldown gate was not active in the path.

P0 fixes implemented:
1. Post fixed-stop-loss cooldown gate:
   - block new trade before trade object / DB insert
   - blocked reason `POST_FIXED_STOP_COOLDOWN`
   - cooldown around 5 minutes

2. Suppress incomplete EXECUTE Telegram:
   - if contract/entry/stop/target/qty missing
   - do not send `decision=EXECUTE`
   - send/record `DECISION_BLOCKED` instead

3. Exit reason classification:
   - trailing stop remains `TRAILING_STOP`
   - do not relabel trailing as `TAKE_PROFIT`

4. BE-moved label:
   - only show `(BE-moved)` when exitReason is `BREAK_EVEN_STOP`

Need future verification:
- after future stop-loss, verify no trade object/DB insert happens during cooldown.

---

## 13) Trade journal / observability problem

The biggest structural reporting problem:
- Trade reports were incomplete.
- DB did not store `side` explicitly.
- Some reports inferred LONG/SHORT from entry/exit movement.
- This is unacceptable for trading evaluation.

Fields previously dropped before DB insert:
- side/tradeSide
- stop_price
- target_price
- signal_id
- confidence
- confirmations_passed
- confirmations_total
- order_sent_to_ibkr
- ibkr_order_id
- perm_id
- exitReason
- reEntryAllowed
- blockedReason
- points
- effective execution mode

Approved observability direction:
- Add NULL-safe DB columns.
- Update insert/update close to save explicit fields.
- Add daily report command:
```bash
npm run report:trades:today
```
- This is logging/reporting only.
- It must not change strategy, entry, exit, stop/target/trailing, or risk.

---

## 14) Required trade fields at entry

Every new trade should persist:

```text
trade_id
mode_effective = DRY_RUN or LIVE
tradeMode = futures
secType = FUT
symbol = MES
contractMonth = 202606
side = LONG or SHORT
qty
entry_price
stop_price
target_price
opened_at
signal_id
confidence
confirmations_passed
confirmations_total
strategy
data_source
order_sent_to_ibkr
ibkr_order_id
perm_id
requested_size
final_size
```

If not available:
- write `NULL`
- report as `UNKNOWN`
- do not infer silently

---

## 15) Required trade fields at exit

Every closed trade should persist:

```text
exit_price
closed_at
close_reason
exit_reason
pnl
points
duration_seconds
was_stop_hit
was_target_hit
was_trailing_hit
reentry_allowed
blocked_reason
slippage
```

PnL formula for MES futures:
- LONG:
```text
(current/exit - entry) * 5 * qty
```
- SHORT:
```text
(entry - current/exit) * 5 * qty
```

---

## 16) Daily report requirements

Command:
```bash
npm run report:trades:today
```

Must show:
```text
total trades
LONG count
SHORT count
qty per trade
winners / losers
gross profit
gross loss
net pnl
biggest win
biggest loss
avg win
avg loss
win rate
stop-loss count
trailing-stop count
target count
overlap trades YES/NO
any qty > 1 YES/NO
any real orders YES/NO
NLV before/after
availableFunds before/after
unknown/null fields count
```

Rules:
- Never infer side from entry/exit if side is missing.
- If unavailable, print `UNKNOWN`.
- Report must clearly separate:
  - simulated/DRY_RUN PnL
  - real account changes
  - IBKR real orders

---

## 17) Overlap / one-trade-at-a-time concern

Owner asked whether the bot buys a new contract while another is open.

Required check:
- For every trade:
  - `opened_at`
  - previous trade `closed_at`
  - `overlap_with_previous=YES/NO`
- If any overlap exists, report:
  - trade_id
  - previous_trade_id
  - overlap duration ms
  - whether overlap was intentional/allowed

Temporary safety preference:
- no new trade while openTrades > 0 unless explicitly approved.

---

## 18) Real-order safety checks

For DRY_RUN sessions, verify real orders did not happen with evidence:

Signals:
- `placeOrder` count
- `placeFuturesBracket` real call count
- `orderId` real IBKR count
- `permId` real IBKR count
- IBKR positions
- IBKR openOrders
- NLV delta
- availableFunds delta

If MES real order exists:
- availableFunds likely changes due to margin.
- NLV/BuyingPower may reflect position.
- Real orderId/permId should appear.

Do not claim "no real orders" without evidence.

---

## 19) Stop-loss / target / trailing requirements

Typical observed MES setup:
- stop around 6 points
- target around 8 points
- trailing may capture more than target

Need report per losing trade:
```text
entry
initial_stop
exit
points_loss
pnl
close_reason
was exit near expected stop?
was exit worse than stop?
```

Need report per winning trade:
```text
entry
target
exit
points_win
pnl
close_reason
did exit exceed target?
did trailing improve profit?
```

Important:
- If target was 8 points but exit was higher due to trailing, classify as `TRAILING_STOP`, not automatically `TAKE_PROFIT`.
- If BE stop moved, only classify as `BREAK_EVEN_STOP` when truly triggered.

---

## 20) Sizing / 1 vs 2 contracts

Current Live safety:
- Live = 1 contract only.

DRY_RUN experiments may use 2 contracts only with explicit owner approval.

Potential future dynamic sizing idea:
- 1 contract for normal confidence.
- 2 contracts for stronger signals.
- risk warning or weak data = 1 contract or no entry.
- Do not implement without explicit task.

Risk math:
- 6-point stop:
  - 1 contract = `-$30`
  - 2 contracts = `-$60`
- If user says "$60 stop per contract", then 2 contracts would be `-$120`, but current observed 6-point MES stop equals about `$30 per contract`.

Always clarify whether stop is:
- points
- dollars per contract
- total dollars across position

---

## 21) Known open blockers before Live

No Live until explicitly accepted:

1. Effective execution mode confusion:
   - `.env` and hardcoded DRY_RUN are not unified.

2. Observability fields:
   - new fields must be populated by fresh trades.

3. SHORT:
   - must be proven in DRY_RUN before any Live discussion.
   - Live SHORT remains blocked.

4. Re-entry/cooldown:
   - must verify `POST_FIXED_STOP_COOLDOWN` after real simulated stop-loss.

5. Overlap:
   - must verify no trade-on-trade overlap.

6. IBKR authentication:
   - SMS / IBKR Mobile approval remains an operational blocker.

7. Futures route:
   - must remain FUT/CME/MES.
   - no OPT in futures mode.

8. Account/risk:
   - small capital vs MES margin.
   - Live must be 1 contract only.

---

## 22) What the new developer should do first

First task should be:

```text
READ-ONLY TAKEOVER AUDIT

Do not modify code.
Do not restart.
Do not start bot.
Do not touch .env.
Do not touch Gateway.
Do not call /api/bot/start.
Do not run Live.

Inspect:
1) git branch
2) latest commit
3) git status
4) package scripts
5) build command
6) DB path
7) PM2 process name
8) whether report:trades:today exists
9) whether secrets are tracked
10) whether .env is ignored
11) where engine/order routing/database/notify live
12) AGENTS.md rules

Return:
takeover_status:
risks_found:
files_to_review:
recommended_next_safe_task:
```

---

## 23) What NOT to trust

Do not blindly trust:
- Telegram PnL without DB proof.
- DB side if it is NULL.
- price-direction inference for LONG/SHORT.
- `mode=live` in DB if `mode_effective` is missing.
- `.env live` if code hardcoded DRY_RUN branch is active.
- "no real order" claims without NLV/availableFunds/orderId/permId evidence.
- old simulated trades before observability patch.

---

## 24) Legacy Manus context

Manus was previously used heavily.
Owner wants Cursor to become the primary developer.

Cursor usage rules:
- Small bounded tasks.
- No continuous monitoring.
- No open-ended "fix everything".
- Do not consume cloud-agent usage without a clear task.
- Stop after report.

Manus should not act as primary coder unless owner explicitly says.

---

## 25) Final reminder

This is a trading/risk system.

Every change must answer:
```text
Can this place a real order?
Can this affect IBKR?
Can this change margin/risk?
Can this change stop/target/trailing?
Can this confuse DRY_RUN vs LIVE?
Can this hide whether LONG/SHORT/qty happened?
```

If yes or unknown:
- stop
- report
- ask owner

/**
 * scripts/report-today.ts
 *
 * Daily observability report for AI-Trader.
 *  - Reads ./data/trades.db (NULL-safe for legacy rows).
 *  - Computes per-day aggregates (ET day window).
 *  - Detects overlap windows, qty>1, real-order safety from pm2 logs.
 *  - Pulls NLV/availableFunds best-effort from /api/ibkr/status.
 *  - Writes Markdown to ./reports/YYYY-MM-DD.md and prints to stdout.
 *
 * Read-only on DB. No bot start. No IBKR side-effects.
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------- Helpers ----------
function pad2(n: number): string { return n < 10 ? "0" + n : "" + n; }

/** Convert ms epoch to ET (America/New_York) date string yyyy-mm-dd. */
function etDateString(ms: number): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date(ms));
}

/** Boundaries (ms epoch) of the ET day containing `ms`. */
function etDayBounds(ms: number): { from: number; to: number; label: string } {
  const label = etDateString(ms);
  // Use Date.UTC offsets via offset probe at noon ET
  const probe = new Date(`${label}T12:00:00`);
  // Get ET offset by formatting probe in ET timezone
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  });
  const parts = f.formatToParts(probe);
  const tzPart = parts.find(p => p.type === "timeZoneName")?.value || "GMT-5";
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(tzPart);
  const offHours = m ? parseInt(m[1], 10) : -5;
  const offMin = m && m[2] ? parseInt(m[2], 10) : 0;
  // ET midnight in UTC = label 00:00 minus offset
  const midnightUtcMs = Date.parse(`${label}T00:00:00Z`) - (offHours * 60 + (offHours < 0 ? -offMin : offMin)) * 60_000;
  return { from: midnightUtcMs, to: midnightUtcMs + 24 * 3600_000, label };
}

function fmtMoney(n: number): string {
  const s = (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2);
  return s;
}

async function fetchJsonSafe(url: string, timeoutMs = 1500): Promise<any | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function readPm2LogsBestEffort(): { realOrderHits: number; placeFuturesHits: number; orderIdHits: number; permIdHits: number; sources: string[] } {
  const candidates = [
    process.env.HOME ? path.join(process.env.HOME, ".pm2/logs/bot-out.log") : "",
    process.env.HOME ? path.join(process.env.HOME, ".pm2/logs/bot-error.log") : "",
    "/root/.pm2/logs/bot-out.log",
    "/root/.pm2/logs/bot-error.log",
  ].filter(Boolean);
  let realOrderHits = 0, placeFuturesHits = 0, orderIdHits = 0, permIdHits = 0;
  const sources: string[] = [];
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue;
      sources.push(f);
      const data = fs.readFileSync(f, "utf8");
      // crude: count matches; exclude DRY_RUN preview lines.
      const lines = data.split("\n");
      for (const line of lines) {
        if (line.includes("DRY_RUN preview") || line.includes("[DRY_RUN]")) continue;
        if (/\[IBKR\]\s*placeOrder|placeBracketOrder\(|placeFuturesBracket\(/.test(line)) realOrderHits++;
        if (/\[FUT_ROUTE\][^\n]*MES.*contractMonth=/.test(line) && !/preview/i.test(line)) placeFuturesHits++;
        const m1 = /\borderId:(\d{3,})/.exec(line); if (m1) orderIdHits++;
        const m2 = /\bpermId:(\d{3,})/.exec(line); if (m2) permIdHits++;
      }
    } catch { /* ignore */ }
  }
  return { realOrderHits, placeFuturesHits, orderIdHits, permIdHits, sources };
}

// ---------- Main ----------
async function main() {
  const cwd = process.cwd();
  const dbPath = path.join(cwd, "data", "trades.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`[REPORT] DB not found: ${dbPath}`);
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true });

  const now = Date.now();
  const { from, to, label } = etDayBounds(now);

  // Detect available columns (legacy-safe)
  const cols = (db.prepare("PRAGMA table_info(trades)").all() as any[]).map(r => r.name);
  const has = (c: string) => cols.includes(c);
  const sel = [
    "id", "underlying", "symbol", "contract_type", "entry_premium", "exit_premium",
    "quantity", "pnl", "pnl_percent", "status", "open_reason", "close_reason",
    "opened_at", "closed_at", "data_source", "mode",
    has("side") ? "side" : "NULL AS side",
    has("mode_effective") ? "mode_effective" : "NULL AS mode_effective",
    has("trade_mode") ? "trade_mode" : "NULL AS trade_mode",
    has("sec_type") ? "sec_type" : "NULL AS sec_type",
    has("contract_month") ? "contract_month" : "NULL AS contract_month",
    has("stop_price") ? "stop_price" : "NULL AS stop_price",
    has("target_price") ? "target_price" : "NULL AS target_price",
    has("signal_id") ? "signal_id" : "NULL AS signal_id",
    has("confidence") ? "confidence" : "NULL AS confidence",
    has("confirmations_passed") ? "confirmations_passed" : "NULL AS confirmations_passed",
    has("confirmations_total") ? "confirmations_total" : "NULL AS confirmations_total",
    has("order_sent_to_ibkr") ? "order_sent_to_ibkr" : "NULL AS order_sent_to_ibkr",
    has("ibkr_order_id") ? "ibkr_order_id" : "NULL AS ibkr_order_id",
    has("perm_id") ? "perm_id" : "NULL AS perm_id",
    has("exit_reason") ? "exit_reason" : "NULL AS exit_reason",
    has("points") ? "points" : "NULL AS points",
    has("reentry_allowed") ? "reentry_allowed" : "NULL AS reentry_allowed",
    has("blocked_reason") ? "blocked_reason" : "NULL AS blocked_reason",
    has("slippage") ? "slippage" : "NULL AS slippage",
    has("requested_size") ? "requested_size" : "NULL AS requested_size",
    has("final_size") ? "final_size" : "NULL AS final_size",
  ].join(", ");
  const sql = `SELECT ${sel} FROM trades WHERE opened_at >= @from AND opened_at < @to ORDER BY opened_at ASC`;
  const rows = db.prepare(sql).all({ from, to }) as any[];

  // Aggregations
  let total = rows.length;
  let openCount = 0, closedCount = 0;
  let longCount = 0, shortCount = 0, sideUnknownCount = 0;
  let cleanupCount = 0;
  let winners = 0, losers = 0;
  let grossProfit = 0, grossLoss = 0;
  let biggestWin: any = null, biggestLoss: any = null;
  let stopLossCount = 0, trailingCount = 0, targetCount = 0, manualCount = 0;
  let qtyMax = 0, anyQtyGt1 = false;
  let modeEffectiveDryRun = 0, modeEffectiveLive = 0, modeEffectiveUnknown = 0;
  let nullSide = 0, nullStop = 0, nullTarget = 0, nullExitReason = 0, nullSignalId = 0;
  const winsArr: number[] = [], lossArr: number[] = [];

  for (const r of rows) {
    if (r.status === "open") openCount++; else closedCount++;
    const inferredSide = (() => {
      if (r.side) return r.side;
      // legacy heuristic: contract_type=call → LONG; put → SHORT; future or null → unknown
      if (r.contract_type === "call") return "LONG";
      if (r.contract_type === "put") return "SHORT";
      return null;
    })();
    if (inferredSide === "LONG") longCount++;
    else if (inferredSide === "SHORT") shortCount++;
    else sideUnknownCount++;
    if ((r.close_reason ?? "").toLowerCase().includes("cleanup")) cleanupCount++;
    if (typeof r.quantity === "number") {
      qtyMax = Math.max(qtyMax, r.quantity);
      if (r.quantity > 1) anyQtyGt1 = true;
    }
    if (typeof r.pnl === "number") {
      if (r.pnl > 0) { winners++; grossProfit += r.pnl; winsArr.push(r.pnl); if (!biggestWin || r.pnl > biggestWin.pnl) biggestWin = r; }
      else if (r.pnl < 0) { losers++; grossLoss += r.pnl; lossArr.push(r.pnl); if (!biggestLoss || r.pnl < biggestLoss.pnl) biggestLoss = r; }
    }
    const cr = (r.close_reason ?? "").toLowerCase();
    if (cr === "stop-loss") stopLossCount++;
    else if (cr === "trailing-stop") trailingCount++;
    else if (cr === "target" || cr === "take-profit") targetCount++;
    else if (cr === "manual") manualCount++;
    if (r.mode_effective === "DRY_RUN") modeEffectiveDryRun++;
    else if (r.mode_effective === "LIVE") modeEffectiveLive++;
    else modeEffectiveUnknown++;
    if (r.side == null) nullSide++;
    if (r.stop_price == null) nullStop++;
    if (r.target_price == null) nullTarget++;
    if (r.exit_reason == null) nullExitReason++;
    if (r.signal_id == null) nullSignalId++;
  }
  const netPnl = grossProfit + grossLoss;
  const avgWin = winners > 0 ? grossProfit / winners : 0;
  const avgLoss = losers > 0 ? grossLoss / losers : 0;
  const winRate = (winners + losers) > 0 ? (winners / (winners + losers)) * 100 : 0;

  // Overlap detection (only on closed rows; opens count as overlap if any prev still unclosed)
  let overlapCount = 0;
  let maxNegativeGapMs = 0;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const prevEnd = (prev.closed_at ?? Number.POSITIVE_INFINITY);
    if (cur.opened_at < prevEnd) {
      overlapCount++;
      const gap = cur.opened_at - (prev.closed_at ?? cur.opened_at);
      if (gap < maxNegativeGapMs) maxNegativeGapMs = gap;
    }
  }

  // Safety: pm2 logs + IBKR status
  const pm2 = readPm2LogsBestEffort();
  const ibkrStatus = await fetchJsonSafe("http://127.0.0.1:3000/api/ibkr/status");
  const botStatus = await fetchJsonSafe("http://127.0.0.1:3000/api/bot/status");
  const acct = (ibkrStatus && ibkrStatus.lastAccountSummary) || null;
  const nlv = acct?.netLiquidation ?? null;
  const avFunds = acct?.availableFunds ?? null;

  const realOrders = (pm2.realOrderHits + pm2.placeFuturesHits + pm2.orderIdHits + pm2.permIdHits) > 0;

  // Build output
  const lines: string[] = [];
  lines.push(`# AI-TRADER DAILY REPORT — ${label} (ET)`);
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  lines.push(`| Total trades | ${total} (open:${openCount}, closed:${closedCount}) |`);
  lines.push(`| LONG count | ${longCount} |`);
  lines.push(`| SHORT count | ${shortCount} |`);
  lines.push(`| Side unknown | ${sideUnknownCount} |`);
  lines.push(`| Cleanup count | ${cleanupCount} |`);
  lines.push(`| Quantity max / any qty>1 | ${qtyMax} / ${anyQtyGt1 ? "YES" : "NO"} |`);
  lines.push(`| Winners / Losers | ${winners} / ${losers} |`);
  lines.push(`| Gross profit | ${fmtMoney(grossProfit)} |`);
  lines.push(`| Gross loss | ${fmtMoney(grossLoss)} |`);
  lines.push(`| **Net PnL (realized)** | **${fmtMoney(netPnl)}** |`);
  lines.push(`| Biggest win | ${biggestWin ? `${biggestWin.id} ${fmtMoney(biggestWin.pnl)}` : "n/a"} |`);
  lines.push(`| Biggest loss | ${biggestLoss ? `${biggestLoss.id} ${fmtMoney(biggestLoss.pnl)}` : "n/a"} |`);
  lines.push(`| Avg win | ${winners ? fmtMoney(avgWin) : "n/a"} |`);
  lines.push(`| Avg loss | ${losers ? fmtMoney(avgLoss) : "n/a"} |`);
  lines.push(`| Win rate | ${winRate.toFixed(2)}% |`);
  lines.push(`| Stop-loss count | ${stopLossCount} |`);
  lines.push(`| Trailing-stop count | ${trailingCount} |`);
  lines.push(`| Target count | ${targetCount} |`);
  lines.push(`| Manual count | ${manualCount} |`);
  lines.push(`| Overlap trades | ${overlapCount > 0 ? `YES (count:${overlapCount}, max neg-gap:${maxNegativeGapMs}ms)` : "NO"} |`);
  lines.push(`| Any qty > 1 | ${anyQtyGt1 ? "YES" : "NO"} |`);
  lines.push(`| Any real orders | ${realOrders ? "YES" : "NO"} (placeOrder:${pm2.realOrderHits}, futBracket:${pm2.placeFuturesHits}, orderId:${pm2.orderIdHits}, permId:${pm2.permIdHits}) |`);
  lines.push(`| NLV (now) | ${nlv != null ? `$${nlv}` : "n/a"} |`);
  lines.push(`| AvailableFunds (now) | ${avFunds != null ? `$${avFunds}` : "n/a"} |`);
  lines.push(`| Bot running | ${botStatus?.running ? "YES" : "NO"} |`);
  lines.push(`| IBKR connected | ${ibkrStatus?.connected ? "YES" : "NO"} |`);
  lines.push(`| Mode_effective per trade | DRY_RUN:${modeEffectiveDryRun} / LIVE:${modeEffectiveLive} / unknown:${modeEffectiveUnknown} |`);
  lines.push(`| Null fields (legacy rows) | side:${nullSide}, stop_price:${nullStop}, target_price:${nullTarget}, exit_reason:${nullExitReason}, signal_id:${nullSignalId} |`);
  lines.push("");
  lines.push("## Trade list");
  lines.push("");
  lines.push("| # | id | side | qty | entry | stop | target | exit | reason | exit_reason | pnl | mode_eff |");
  lines.push("|---|---|---|---:|---:|---:|---:|---:|---|---|---:|---|");
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const side = r.side ?? (r.contract_type === "call" ? "LONG?" : r.contract_type === "put" ? "SHORT?" : "?");
    const stop = r.stop_price != null ? r.stop_price.toFixed(2) : "-";
    const tgt  = r.target_price != null ? r.target_price.toFixed(2) : "-";
    const ex   = r.exit_premium != null ? r.exit_premium.toFixed(2) : "-";
    const rsn  = r.close_reason ?? "-";
    const exr  = r.exit_reason ?? "-";
    const pnl  = r.pnl != null ? fmtMoney(r.pnl) : "-";
    const me   = r.mode_effective ?? "-";
    lines.push(`| ${i+1} | \`${r.id}\` | ${side} | ${r.quantity ?? "-"} | ${r.entry_premium?.toFixed?.(2) ?? "-"} | ${stop} | ${tgt} | ${ex} | ${rsn} | ${exr} | ${pnl} | ${me} |`);
  }
  lines.push("");
  lines.push(`> Sources: db=${dbPath}, pm2_logs=${pm2.sources.length ? pm2.sources.join(",") : "n/a"}`);
  lines.push("");

  const out = lines.join("\n");
  console.log(out);

  const reportsDir = path.join(cwd, "reports");
  try {
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    const outPath = path.join(reportsDir, `${label}.md`);
    fs.writeFileSync(outPath, out + "\n", "utf8");
    console.error(`[REPORT] wrote ${outPath}`);
  } catch (e: any) {
    console.error(`[REPORT] failed to write report: ${e?.message || e}`);
  }
}

main().catch(e => { console.error("[REPORT] fatal:", e?.message || e); process.exit(2); });

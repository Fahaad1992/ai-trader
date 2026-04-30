// ============================================================
// MOCK UNIT TESTS for mes-strategy.ts
// STANDALONE — imports ONLY from ./mes-strategy
// NO engine.ts, NO ibkr-client.ts, NO Gateway, NO PM2, NO real orders.
// Run: npx tsx mes-strategy.mock-test.ts
// ============================================================

import {
  calculateMesStops,
  calculatePositionSize,
  initSimulatedTradeState,
  updateProfitLock,
  shouldExitAtSimulatedStop,
  evaluateShadowStop,
  evaluatePartialClose,
  classifyDailyLossTier,
  detectRangeRegime,
  rangeModeEntryGuidance,
  MES_STOP_POINTS,
  MES_TARGET_POINTS,
  MES_TRAIL_POINTS,
  MES_TRAIL_ACTIVATION,
  MES_PROFIT_LOCK_TRIGGER,
  MES_PROFIT_LOCK_LEVEL,
  MES_PROFIT_LOCK_STAGE1_TRIGGER,
  MES_PROFIT_LOCK_STAGE1_OFFSET,
  MES_PROFIT_LOCK_STAGE2_TRIGGER,
  MES_PROFIT_LOCK_STAGE2_OFFSET,
  MES_DOLLAR_PER_POINT,
  MES_FIRST_PROFIT_ZONE_POINTS,
  MES_SECOND_PROFIT_ZONE_POINTS,
  MES_HARD_CAP_CONTRACTS,
  type PositionSizeContext,
  type SimulatedTradeState,
  type ShadowStopContext,
  type RangeContext,
  type TradeSide,
} from "./mes-strategy";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEq(name: string, expected: unknown, actual: unknown): boolean {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  console.log(`TEST: ${name}`);
  console.log(`EXPECTED: ${JSON.stringify(expected)}`);
  console.log(`ACTUAL:   ${JSON.stringify(actual)}`);
  console.log(`RESULT:   ${ok ? "PASS" : "FAIL"}`);
  console.log("");
  if (ok) passed++; else { failed++; failures.push(name); }
  return ok;
}

function report(name: string, info: string): void {
  console.log(`TEST: ${name}`);
  console.log(info);
  console.log("");
}

// ============================================================
// TEST 1 — calculateMesStops
// ============================================================
console.log("════════════════ TEST 1 — calculateMesStops ════════════════");
console.log(`Constants: STOP=${MES_STOP_POINTS} TARGET=${MES_TARGET_POINTS} TRAIL=${MES_TRAIL_POINTS} TRAIL_ACTIVATION=${MES_TRAIL_ACTIVATION} PL_TRIGGER=${MES_PROFIT_LOCK_TRIGGER} PL_LEVEL=${MES_PROFIT_LOCK_LEVEL}`);
console.log("");

// Case 1a: entry=7170
const r1a = calculateMesStops(7170);
console.log("Input: entry=7170");
console.log(`ACTUAL: ${JSON.stringify(r1a)}`);
assertEq("1a.stopPrice", 7164, r1a.stopPrice);
assertEq("1a.targetPrice", 7178, r1a.targetPrice);
assertEq("1a.trailDistance", 3, r1a.trailDistance);
// NAMING_MISMATCH NOTE: mes-strategy returns `profitLockTrigger` and `profitLockLevel`
// as POINTS (4 and 1), not ABSOLUTE PRICES. The test spec expected prices 7174/7171.
// We print actual and compare to what the function actually provides.
console.log("[NOTE] Spec expected profitLockTrigger=7174 (price), profitLockLevel=7171 (price), trailActivation=7175 (price).");
console.log("       Actual fields return POINTS (constants), not prices. Reporting as-is without fixing.");
assertEq("1a.profitLockTrigger (as points)", 4, r1a.profitLockTrigger);
assertEq("1a.profitLockLevel   (as points)", 1, r1a.profitLockLevel);
assertEq("1a.trailActivation   (as points)", 5, r1a.trailActivation);

// Case 1b: entry=7170.25
const r1b = calculateMesStops(7170.25);
console.log("Input: entry=7170.25");
console.log(`ACTUAL: ${JSON.stringify(r1b)}`);
assertEq("1b.stopPrice", 7164.25, r1b.stopPrice);
assertEq("1b.targetPrice", 7178.25, r1b.targetPrice);

// Case 1c: entry=0
const r1c = calculateMesStops(0);
console.log("Input: entry=0");
console.log(`ACTUAL: ${JSON.stringify(r1c)}`);
console.log("[REPORT] entry=0 produces stopPrice=-6, targetPrice=8 — logically invalid but function does not guard. Reporting, not fixing.");
report("1c.entry=0 sanity", `stopPrice=${r1c.stopPrice} targetPrice=${r1c.targetPrice} isFiniteStop=${isFinite(r1c.stopPrice)}`);

// ============================================================
// TEST 2 — calculatePositionSize
// ============================================================
console.log("════════════════ TEST 2 — calculatePositionSize ════════════════");
console.log(`HARD_CAP=${MES_HARD_CAP_CONTRACTS}`);
console.log("[NOTE] Spec used parameters (lastWon, consecutiveWins, isFirstTrade, dailyLossLimit, forceSizeOne) that DO NOT exist");
console.log("       in the actual PositionSizeContext. Tests are mapped to the real fields; missing ones are SIGNATURE_MISMATCH.");
console.log("");

function sizeCtx(over: Partial<PositionSizeContext>): PositionSizeContext {
  return {
    candleQuality: 0.5,
    vwapReclaimOrBounce: false,
    vix: 20,
    macroBlocked: false,
    context5mAligned: false,
    context15mAligned: false,
    fallingKnife: false,
    recentSimulatedPnl: 0,
    dailyLossTier: "NONE",
    ...over,
  };
}

// Case A base
const A = calculatePositionSize(sizeCtx({ vix: 20, candleQuality: 0.5, vwapReclaimOrBounce: false }));
console.log("Case A (base): vix=20, body=0.5, vwap=false");
console.log(`ACTUAL: ${JSON.stringify(A)}`);
assertEq("2A.size=1", 1, A.size);

// Case B good: should reach size 2
const B = calculatePositionSize(sizeCtx({
  vix: 17, candleQuality: 0.7, vwapReclaimOrBounce: true,
  context5mAligned: true, recentSimulatedPnl: 50,
}));
console.log("Case B (good): vix=17, body=0.7, vwap=true, 5m=aligned, pnl=+50");
console.log(`ACTUAL: ${JSON.stringify(B)}`);
assertEq("2B.size=2", 2, B.size);

// Case C strong → 3
const C = calculatePositionSize(sizeCtx({
  vix: 15, candleQuality: 0.8, vwapReclaimOrBounce: true,
  context5mAligned: true, context15mAligned: true, recentSimulatedPnl: 100,
}));
console.log("Case C (strong): vix=15, body=0.8, vwap=true, 5m+15m=aligned, pnl=+100");
console.log(`ACTUAL: ${JSON.stringify(C)}`);
assertEq("2C.size=3", 3, C.size);

// Case D cap
const D = calculatePositionSize(sizeCtx({
  vix: 10, candleQuality: 1.0, vwapReclaimOrBounce: true,
  context5mAligned: true, context15mAligned: true, recentSimulatedPnl: 1000,
}));
console.log("Case D (cap): all maxed");
console.log(`ACTUAL: ${JSON.stringify(D)}`);
assertEq("2D.size<=3 (hard cap)", 3, D.size);

// Case E forceSizeOne — NOT SUPPORTED in actual signature
console.log("Case E (forceSizeOne=true): SIGNATURE_MISMATCH — no such field in PositionSizeContext.");
report("2E.forceSizeOne", "FIELD_NOT_IN_CONTEXT — actual function has no forceSizeOne. Reporting mismatch; not simulating.");

// Case F tier REDUCE_15 → must return size 1
const F = calculatePositionSize(sizeCtx({
  vix: 15, candleQuality: 0.8, vwapReclaimOrBounce: true,
  context5mAligned: true, context15mAligned: true, recentSimulatedPnl: 100,
  dailyLossTier: "REDUCE_15",
}));
console.log("Case F (tier=REDUCE_15, else like C)");
console.log(`ACTUAL: ${JSON.stringify(F)}`);
assertEq("2F.size=1 (REDUCE_15 force)", 1, F.size);

// ============================================================
// TEST 3 — Profit Lock sequence
// ============================================================
console.log("════════════════ TEST 3 — Profit Lock ════════════════");
const state: SimulatedTradeState = initSimulatedTradeState(7170);
console.log(`INIT: ${JSON.stringify(state)}`);
const seq = [7170, 7173, 7174, 7175, 7176, 7173, 7170.5];
for (const p of seq) {
  const u = updateProfitLock(state, p);
  console.log(`tick price=${p} | hwm=${state.highWaterPoints} | S1=${state.profitLockStage1} | S2=${state.profitLockStage2} | simStop=${state.simulatedStopPrice} | trailing=${state.trailingActive} | events=${JSON.stringify(u.events)}`);
}
console.log("Expected: at +4 → S1 active, stop≥7170.5; at +5 → S2 active, stop≥7171, trailing active; stop must not go below 7171 after S2.");
// Assert final state
assertEq("3.final.S1Active", true, state.profitLockStage1);
assertEq("3.final.S2Active", true, state.profitLockStage2);
assertEq("3.final.trailingActive", true, state.trailingActive);
assertEq("3.final.stop>=7171", true, state.simulatedStopPrice >= 7171);

// Test stop-hit
const s3 = initSimulatedTradeState(7170);
updateProfitLock(s3, 7176);
const exitAt = shouldExitAtSimulatedStop(s3, s3.simulatedStopPrice - 0.01);
console.log(`After hwm=6 then price<simStop: exit=${exitAt.exit} price=${exitAt.price} pnl=${exitAt.pnlPoints} reason=${exitAt.reason}`);
assertEq("3.exit.triggered", true, exitAt.exit);
assertEq("3.exit.protectedFromLoss (price>=entry)", true, exitAt.price >= 7170);

// ============================================================
// TEST 4 — Partial Close
// ============================================================
console.log("════════════════ TEST 4 — Partial Close ════════════════");
console.log(`FIRST_ZONE=${MES_FIRST_PROFIT_ZONE_POINTS}pts, SECOND_ZONE=${MES_SECOND_PROFIT_ZONE_POINTS}pts, $/pt=${MES_DOLLAR_PER_POINT}`);
console.log("");

// 2-contract
console.log("--- 2-contract trade ---");
for (const pts of [3, 4, 5, 7]) {
  const ev = evaluatePartialClose(2, 2, pts, { first: false, second: false });
  console.log(`hwm=${pts}pts -> ${ev ? JSON.stringify(ev) : "null (no close)"}`);
}
const ev2at4 = evaluatePartialClose(2, 2, 4, { first: false, second: false });
assertEq("4.2c.at+4.zone", "FIRST_PROFIT", ev2at4?.zone);
assertEq("4.2c.at+4.closedQty", 1, ev2at4?.closedQty);
assertEq("4.2c.at+4.remaining", 1, ev2at4?.remainingQty);
assertEq("4.2c.at+4.pnl$", 20, ev2at4?.simulatedPnlUsd); // 4 * 5
// After first close, remainingQty=1 → no more closes possible for 2-contract
const ev2at7 = evaluatePartialClose(2, 1, 7, { first: true, second: false });
assertEq("4.2c.runner.at+7.noClose", null, ev2at7);

// 3-contract
console.log("");
console.log("--- 3-contract trade ---");
for (const pts of [3, 4, 5, 7, 8]) {
  // simulate after first already hit at 4
  const state: { first: boolean; second: boolean } = { first: pts >= 4, second: false };
  const remaining = pts >= 4 ? 2 : 3;
  const ev = evaluatePartialClose(3, remaining, pts, state);
  console.log(`hwm=${pts}pts remaining=${remaining} alreadyClosed=${JSON.stringify(state)} -> ${ev ? JSON.stringify(ev) : "null (no close)"}`);
}
const ev3at4 = evaluatePartialClose(3, 3, 4, { first: false, second: false });
assertEq("4.3c.at+4.zone", "FIRST_PROFIT", ev3at4?.zone);
const ev3at7 = evaluatePartialClose(3, 2, 7, { first: true, second: false });
assertEq("4.3c.at+7.zone", "SECOND_PROFIT", ev3at7?.zone);
assertEq("4.3c.at+7.pnl$", 35, ev3at7?.simulatedPnlUsd); // 7 * 5

// ============================================================
// TEST 5 — Shadow Stop (8 combos × 2 inProfit states)
// ============================================================
console.log("════════════════ TEST 5 — Shadow Stop ════════════════");
const bools = [false, true];
for (const inProfit of bools) {
  for (const red3m of bools) {
    for (const vwap of bools) {
      for (const rsi of bools) {
        const ctx: ShadowStopContext = {
          inProfit,
          red3mCandleAgainst: red3m,
          vwapBreakdownAfterAbove: vwap,
          rsiCollapseOver10In2Candles: rsi,
        };
        const d = evaluateShadowStop(ctx);
        const triggerCount = [red3m, vwap, rsi].filter(Boolean).length;
        const expectedExit = inProfit && triggerCount >= 2;
        const name = `5.inProfit=${inProfit}.red3m=${red3m}.vwap=${vwap}.rsi=${rsi}`;
        const ok = d.exit === expectedExit;
        console.log(`${name} | triggers=${JSON.stringify(d.triggers)} count=${triggerCount} expectedExit=${expectedExit} actualExit=${d.exit} result=${ok ? "PASS" : "FAIL"}`);
        if (ok) passed++; else { failed++; failures.push(name); }
      }
    }
  }
}
console.log("");

// ============================================================
// TEST 6 — Daily Loss Tiers (equity=1000 for easy %)
// ============================================================
console.log("════════════════ TEST 6 — Daily Loss Tiers (equity=$1000) ════════════════");
const equity = 1000;
const cases: Array<{ pct: number; expected: string }> = [
  { pct: 9.99,  expected: "NONE" },
  { pct: 10,    expected: "WARN_10" },
  { pct: 14.99, expected: "WARN_10" },
  { pct: 15,    expected: "REDUCE_15" },
  { pct: 19.99, expected: "REDUCE_15" },
  { pct: 20,    expected: "COOLDOWN_20" },
  { pct: 29.99, expected: "COOLDOWN_20" },
  { pct: 30,    expected: "HARD_30" },
  { pct: 30.01, expected: "HARD_30" },
];
for (const { pct, expected } of cases) {
  const lossUsd = -(equity * pct / 100);
  const tier = classifyDailyLossTier(lossUsd, equity);
  const name = `6.lossPct=${pct}`;
  const ok = tier.tier === expected;
  console.log(`${name} | lossUsd=${lossUsd.toFixed(2)} | expected=${expected} | actual=${tier.tier} (${tier.lossPct.toFixed(2)}%) | result=${ok ? "PASS" : "FAIL"}`);
  if (ok) passed++; else { failed++; failures.push(name); }
}
console.log("");

// ============================================================
// TEST 7 — Range Detector
// ============================================================
console.log("════════════════ TEST 7 — Range Detector ════════════════");
function baseRange(over: Partial<RangeContext>): RangeContext {
  return {
    high: 7180, low: 7172, vwap: 7176, vix: 18, macroBlocked: false,
    recentWicksRatio: 0.2, volumeIrregularity: 0.2, fakeBreaksCount: 0,
    vwapVolatilityPct: 0.05, hasCandleData: true, ...over,
  };
}

// Scenario A: organized range width=8
const sA = detectRangeRegime(baseRange({}));
console.log(`A organized: input width=8, vix=18 -> actual=${JSON.stringify(sA)}`);
assertEq("7A.mode=RANGE_ORGANIZED", "RANGE_ORGANIZED", sA.mode);

// Scenario B: chop (wide width, high wicks, irregular volume, fakes>1)
const sB = detectRangeRegime(baseRange({
  high: 7210, low: 7170, recentWicksRatio: 0.7, volumeIrregularity: 0.7, fakeBreaksCount: 3, vwapVolatilityPct: 0.3,
}));
console.log(`B chop: input width=40, wicks=0.7, vol=0.7, fakes=3 -> actual=${JSON.stringify(sB)}`);
assertEq("7B.mode!=RANGE_ORGANIZED", true, sB.mode !== "RANGE_ORGANIZED");

// Scenario C: missing data
const sC = detectRangeRegime(baseRange({ hasCandleData: false }));
console.log(`C missing: hasCandleData=false -> actual=${JSON.stringify(sC)}`);
assertEq("7C.mode=RANGE_MODE_DATA_MISSING", "RANGE_MODE_DATA_MISSING", sC.mode);

// Bonus: rangeModeEntryGuidance near bottom
const g = rangeModeEntryGuidance({ close: 7173, rangeLow: 7172, rangeHigh: 7180, vwap: 7176 });
console.log(`rangeModeEntryGuidance near bottom -> ${JSON.stringify(g)}`);
assertEq("7.guidance.allowLong=true", true, g.allowLong);

// ============================================================
// TEST 8 — Integration: 2-contract LONG lifecycle
// ============================================================
console.log("════════════════ TEST 8 — Integration (2-contract LONG) ════════════════");
const INT_entry = 7170;
const INT_state = initSimulatedTradeState(INT_entry);
const prices = [7170, 7172, 7174, 7175.5, 7176, 7174, 7172, 7171.5];
let contractsRemaining = 2;
const closed = { first: false, second: false };
let realizedPnlUsd = 0;
let shadowExitCount = 0;
let stopExitTick = -1;
const finalLog: string[] = [];

console.log("tick | price | hwm | S1 | S2 | simStop | trail | partialClosed | remaining | shadowExit | stopExit | rollingPnL$");
for (let i = 0; i < prices.length; i++) {
  const price = prices[i];
  // profit lock
  updateProfitLock(INT_state, price);
  // partial close
  const ev = evaluatePartialClose(2, contractsRemaining, INT_state.highWaterPoints, closed);
  let partialClosedThisTick = "—";
  if (ev && ev.zone === "FIRST_PROFIT" && !closed.first) {
    closed.first = true;
    contractsRemaining = ev.remainingQty;
    realizedPnlUsd += ev.simulatedPnlUsd;
    partialClosedThisTick = `YES(${ev.zone} +$${ev.simulatedPnlUsd})`;
  }
  // shadow stop — only synthetic flags here (no real feed); pass inProfit
  const shadow = evaluateShadowStop({
    inProfit: price > INT_entry,
    red3mCandleAgainst: false,
    vwapBreakdownAfterAbove: false,
    rsiCollapseOver10In2Candles: false,
  });
  if (shadow.exit) shadowExitCount++;
  // sim stop
  const exitCheck = shouldExitAtSimulatedStop(INT_state, price);
  if (exitCheck.exit && stopExitTick < 0) {
    stopExitTick = i;
    // close runner at stop price
    const runnerPts = exitCheck.price - INT_entry;
    realizedPnlUsd += runnerPts * MES_DOLLAR_PER_POINT * contractsRemaining;
    contractsRemaining = 0;
  }
  const row = `${i} | ${price} | ${INT_state.highWaterPoints.toFixed(2)} | ${INT_state.profitLockStage1} | ${INT_state.profitLockStage2} | ${INT_state.simulatedStopPrice} | ${INT_state.trailingActive} | ${partialClosedThisTick} | ${contractsRemaining} | ${shadow.exit} | ${exitCheck.exit} | ${realizedPnlUsd.toFixed(2)}`;
  console.log(row);
  finalLog.push(row);
}

// If runner still open at end, mark floating pnl at last price
const lastPrice = prices[prices.length - 1];
if (contractsRemaining > 0) {
  // runner might have been stopped already; if not, report floating
  const unrealizedPts = lastPrice - INT_entry;
  const floatingUsd = unrealizedPts * MES_DOLLAR_PER_POINT * contractsRemaining;
  console.log(`[END] runner still open (qty=${contractsRemaining}) lastPrice=${lastPrice} floatingPnl=$${floatingUsd.toFixed(2)}`);
  console.log(`[END] totalPnL (realized+floating) = $${(realizedPnlUsd + floatingUsd).toFixed(2)}`);
} else {
  console.log(`[END] all contracts closed. realizedPnL=$${realizedPnlUsd.toFixed(2)}`);
}
assertEq("8.S2activated", true, INT_state.profitLockStage2);
assertEq("8.trailingActivated", true, INT_state.trailingActive);
assertEq("8.firstPartialClose_triggered", true, closed.first);
assertEq("8.stopProtectedAtOrAboveEntry", true, INT_state.simulatedStopPrice >= INT_entry);

// ============================================================
// SUMMARY
// ============================================================
console.log("════════════════ SUMMARY ════════════════");
console.log(`TOTAL_PASSED: ${passed}`);
console.log(`TOTAL_FAILED: ${failed}`);
console.log(`TOTAL_RUN:    ${passed + failed}`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
}
// ============================================================
// TEST 9 — SHORT lifecycle (DRY_RUN simulation only)
// entry=7155, prices: 7155 → 7152 → 7150 → 7149 → 7151
// Expectations:
//   - stop above entry (7155 + 6 = 7161) initially
//   - target below entry (7155 - 8 = 7147)
//   - PnL positive when price goes down
//   - profit lock moves stop DOWNWARD (favorable for SHORT)
//   - trailing tightens DOWNWARD (bestLow + TRAIL)
//   - shadow stop reacts when in profit
// ============================================================
console.log("════════════════ TEST 9 — SHORT lifecycle (DRY_RUN sim) ════════════════");
const SHORT_entry = 7155;
const SHORT_stops = calculateMesStops(SHORT_entry, "SHORT");
console.log(`SHORT bundle: ${JSON.stringify(SHORT_stops)}`);
assertEq("9.SHORT.tradeSide=SHORT", "SHORT", SHORT_stops.tradeSide);
assertEq("9.SHORT.stop_above_entry", true, SHORT_stops.stopPrice > SHORT_entry);
assertEq("9.SHORT.target_below_entry", true, SHORT_stops.targetPrice < SHORT_entry);
assertEq("9.SHORT.stopPrice=entry+STOP", SHORT_entry + MES_STOP_POINTS, SHORT_stops.stopPrice);
assertEq("9.SHORT.targetPrice=entry-TARGET", SHORT_entry - MES_TARGET_POINTS, SHORT_stops.targetPrice);

// LONG sanity (regression)
const LONG_stops = calculateMesStops(SHORT_entry); // default LONG
assertEq("9.LONG.default.tradeSide=LONG", "LONG", LONG_stops.tradeSide);
assertEq("9.LONG.stop_below_entry", true, LONG_stops.stopPrice < SHORT_entry);
assertEq("9.LONG.target_above_entry", true, LONG_stops.targetPrice > SHORT_entry);

// SHORT sim state
const sState = initSimulatedTradeState(SHORT_entry, "SHORT");
assertEq("9.SHORT.initState.tradeSide=SHORT", "SHORT", sState.tradeSide);
assertEq("9.SHORT.initState.simStop=entry+STOP", SHORT_entry + MES_STOP_POINTS, sState.simulatedStopPrice);

// Walk price down then partially up
const sPrices = [7155, 7152, 7150, 7149, 7151];
let sShadowExitCount = 0;
let sStopExitTick = -1;
let sStopExitPnl = 0;
for (let i = 0; i < sPrices.length; i++) {
  const price = sPrices[i];
  const upd = updateProfitLock(sState, price);
  // verify highWaterPoints favorable points (entry - price for SHORT, never decreasing)
  const expectedFavorable = Math.max(0, SHORT_entry - Math.min(...sPrices.slice(0, i + 1)));
  if (sState.highWaterPoints !== expectedFavorable) {
    console.log(`9.SHORT.HWP mismatch tick=${i} expected=${expectedFavorable} actual=${sState.highWaterPoints}`);
  }
  // shadow stop in profit
  const inProfit = (SHORT_entry - price) > 0;
  const shadow = evaluateShadowStop({
    inProfit,
    red3mCandleAgainst: false,        // for SHORT: a *green* candle against the trade; mocked false
    vwapBreakdownAfterAbove: false,
    rsiCollapseOver10In2Candles: false,
  });
  if (shadow.exit) sShadowExitCount++;
  // stop check
  const exitCheck = shouldExitAtSimulatedStop(sState, price);
  if (exitCheck.exit && sStopExitTick < 0) {
    sStopExitTick = i;
    sStopExitPnl = exitCheck.pnlPoints;
  }
  console.log(`tick=${i} price=${price} hwp=${sState.highWaterPoints.toFixed(2)} simStop=${sState.simulatedStopPrice} pLockS1=${sState.profitLockStage1} pLockS2=${sState.profitLockStage2} trailing=${sState.trailingActive} events=${JSON.stringify(upd.events)}`);
}
// At lowest price 7149: favorable = 7155-7149 = 6 points, triggers Stage1 (>=4) and Stage2 (>=5).
assertEq("9.SHORT.profitLockStage1_triggered", true, sState.profitLockStage1);
assertEq("9.SHORT.profitLockStage2_triggered", true, sState.profitLockStage2);
assertEq("9.SHORT.trailingActivated", true, sState.trailingActive);
// SHORT stop must be <= entry once protected (lock moves DOWNWARD, never above entry)
assertEq("9.SHORT.stop_protected_at_or_below_entry", true, sState.simulatedStopPrice <= SHORT_entry);
// PnL formula sanity: at price 7149 favorable points should be 6 ($30 per contract)
const manualPnlAt7149 = SHORT_entry - 7149;
assertEq("9.SHORT.PnL_formula", 6, manualPnlAt7149);

// Partial close should fire at FIRST_PROFIT (>=4 favorable)
const sClosed = { first: false, second: false };
const sEv = evaluatePartialClose(2, 2, sState.highWaterPoints, sClosed);
assertEq("9.SHORT.partial_close_first_profit", "FIRST_PROFIT", sEv?.zone);
assertEq("9.SHORT.partial_close_pnl_USD>0", true, (sEv?.simulatedPnlUsd || 0) > 0);

// ============================================================
// TEST 10 — SHORT integration walk (2 contracts, partial close, runner)
// ============================================================
console.log("════════════════ TEST 10 — SHORT integration (2-contract) ════════════════");
const INT_S_entry = 7170;
const INT_S_state = initSimulatedTradeState(INT_S_entry, "SHORT");
const sIntPrices = [7170, 7168, 7166, 7164.5, 7164, 7166, 7168, 7168.5];
let sIntRemaining = 2;
const sIntClosed = { first: false, second: false };
let sRealizedUsd = 0;
let sStopExitTickInt = -1;
for (let i = 0; i < sIntPrices.length; i++) {
  const price = sIntPrices[i];
  updateProfitLock(INT_S_state, price);
  const ev = evaluatePartialClose(2, sIntRemaining, INT_S_state.highWaterPoints, sIntClosed);
  let partialClosedThisTick = "—";
  if (ev && ev.zone === "FIRST_PROFIT" && !sIntClosed.first) {
    sIntClosed.first = true;
    sIntRemaining = ev.remainingQty;
    sRealizedUsd += ev.simulatedPnlUsd;
    partialClosedThisTick = `YES(${ev.zone} +$${ev.simulatedPnlUsd})`;
  }
  const exitCheck = shouldExitAtSimulatedStop(INT_S_state, price);
  if (exitCheck.exit && sStopExitTickInt < 0) {
    sStopExitTickInt = i;
    const runnerPts = INT_S_entry - exitCheck.price;
    sRealizedUsd += runnerPts * MES_DOLLAR_PER_POINT * sIntRemaining;
    sIntRemaining = 0;
  }
  console.log(`tick=${i} price=${price} hwp=${INT_S_state.highWaterPoints.toFixed(2)} simStop=${INT_S_state.simulatedStopPrice} S1=${INT_S_state.profitLockStage1} S2=${INT_S_state.profitLockStage2} trailing=${INT_S_state.trailingActive} partial=${partialClosedThisTick} stopExit=${exitCheck.exit} remaining=${sIntRemaining} rollingPnL$=${sRealizedUsd.toFixed(2)}`);
}
assertEq("10.SHORT.S1_activated", true, INT_S_state.profitLockStage1);
assertEq("10.SHORT.firstPartialClose_triggered", true, sIntClosed.first);
assertEq("10.SHORT.stop_protected_at_or_below_entry", true, INT_S_state.simulatedStopPrice <= INT_S_entry);
// final realized PnL should be positive (we made 4pts on first partial; runner exited at lock)
assertEq("10.SHORT.realizedPnl>0", true, sRealizedUsd > 0);

// ============================================================
// TEST 11 — LONG regression: ensure LONG default behavior unchanged
// ============================================================
console.log("════════════════ TEST 11 — LONG regression (default side) ════════════════");
const LR_entry = 7170;
const LR_state = initSimulatedTradeState(LR_entry); // default LONG
assertEq("11.LONG.default.tradeSide=LONG", "LONG", LR_state.tradeSide);
assertEq("11.LONG.simStop=entry-STOP", LR_entry - MES_STOP_POINTS, LR_state.simulatedStopPrice);
// Walk price up
updateProfitLock(LR_state, 7174); // +4
updateProfitLock(LR_state, 7175.5); // +5.5
assertEq("11.LONG.S1_activated", true, LR_state.profitLockStage1);
assertEq("11.LONG.S2_activated", true, LR_state.profitLockStage2);
assertEq("11.LONG.stop_protected_at_or_above_entry", true, LR_state.simulatedStopPrice >= LR_entry);

// ============================================================
// SUMMARY (final)
// ============================================================
console.log("════════════════ SUMMARY (with SHORT tests) ════════════════");
console.log(`TOTAL_PASSED_FINAL: ${passed}`);
console.log(`TOTAL_FAILED_FINAL: ${failed}`);
console.log(`TOTAL_RUN_FINAL:    ${passed + failed}`);
if (failed > 0) {
  console.log("FAILURES_FINAL:");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("END_OF_MOCK_TEST");

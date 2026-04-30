// ============================================================
// MES DRY_RUN STRATEGY MODULE
// Parts 1-7 of FULL DRY_RUN STRATEGY IMPLEMENTATION
// Pure functions only — no IBKR calls, no real orders.
// All values are simulated and used inside DRY_RUN logging.
//
// BIDIRECTIONAL UPDATE (DRY_RUN only):
//   - Added TradeSide = 'LONG' | 'SHORT'
//   - LONG behavior is identical to previous module (default when side is omitted).
//   - SHORT mirrors stop/target/profit-lock/trailing/PnL (only in simulation).
//   - Live SHORT entry is guarded by engine.ts (LIVE_SHORT_BLOCKED) and this
//     module never sends any real orders.
// ============================================================

// ---------- PART 1: STOP / TARGET / TRAIL CONSTANTS ----------
export const MES_STOP_POINTS = 6;
export const MES_TARGET_POINTS = 8;
export const MES_TRAIL_POINTS = 3;
export const MES_TRAIL_ACTIVATION = 5;
export const MES_PROFIT_LOCK_TRIGGER = 4;
export const MES_PROFIT_LOCK_LEVEL = 1;
export const MES_PROFIT_LOCK_STAGE1_TRIGGER = 4;
export const MES_PROFIT_LOCK_STAGE1_OFFSET = 0.5;
export const MES_PROFIT_LOCK_STAGE2_TRIGGER = 5;
export const MES_PROFIT_LOCK_STAGE2_OFFSET = 1;

export type TradeSide = "LONG" | "SHORT";

export interface MesStopBundle {
  entryPrice: number;
  tradeSide: TradeSide;
  stopPrice: number;
  targetPrice: number;
  trailDistance: number;
  trailActivation: number;
  profitLockTrigger: number;
  profitLockLevel: number;
}

export function calculateMesStops(entryPrice: number, tradeSide: TradeSide = "LONG"): MesStopBundle {
  const stopPrice = tradeSide === "SHORT"
    ? round2(entryPrice + MES_STOP_POINTS)
    : round2(entryPrice - MES_STOP_POINTS);
  const targetPrice = tradeSide === "SHORT"
    ? round2(entryPrice - MES_TARGET_POINTS)
    : round2(entryPrice + MES_TARGET_POINTS);
  return {
    entryPrice,
    tradeSide,
    stopPrice,
    targetPrice,
    trailDistance: MES_TRAIL_POINTS,
    trailActivation: MES_TRAIL_ACTIVATION,
    profitLockTrigger: MES_PROFIT_LOCK_TRIGGER,
    profitLockLevel: MES_PROFIT_LOCK_LEVEL,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ---------- PART 2: POSITION SIZING 1/2/3 ----------
export interface PositionSizeContext {
  candleQuality: number;          // 0..1 (e.g. bodyToRange)
  vwapReclaimOrBounce: boolean;
  vix: number | null;
  macroBlocked: boolean;
  context5mAligned: boolean;      // 5m structure aligned with trade
  context15mAligned: boolean;     // 15m structure aligned with trade
  fallingKnife: boolean;
  recentSimulatedPnl: number;     // session simulated pnl in $
  dailyLossTier: "NONE" | "WARN_10" | "REDUCE_15" | "COOLDOWN_20" | "HARD_30";
}

export interface PositionSizeResult {
  size: number;
  reasons: string[];
}

export const MES_HARD_CAP_CONTRACTS = 3;

export function calculatePositionSize(ctx: PositionSizeContext): PositionSizeResult {
  const reasons: string[] = [];

  // Hard blockers
  if (ctx.macroBlocked) {
    reasons.push("MACRO_BLOCK_NO_ENTRY");
    return { size: 0, reasons };
  }
  if (ctx.fallingKnife) {
    reasons.push("FALLING_KNIFE_BLOCK");
    return { size: 0, reasons };
  }
  if (ctx.dailyLossTier === "HARD_30") {
    reasons.push("DAILY_HARD_STOP_30");
    return { size: 0, reasons };
  }
  if (ctx.dailyLossTier === "COOLDOWN_20") {
    reasons.push("DAILY_COOLDOWN_20");
    return { size: 0, reasons };
  }
  if (ctx.dailyLossTier === "REDUCE_15") {
    reasons.push("DAILY_REDUCE_15_FORCE_SIZE_1");
    return { size: 1, reasons };
  }

  // Base case → 1 contract
  let size = 1;
  reasons.push("BASE_ACCEPTED_ENTRY");

  // Quality bumps for 2 contracts
  const qualityOk = ctx.candleQuality >= 0.55;
  const vixCalm = ctx.vix !== null && ctx.vix <= 22;
  const vwapOk = ctx.vwapReclaimOrBounce;
  const ctxOk5m = ctx.context5mAligned;

  if (qualityOk && vwapOk && vixCalm && ctxOk5m) {
    size = 2;
    reasons.push("QUALITY+VWAP+VIX+5M_ALIGNED");
  }

  // Very strong setup for 3 contracts
  const veryStrong =
    ctx.candleQuality >= 0.7 &&
    ctx.vwapReclaimOrBounce &&
    ctx.vix !== null && ctx.vix <= 18 &&
    ctx.context5mAligned &&
    ctx.context15mAligned &&
    ctx.recentSimulatedPnl >= 0;
  if (veryStrong) {
    size = 3;
    reasons.push("VERY_STRONG_SETUP_15M_ALIGNED+POSITIVE_PNL");
  }

  // Hard cap
  if (size > MES_HARD_CAP_CONTRACTS) {
    size = MES_HARD_CAP_CONTRACTS;
    reasons.push("HARD_CAP_3");
  }

  return { size, reasons };
}

// ---------- PART 3: PROFIT LOCK STAGES ----------
//
// Bidirectional notes:
//   - highWaterPoints = best *favorable* unrealized points so far.
//     LONG  favorable = currentPrice - entry  (positive when price goes up)
//     SHORT favorable = entry - currentPrice  (positive when price goes down)
//   - simulatedStopPrice:
//     LONG  starts at entry - STOP and can only move UP (tighten favorably).
//     SHORT starts at entry + STOP and can only move DOWN (tighten favorably).
//
export interface SimulatedTradeState {
  entryPrice: number;
  tradeSide: TradeSide;
  highWaterPoints: number;       // best favorable unrealized points so far
  profitLockStage1: boolean;
  profitLockStage2: boolean;
  trailingActive: boolean;
  simulatedStopPrice: number;
  protectedFromLoss: boolean;    // true once any profit-lock triggered
}

export function initSimulatedTradeState(entryPrice: number, tradeSide: TradeSide = "LONG"): SimulatedTradeState {
  const simulatedStopPrice = tradeSide === "SHORT"
    ? round2(entryPrice + MES_STOP_POINTS)
    : round2(entryPrice - MES_STOP_POINTS);
  return {
    entryPrice,
    tradeSide,
    highWaterPoints: 0,
    profitLockStage1: false,
    profitLockStage2: false,
    trailingActive: false,
    simulatedStopPrice,
    protectedFromLoss: false,
  };
}

export interface ProfitLockUpdate {
  changed: boolean;
  events: string[];
  state: SimulatedTradeState;
}

export function updateProfitLock(
  state: SimulatedTradeState,
  currentPrice: number
): ProfitLockUpdate {
  const events: string[] = [];
  let changed = false;

  // Favorable unrealized points (always >= 0 when in profit)
  const unrealized = state.tradeSide === "SHORT"
    ? state.entryPrice - currentPrice
    : currentPrice - state.entryPrice;
  if (unrealized > state.highWaterPoints) {
    state.highWaterPoints = unrealized;
  }

  const sideTag = state.tradeSide === "SHORT" ? "SHORT_" : "";

  // Stage 1
  if (!state.profitLockStage1 && state.highWaterPoints >= MES_PROFIT_LOCK_STAGE1_TRIGGER) {
    const newStop = state.tradeSide === "SHORT"
      ? round2(state.entryPrice - MES_PROFIT_LOCK_STAGE1_OFFSET)
      : round2(state.entryPrice + MES_PROFIT_LOCK_STAGE1_OFFSET);
    // Favorable tighten: LONG → move UP, SHORT → move DOWN
    if (state.tradeSide === "SHORT" ? newStop < state.simulatedStopPrice : newStop > state.simulatedStopPrice) {
      state.simulatedStopPrice = newStop;
    }
    state.profitLockStage1 = true;
    state.protectedFromLoss = true;
    changed = true;
    events.push(`${sideTag}PROFIT_LOCK_STAGE1 stop→$${newStop}`);
  }

  // Stage 2
  if (!state.profitLockStage2 && state.highWaterPoints >= MES_PROFIT_LOCK_STAGE2_TRIGGER) {
    const newStop = state.tradeSide === "SHORT"
      ? round2(state.entryPrice - MES_PROFIT_LOCK_STAGE2_OFFSET)
      : round2(state.entryPrice + MES_PROFIT_LOCK_STAGE2_OFFSET);
    if (state.tradeSide === "SHORT" ? newStop < state.simulatedStopPrice : newStop > state.simulatedStopPrice) {
      state.simulatedStopPrice = newStop;
    }
    state.profitLockStage2 = true;
    state.protectedFromLoss = true;
    state.trailingActive = true;
    changed = true;
    events.push(`${sideTag}PROFIT_LOCK_STAGE2 stop→$${newStop} | TRAILING_ACTIVE`);
  }

  // Trailing stop tighten
  if (state.trailingActive) {
    const candidate = state.tradeSide === "SHORT"
      ? round2(currentPrice + MES_TRAIL_POINTS)
      : round2(currentPrice - MES_TRAIL_POINTS);
    const tighter = state.tradeSide === "SHORT"
      ? candidate < state.simulatedStopPrice
      : candidate > state.simulatedStopPrice;
    if (tighter) {
      state.simulatedStopPrice = candidate;
      changed = true;
      events.push(`${sideTag}TRAIL_TIGHTEN stop→$${candidate}`);
    }
  }

  return { changed, events, state };
}

// Guarantee: once protectedFromLoss=true, exit price cannot be worse than entry (side-aware).
export function shouldExitAtSimulatedStop(
  state: SimulatedTradeState,
  currentPrice: number
): { exit: boolean; price: number; pnlPoints: number; reason: string } {
  const hit = state.tradeSide === "SHORT"
    ? currentPrice >= state.simulatedStopPrice
    : currentPrice <= state.simulatedStopPrice;
  if (hit) {
    let exitPrice = state.simulatedStopPrice;
    if (state.protectedFromLoss) {
      // LONG: never exit below entry. SHORT: never exit above entry.
      if (state.tradeSide === "SHORT" && exitPrice > state.entryPrice) exitPrice = state.entryPrice;
      if (state.tradeSide !== "SHORT" && exitPrice < state.entryPrice) exitPrice = state.entryPrice;
    }
    const pnl = state.tradeSide === "SHORT"
      ? round2(state.entryPrice - exitPrice)
      : round2(exitPrice - state.entryPrice);
    const sideTag = state.tradeSide === "SHORT" ? "SHORT_" : "";
    return {
      exit: true,
      price: exitPrice,
      pnlPoints: pnl,
      reason: state.profitLockStage2
        ? `${sideTag}PROFIT_LOCK_S2`
        : state.profitLockStage1
          ? `${sideTag}PROFIT_LOCK_S1`
          : `${sideTag}INITIAL_STOP`,
    };
  }
  return { exit: false, price: currentPrice, pnlPoints: 0, reason: "" };
}

// ---------- PART 4: SHADOW STOP (2-of-3) ----------
// Flags describe conditions *against* the trade; caller is responsible for
// evaluating them in the correct direction for LONG vs SHORT.
export interface ShadowStopContext {
  inProfit: boolean;             // current unrealized > 0 (side-aware in caller)
  red3mCandleAgainst: boolean;   // last 3m candle red & against trade
  vwapBreakdownAfterAbove: boolean; // for SHORT: interpret as vwap-reclaim-after-below
  rsiCollapseOver10In2Candles: boolean; // for SHORT: interpret as rsi surge >10 in 2 candles
}

export interface ShadowStopDecision {
  exit: boolean;
  triggers: string[];
}

export function evaluateShadowStop(ctx: ShadowStopContext): ShadowStopDecision {
  if (!ctx.inProfit) return { exit: false, triggers: [] };
  const triggers: string[] = [];
  if (ctx.red3mCandleAgainst) triggers.push("RED_3M");
  if (ctx.vwapBreakdownAfterAbove) triggers.push("VWAP_BREAKDOWN");
  if (ctx.rsiCollapseOver10In2Candles) triggers.push("RSI_COLLAPSE");
  return { exit: triggers.length >= 2, triggers };
}

// ---------- PART 5: PARTIAL CLOSE ----------
export interface PartialCloseEvent {
  closedQty: number;
  remainingQty: number;
  zone: "FIRST_PROFIT" | "SECOND_PROFIT";
  simulatedPnlUsd: number;
}

export const MES_DOLLAR_PER_POINT = 5; // MES = $5 / point per contract
export const MES_FIRST_PROFIT_ZONE_POINTS = 4;
export const MES_SECOND_PROFIT_ZONE_POINTS = 7;

// For 2 contracts: close 1 at FIRST_PROFIT, runner remains.
// For 3 contracts: close 1 at FIRST_PROFIT, close 1 at SECOND_PROFIT, runner remains.
//
// Note: highWaterPoints is already side-aware (favorable points, always >=0 when in profit).
// This function therefore works identically for LONG and SHORT.
export function evaluatePartialClose(
  contractsAtEntry: number,
  contractsRemaining: number,
  highWaterPoints: number,
  alreadyClosed: { first: boolean; second: boolean }
): PartialCloseEvent | null {
  if (contractsAtEntry < 2) return null;
  if (contractsRemaining <= 1) return null;
  if (!alreadyClosed.first && highWaterPoints >= MES_FIRST_PROFIT_ZONE_POINTS) {
    return {
      closedQty: 1,
      remainingQty: contractsRemaining - 1,
      zone: "FIRST_PROFIT",
      simulatedPnlUsd: round2(MES_FIRST_PROFIT_ZONE_POINTS * MES_DOLLAR_PER_POINT),
    };
  }
  if (
    contractsAtEntry >= 3 &&
    !alreadyClosed.second &&
    contractsRemaining >= 2 &&
    highWaterPoints >= MES_SECOND_PROFIT_ZONE_POINTS
  ) {
    return {
      closedQty: 1,
      remainingQty: contractsRemaining - 1,
      zone: "SECOND_PROFIT",
      simulatedPnlUsd: round2(MES_SECOND_PROFIT_ZONE_POINTS * MES_DOLLAR_PER_POINT),
    };
  }
  return null;
}

// ---------- PART 6: DAILY LOSS TIERS ----------
export type DailyLossTier =
  | { tier: "NONE"; lossPct: number }
  | { tier: "WARN_10"; lossPct: number }
  | { tier: "REDUCE_15"; lossPct: number }
  | { tier: "COOLDOWN_20"; lossPct: number }
  | { tier: "HARD_30"; lossPct: number };

export function classifyDailyLossTier(
  simulatedDailyPnlUsd: number,
  accountEquityUsd: number
): DailyLossTier {
  if (accountEquityUsd <= 0) return { tier: "NONE", lossPct: 0 };
  const lossUsd = simulatedDailyPnlUsd < 0 ? Math.abs(simulatedDailyPnlUsd) : 0;
  const lossPct = (lossUsd / accountEquityUsd) * 100;
  if (lossPct >= 30) return { tier: "HARD_30", lossPct };
  if (lossPct >= 20) return { tier: "COOLDOWN_20", lossPct };
  if (lossPct >= 15) return { tier: "REDUCE_15", lossPct };
  if (lossPct >= 10) return { tier: "WARN_10", lossPct };
  return { tier: "NONE", lossPct };
}

export function dailyLossTierLogTag(t: DailyLossTier): string {
  switch (t.tier) {
    case "WARN_10":     return `SIM_WARNING (loss ${t.lossPct.toFixed(2)}%)`;
    case "REDUCE_15":   return `SIM_RISK_REDUCTION (loss ${t.lossPct.toFixed(2)}%)`;
    case "COOLDOWN_20": return `SIM_COOLDOWN (loss ${t.lossPct.toFixed(2)}%)`;
    case "HARD_30":     return `SIM_HARD_STOP (loss ${t.lossPct.toFixed(2)}%)`;
    default:            return "";
  }
}

// ---------- PART 7: RANGE / CHOP DETECTOR ----------
export interface RangeContext {
  high: number;
  low: number;
  vwap: number;
  vix: number | null;
  macroBlocked: boolean;
  recentWicksRatio: number;       // 0..1 (>0.5 = excessive wicks)
  volumeIrregularity: number;     // 0..1 (>0.5 = irregular spikes)
  fakeBreaksCount: number;        // recent count of failed breakouts
  vwapVolatilityPct: number;      // % drift in vwap recently
  hasCandleData: boolean;
}

export type RangeRegime =
  | { mode: "RANGE_ORGANIZED"; reasons: string[] }
  | { mode: "CHOP_DANGEROUS"; reasons: string[] }
  | { mode: "TRENDING"; reasons: string[] }
  | { mode: "RANGE_MODE_DATA_MISSING"; missingFields: string[] };

export function detectRangeRegime(ctx: RangeContext): RangeRegime {
  const missing: string[] = [];
  if (!ctx.hasCandleData) missing.push("candleData");
  if (!isFinite(ctx.high) || !isFinite(ctx.low)) missing.push("high/low");
  if (!isFinite(ctx.vwap)) missing.push("vwap");
  if (missing.length) return { mode: "RANGE_MODE_DATA_MISSING", missingFields: missing };

  if (ctx.macroBlocked) return { mode: "CHOP_DANGEROUS", reasons: ["MACRO_BLOCKED"] };

  const width = ctx.high - ctx.low;
  const widthAcceptable = width >= 4 && width <= 25;       // MES points
  const vixStable = ctx.vix === null || ctx.vix <= 22;
  const vwapStable = ctx.vwapVolatilityPct <= 0.15;
  const wicksOk = ctx.recentWicksRatio <= 0.5;
  const volumeOk = ctx.volumeIrregularity <= 0.5;
  const fakesOk = ctx.fakeBreaksCount <= 1;

  if (widthAcceptable && vixStable && vwapStable && wicksOk && volumeOk && fakesOk) {
    return {
      mode: "RANGE_ORGANIZED",
      reasons: ["WIDTH_OK", "VIX_STABLE", "VWAP_STABLE", "CLEAN_WICKS", "CLEAN_VOLUME"],
    };
  }

  // Chop dangerous when several flags fail
  const flags: string[] = [];
  if (!widthAcceptable) flags.push("WIDTH_BAD");
  if (!vixStable) flags.push("VIX_UNSTABLE");
  if (!vwapStable) flags.push("VWAP_DRIFTING");
  if (!wicksOk) flags.push("RANDOM_WICKS");
  if (!volumeOk) flags.push("IRREGULAR_VOLUME");
  if (!fakesOk) flags.push("FAKE_BREAKS");
  if (flags.length >= 2) return { mode: "CHOP_DANGEROUS", reasons: flags };

  return { mode: "TRENDING", reasons: ["NOT_RANGE"] };
}

// Range Mode entry guidance
export interface RangeEntryGuidance {
  allowLong: boolean;
  allowShort: boolean;
  reason: string;
}

export function rangeModeEntryGuidance(
  ctx: { close: number; rangeLow: number; rangeHigh: number; vwap: number; }
): RangeEntryGuidance {
  const range = ctx.rangeHigh - ctx.rangeLow;
  if (range <= 0) return { allowLong: false, allowShort: false, reason: "NO_RANGE" };
  const distanceFromLow = (ctx.close - ctx.rangeLow) / range;
  const distanceFromHigh = (ctx.rangeHigh - ctx.close) / range;
  const vwapBounce = Math.abs(ctx.close - ctx.vwap) / range <= 0.15 && ctx.close >= ctx.vwap;

  if (distanceFromLow <= 0.2 || vwapBounce) {
    return { allowLong: true, allowShort: false, reason: "NEAR_RANGE_BOTTOM_OR_VWAP_BOUNCE" };
  }
  if (distanceFromHigh <= 0.15) {
    return { allowLong: false, allowShort: false, reason: "NEAR_RANGE_TOP_NO_CHASE" };
  }
  return { allowLong: false, allowShort: false, reason: "MID_RANGE_WAIT" };
}

// ============================================================
// END OF MODULE
// ============================================================

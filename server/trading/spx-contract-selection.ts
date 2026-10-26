/**
 * SPXW long-only contract qualification. PURE risk policy and ranking.
 * All prices are per-share OPTION premium. One standard contract = 100x.
 * The 45%-of-premium stop is not a guaranteed maximum loss on a gap.
 *
 * This policy is for PAPER selection until same-ID broker stop amendment,
 * bracket ACK, and restart replay are proven against an IBKR paper gateway.
 */
import { SPX_INITIAL_STOP_LOSS_FRACTION } from "../../shared/spx-premium-risk.js";

export const SPX_OPTION_SELECTION = Object.freeze({
  maxContracts: 1,
  absoluteMaxPremium: 5.00,
  minimumPremium: 0.50,
  // There is no safe way to manufacture a .40-delta SPX option for $2.
  // The adaptive scan can find less ATM candidates but will NOT buy lottery wings.
  minimumAbsDelta: 0.18,
  maximumAbsDelta: 0.55,
  preferredAbsDelta: 0.32,
  maximumSpreadUsd: 0.30,
  maximumSpreadFractionOfAsk: 0.08,
  maxQuoteAgeMs: 2_000,
  minOptionVolume: 1,
  minimumFeesReserveUsd: 8,
  maxPremiumDebitFractionOfAvailable: 0.55,
  // Intended loss at initial stop: <=20% equity, not a guaranteed loss ceiling.
  maxIntendedStopLossFractionOfEquity: 0.20,
  maxBrokerBudgetAgeMs: 5_000,
});

export type SPXAccountFunds = {
  availableFunds: number;
  buyingPower: number;
  netLiquidation: number;
  timestamp: number;
};
export type SPXOptionCandidate = {
  underlying: string;
  type: "call" | "put";
  ask: number;
  bid: number;
  delta: number;
  volume: number;
  openInterest: number;
  timestamp: number;
  delayed: boolean;
  strike: number;
  expiry: string;
};
export type SPXBudget = {
  ok: true;
  maximumPremium: number;
  buyingPower: number;
  netLiquidation: number;
  maximumDebitUsd: number;
  maximumIntendedStopRiskUsd: number;
} | { ok: false; reason: string };

const roundDownCents = (n: number) => Math.floor((n + 1e-9) * 100) / 100;
export function deriveSPXBudget(funds: SPXAccountFunds | null, nowMs: number): SPXBudget {
  if (!funds || !Number.isFinite(nowMs) || !Number.isFinite(funds.timestamp) ||
      funds.timestamp > nowMs || nowMs - funds.timestamp > SPX_OPTION_SELECTION.maxBrokerBudgetAgeMs) {
    return { ok: false, reason: "LIVE_BROKER_FUNDS_MISSING_OR_STALE" };
  }
  if (![funds.availableFunds, funds.buyingPower, funds.netLiquidation].every(x => Number.isFinite(x) && x > 0)) {
    return { ok: false, reason: "LIVE_BROKER_FUNDS_INVALID" };
  }
  const l = SPX_OPTION_SELECTION;
  const usableCash = Math.max(0, Math.min(funds.availableFunds, funds.buyingPower) - l.minimumFeesReserveUsd);
  const byCapital = usableCash * l.maxPremiumDebitFractionOfAvailable / 100;
  const byStopRisk = funds.netLiquidation * l.maxIntendedStopLossFractionOfEquity /
    (100 * SPX_INITIAL_STOP_LOSS_FRACTION);
  const maximumPremium = roundDownCents(Math.min(l.absoluteMaxPremium, byCapital, byStopRisk));
  if (maximumPremium < l.minimumPremium) {
    return { ok: false, reason: "NO_SAFELY_AFFORDABLE_SPX_OPTION" };
  }
  return {
    ok: true, maximumPremium,
    buyingPower: funds.buyingPower,
    netLiquidation: funds.netLiquidation,
    maximumDebitUsd: roundDownCents(maximumPremium * 100),
    maximumIntendedStopRiskUsd: roundDownCents(maximumPremium * 100 * SPX_INITIAL_STOP_LOSS_FRACTION),
  };
}
export type SPXCandidateVerdict = {
  qualified: boolean;
  reasons: string[];
  score: number;
  absoluteDelta: number;
  costUsd: number;
};
export function assessSPXCandidate(
  option: SPXOptionCandidate,
  budget: SPXBudget,
  nowMs: number,
): SPXCandidateVerdict {
  const x = SPX_OPTION_SELECTION;
  const reasons: string[] = [];
  if (!budget.ok) reasons.push("BUDGET_UNVERIFIED");
  if (option.underlying !== "SPX" || !["call","put"].includes(option.type))
    reasons.push("NOT_SPX_LONG_OPTION");
  if (!Number.isFinite(option.strike) || option.strike <= 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(option.expiry))
    reasons.push("SPX_CONTRACT_INVALID");
  const delta = Math.abs(option.delta);
  if (!Number.isFinite(option.delta) || delta < x.minimumAbsDelta || delta > x.maximumAbsDelta ||
      (option.type === "call" && option.delta <= 0) ||
      (option.type === "put" && option.delta >= 0))
    reasons.push("DELTA_OUT_OF_RANGE_OR_WRONG_DIRECTION");
  if (option.delayed || !Number.isFinite(option.timestamp) || !Number.isFinite(nowMs) ||
      option.timestamp > nowMs || nowMs - option.timestamp > x.maxQuoteAgeMs)
    reasons.push("OPTION_QUOTE_NOT_FRESH_LIVE");
  if (!Number.isFinite(option.bid) || !Number.isFinite(option.ask) ||
      option.bid <= 0 || option.ask < option.bid || option.ask < x.minimumPremium ||
      option.ask > x.absoluteMaxPremium)
    reasons.push("OPTION_BID_ASK_INVALID");
  if (!Number.isFinite(option.volume) || option.volume < x.minOptionVolume)
    reasons.push("OPTION_TRADING_ACTIVITY_UNVERIFIED");
  const spread = option.ask - option.bid;
  const spreadFraction = option.ask > 0 ? spread / option.ask : Infinity;
  if (!Number.isFinite(spreadFraction) || spread < 0 ||
      spread > x.maximumSpreadUsd || spreadFraction > x.maximumSpreadFractionOfAsk)
    reasons.push("OPTION_SPREAD_TOO_WIDE");
  if (budget.ok) {
    if (option.ask > budget.maximumPremium) reasons.push("ABOVE_BROKER_RISK_BUDGET");
    if (option.ask * 100 + x.minimumFeesReserveUsd > budget.buyingPower)
      reasons.push("BROKER_BUYING_POWER_INSUFFICIENT");
  }
  // Maximize delta proximity with explicit liquidity/spread penalties.
  // This score is only used AFTER all hard risk filters pass.
  const deltaScore = 100 - 140 * Math.abs(delta - x.preferredAbsDelta);
  const spreadPenalty = Number.isFinite(spreadFraction) ? spreadFraction * 120 : 100;
  const volumeBonus = Math.log10(Math.max(1, option.volume)) * 2;
  return {
    qualified: reasons.length === 0,
    reasons,
    score: Number((deltaScore - spreadPenalty + volumeBonus).toFixed(3)),
    absoluteDelta: delta,
    costUsd: option.ask * 100,
  };
}
export function rankSPXOptions<T extends SPXOptionCandidate>(
  options: readonly T[], budget: SPXBudget, nowMs: number,
): T[] {
  return options.filter(q => assessSPXCandidate(q,budget,nowMs).qualified)
    .sort((a,b) => {
      const va=assessSPXCandidate(a,budget,nowMs), vb=assessSPXCandidate(b,budget,nowMs);
      return vb.score-va.score || a.ask-b.ask || a.strike-b.strike;
    });
}

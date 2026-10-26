import { SPX_INITIAL_STOP_RETAINED_FRACTION } from "../../shared/spx-premium-risk.js";
/**
 * Autonomous SPX option entry PRE-FLIGHT. Pure function, no IBKR network/IO.
 * Emits a paper candidate only. NEVER routes an order or changes bot state.
 * Must not be wired to Live until end-to-end paper tests and authorization.
 */
export interface LiveSPXOptionQuote {
  bid: number;
  ask: number;
  timestampMs: number;
  marketDataType: "LIVE" | "DELAYED" | "UNKNOWN";
  connected: boolean;
}
export interface VerifiedSPXContract {
  conId: number;
  symbol: string; // Must be SPX (not SPY)
  expiryEpochMs: number;
  multiplier: number; // US SPX option typically 100
  minTick: number;    // From verified exchange contract details
  right: "CALL" | "PUT";
}
export interface AutonomousSignal {
  decision: "EXECUTE" | "ALERT ONLY" | "REJECT";
  confidence: number;
  timestampMs: number;
  right: "CALL" | "PUT";
  confirmedTrend: boolean;
  confirmedLiquidity: boolean;
  newsClear: boolean; // false if unknown or news embargo active
  reasonCodes: string[];
}
export interface AccountRiskSnapshot {
  brokerConnected: boolean;
  accountMatchesConfigured: boolean;
  availableFundsUsd: number;
  buyingPowerUsd: number;
  netLiquidationUsd: number;
  dailyRealizedPnlUsd: number;
  openPositionCount: number;
  pendingEntryOrders: number;
  dayTradesCount: number;
  sessionOpenVerified: boolean;
  stopProtectionServiceReady: boolean;
}
export interface AutonomousEntryLimits {
  minConfidence: number;
  maxQuoteAgeMs: number;
  maxSignalAgeMs: number;
  maxSpreadFractionOfAsk: number;
  maxOpenPositions: number;
  maxDayTrades: number;
  maxDailyLossUsd: number;
  maxPremiumOutlayUsd: number;
  maxInitialLossUsd: number;
  initialStopFraction: number;
}
export interface AutonomousEntryResult {
  action: "BLOCK" | "PAPER_ENTRY_CANDIDATE";
  reasons: string[];
  premiumAsk?: number;
  estimatedDebitUsd?: number;
  estimatedRiskUsd?: number;
  contractId?: number;
}
const invalid = (x: number) => !Number.isFinite(x);
export function previewAutonomousSPXEntry(input: {
  nowMs: number;
  signal: AutonomousSignal;
  quote: LiveSPXOptionQuote;
  contract: VerifiedSPXContract;
  account: AccountRiskSnapshot;
  limits: AutonomousEntryLimits;
}): AutonomousEntryResult {
  const { nowMs, signal, quote, contract, account, limits } = input;
  const reasons: string[] = [];
  if (invalid(nowMs) || nowMs <= 0) reasons.push("CLOCK_INVALID");
  if (signal.decision !== "EXECUTE" || invalid(signal.confidence) || signal.confidence < limits.minConfidence)
    reasons.push("NO_QUALIFIED_ENTRY_SIGNAL");
  if (!signal.confirmedTrend || !signal.confirmedLiquidity || !signal.newsClear)
    reasons.push("SIGNAL_CONFIRMATION_MISSING");
  if (signal.right !== contract.right) reasons.push("SIGNAL_CONTRACT_DIRECTION_MISMATCH");
  if (!account.sessionOpenVerified) reasons.push("SESSION_NOT_VERIFIED");
  if (!account.brokerConnected || !account.accountMatchesConfigured) reasons.push("BROKER_ACCOUNT_NOT_VERIFIED");
  if (!account.stopProtectionServiceReady) reasons.push("BROKER_SIDE_STOP_NOT_READY");
  if (account.openPositionCount >= limits.maxOpenPositions || account.pendingEntryOrders !== 0)
    reasons.push("ALREADY_EXPOSED_OR_PENDING_ENTRY");
  if (account.dayTradesCount >= limits.maxDayTrades) reasons.push("TRADE_LIMIT_REACHED");
  if (invalid(account.dailyRealizedPnlUsd) || account.dailyRealizedPnlUsd <= -limits.maxDailyLossUsd)
    reasons.push("DAILY_LOSS_GUARD");
  const ageValid = (stamp: number, maxAge: number) =>
    Number.isFinite(stamp) && nowMs >= stamp && nowMs - stamp <= maxAge;
  if (!ageValid(signal.timestampMs, limits.maxSignalAgeMs)) reasons.push("SIGNAL_STALE");
  if (!quote.connected || quote.marketDataType !== "LIVE" || !ageValid(quote.timestampMs, limits.maxQuoteAgeMs))
    reasons.push("OPTION_QUOTE_NOT_FRESH_LIVE");
  if (contract.symbol !== "SPX" || !Number.isSafeInteger(contract.conId) || contract.conId <= 0 ||
      !Number.isFinite(contract.expiryEpochMs) || contract.expiryEpochMs <= nowMs ||
      contract.multiplier !== 100 || invalid(contract.minTick) || contract.minTick <= 0)
    reasons.push("CONTRACT_NOT_QUALIFIED");
  if (invalid(quote.bid) || invalid(quote.ask) || quote.bid <= 0 || quote.ask < quote.bid)
    reasons.push("OPTION_BID_ASK_INVALID");
  if ([limits.minConfidence, limits.maxQuoteAgeMs, limits.maxSignalAgeMs,
       limits.maxSpreadFractionOfAsk, limits.maxOpenPositions, limits.maxDayTrades,
       limits.maxDailyLossUsd, limits.maxPremiumOutlayUsd, limits.maxInitialLossUsd,
       limits.initialStopFraction].some(invalid) ||
      limits.minConfidence < 0 || limits.minConfidence > 100 ||
      limits.maxQuoteAgeMs <= 0 || limits.maxQuoteAgeMs > 2000 ||
      limits.maxSignalAgeMs <= 0 || limits.maxSignalAgeMs > 2000 ||
      limits.maxSpreadFractionOfAsk <= 0 || limits.maxSpreadFractionOfAsk > 0.5 ||
      limits.maxOpenPositions !== 1 || limits.maxDayTrades <= 0 ||
      limits.maxDailyLossUsd <= 0 || limits.maxPremiumOutlayUsd <= 0 ||
      limits.maxInitialLossUsd <= 0 || limits.initialStopFraction !== SPX_INITIAL_STOP_RETAINED_FRACTION)
    reasons.push("RISK_LIMITS_NOT_APPROVED");
  if (invalid(account.availableFundsUsd) || invalid(account.buyingPowerUsd) ||
      invalid(account.netLiquidationUsd) || account.availableFundsUsd <= 0 ||
      account.buyingPowerUsd <= 0 || account.netLiquidationUsd <= 0 ||
      !Number.isInteger(account.openPositionCount) || account.openPositionCount < 0 ||
      !Number.isInteger(account.pendingEntryOrders) || account.pendingEntryOrders < 0 ||
      !Number.isInteger(account.dayTradesCount) || account.dayTradesCount < 0)
    reasons.push("ACCOUNT_SNAPSHOT_INVALID");
  if (reasons.length !== 0) return { action: "BLOCK", reasons };

  // A standard SPX option costs premium times 100. Ignore commission at preview
  // stage: actual broker purchasing-power check must include all fees.
  const spreadFraction = (quote.ask - quote.bid) / quote.ask;
  if (spreadFraction > limits.maxSpreadFractionOfAsk) reasons.push("SPREAD_TOO_WIDE");
  const debitUsd = quote.ask * contract.multiplier;
  const initialRiskUsd = debitUsd * (1 - limits.initialStopFraction);
  if (debitUsd > account.availableFundsUsd || debitUsd > account.buyingPowerUsd ||
      debitUsd > limits.maxPremiumOutlayUsd)
    reasons.push("INSUFFICIENT_PURCHASING_POWER_OR_BUDGET");
  if (initialRiskUsd > limits.maxInitialLossUsd) reasons.push("INITIAL_RISK_TOO_HIGH");
  if (reasons.length > 0) return { action: "BLOCK", reasons };
  return {
    action: "PAPER_ENTRY_CANDIDATE",
    reasons: [],
    premiumAsk: quote.ask,
    estimatedDebitUsd: Number(debitUsd.toFixed(2)),
    estimatedRiskUsd: Number(initialRiskUsd.toFixed(2)),
    contractId: contract.conId,
  };
}

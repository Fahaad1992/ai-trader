/**
 * SPX / equity option premium risk policy, independent of the futures engine.
 *
 * READ-ONLY / PREVIEW-ONLY. NO IBKR imports, NO order submission, NO I/O.
 * All premiums are per option share. This module proposes a protective stop;
 * it cannot guarantee a fill, change an order, or ensure protection at a broker.
 */
export interface PremiumStopConfig {
  initialStopFraction: number;
  firstTrigger: number;
  firstProtectedGain: number;
  secondTrigger: number;
  secondProtectedGain: number;
  breakoutTrigger: number;
  continuationStep: number;
  tickSize: number;
  maxQuoteAgeMs: number;
}
export const DEFAULT_PREMIUM_STOP_CONFIG: Readonly<PremiumStopConfig> = Object.freeze({
  initialStopFraction: 0.55,
  firstTrigger: 0.50,
  firstProtectedGain: 0.20,
  secondTrigger: 1.00,
  secondProtectedGain: 0.50,
  breakoutTrigger: 1.00,
  continuationStep: 0.50, // Provisional after $4.00 at entry $3.00; NOT live-approved
  tickSize: 0.01, // Preview only; obtain real minimum tick from qualified contract
  maxQuoteAgeMs: 2000,
});
export interface PremiumStopState {
  readonly entryPremium: number;
  readonly peakBid: number;
  readonly confirmedStop: number;
  readonly pendingStop: number | null;
  readonly lastQuoteTimestampMs: number | null;
}
export interface PremiumQuote {
  readonly bid: number;
  readonly ask: number;
  readonly timestampMs: number;
  readonly connected: boolean;
  readonly marketDataType: "LIVE" | "DELAYED" | "UNKNOWN";
}
export type PreviewReason =
  | "PROPOSE_RAISE" | "NO_CHANGE" | "PENDING_ACK" | "DISCONNECTED"
  | "NOT_LIVE_DATA" | "STALE_OR_FUTURE_QUOTE" | "OUT_OF_ORDER_QUOTE"
  | "INVALID_MARKET_QUOTE" | "AT_OR_BELOW_EXISTING_STOP"
  | "STOP_WOULD_CROSS_BID";
export interface PremiumStopPreview {
  readonly nextState: PremiumStopState;
  readonly proposedStop: number | null;
  readonly reason: PreviewReason;
  readonly action: "PREVIEW_ONLY";
}
function requireFinitePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(field + "_MUST_BE_POSITIVE");
}
function resolveConfig(overrides: Partial<PremiumStopConfig>): PremiumStopConfig {
  const config = { ...DEFAULT_PREMIUM_STOP_CONFIG, ...overrides };
  for (const key of ["firstTrigger", "secondTrigger", "breakoutTrigger", "continuationStep", "tickSize", "maxQuoteAgeMs"] as const) {
    requireFinitePositive(config[key], key);
  }
  if (!Number.isFinite(config.initialStopFraction) || config.initialStopFraction <= 0 || config.initialStopFraction >= 1) {
    throw new Error("INITIAL_STOP_FRACTION_INVALID");
  }
  if (!(config.firstTrigger <= config.secondTrigger && config.secondTrigger <= config.breakoutTrigger)) {
    throw new Error("TRIGGER_ORDER_INVALID");
  }
  if (!(config.firstProtectedGain >= 0 && config.firstProtectedGain <= config.firstTrigger &&
    config.secondProtectedGain >= config.firstProtectedGain && config.secondProtectedGain <= config.secondTrigger)) {
    throw new Error("PROTECTED_GAIN_INVALID");
  }
  return config;
}
function ticks(price: number, tickSize: number): number {
  return Math.floor(price / tickSize + 1e-8);
}
function priceFromTicks(priceTicks: number, tickSize: number): number {
  return Number((priceTicks * tickSize).toFixed(8));
}
function thresholdTicks(amount: number, tickSize: number): number {
  return Math.ceil(amount / tickSize - 1e-8);
}
/** Draft state. The caller must arrange and confirm initial BROKER-SIDE protection. */
export function createPremiumStopState(
  entryPremium: number,
  options: Partial<PremiumStopConfig> = {},
): PremiumStopState {
  const config = resolveConfig(options);
  requireFinitePositive(entryPremium, "ENTRY_PREMIUM");
  const entryTick = Math.round(entryPremium / config.tickSize);
  if (Math.abs(priceFromTicks(entryTick, config.tickSize) - entryPremium) > 1e-8) {
    throw new Error("ENTRY_NOT_ON_CONTRACT_TICK");
  }
  const stopTick = Math.floor(entryTick * config.initialStopFraction + 1e-8);
  if (stopTick <= 0 || stopTick >= entryTick) throw new Error("INITIAL_STOP_INVALID");
  return {
    entryPremium: priceFromTicks(entryTick, config.tickSize),
    peakBid: priceFromTicks(entryTick, config.tickSize),
    confirmedStop: priceFromTicks(stopTick, config.tickSize),
    pendingStop: null,
    lastQuoteTimestampMs: null,
  };
}
/** Pure stop proposal: NEVER modifies brokerage state. */
export function previewPremiumStop(
  state: PremiumStopState,
  quote: PremiumQuote,
  nowMs: number,
  options: Partial<PremiumStopConfig> = {},
): PremiumStopPreview {
  const config = resolveConfig(options);
  const unchanged = (reason: PreviewReason, nextState = state): PremiumStopPreview => ({
    nextState, proposedStop: null, reason, action: "PREVIEW_ONLY",
  });
  if (!quote.connected) return unchanged("DISCONNECTED");
  if (quote.marketDataType !== "LIVE") return unchanged("NOT_LIVE_DATA");
  if (!Number.isFinite(nowMs) || !Number.isFinite(quote.timestampMs) ||
      quote.timestampMs > nowMs || nowMs - quote.timestampMs > config.maxQuoteAgeMs) {
    return unchanged("STALE_OR_FUTURE_QUOTE");
  }
  if (state.lastQuoteTimestampMs !== null && quote.timestampMs <= state.lastQuoteTimestampMs) {
    return unchanged("OUT_OF_ORDER_QUOTE");
  }
  if (!Number.isFinite(quote.bid) || quote.bid <= 0 || !Number.isFinite(quote.ask) || quote.ask < quote.bid) {
    return unchanged("INVALID_MARKET_QUOTE");
  }
  const entryTicks = ticks(state.entryPremium, config.tickSize);
  const currentBidTicks = ticks(quote.bid, config.tickSize);
  const peakTicks = Math.max(ticks(state.peakBid, config.tickSize), currentBidTicks);
  const acknowledgedTicks = ticks(state.confirmedStop, config.tickSize);
  const nextState: PremiumStopState = {
    ...state,
    peakBid: priceFromTicks(peakTicks, config.tickSize),
    lastQuoteTimestampMs: quote.timestampMs,
  };
  if (currentBidTicks <= acknowledgedTicks) return unchanged("AT_OR_BELOW_EXISTING_STOP", nextState);
  if (state.pendingStop !== null) return unchanged("PENDING_ACK", nextState);
  const gained = peakTicks - entryTicks;
  let requestedTicks = acknowledgedTicks;
  if (gained >= thresholdTicks(config.firstTrigger, config.tickSize)) {
    requestedTicks = Math.max(requestedTicks, entryTicks + ticks(config.firstProtectedGain, config.tickSize));
  }
  if (gained >= thresholdTicks(config.secondTrigger, config.tickSize)) {
    requestedTicks = Math.max(requestedTicks, entryTicks + ticks(config.secondProtectedGain, config.tickSize));
  }
  const breakoutTicks = thresholdTicks(config.breakoutTrigger, config.tickSize);
  if (gained > breakoutTicks) {
    const stepTicks = thresholdTicks(config.continuationStep, config.tickSize);
    // At 4.01 for entry 3.00, protect 4.00; at 4.51 protect 4.50.
    const completedSteps = Math.floor((gained - breakoutTicks - 1) / stepTicks);
    requestedTicks = Math.max(requestedTicks, entryTicks + breakoutTicks + completedSteps * stepTicks);
  }
  if (requestedTicks <= acknowledgedTicks) return unchanged("NO_CHANGE", nextState);
  if (requestedTicks >= currentBidTicks) return unchanged("STOP_WOULD_CROSS_BID", nextState);
  const proposedStop = priceFromTicks(requestedTicks, config.tickSize);
  return {
    nextState: { ...nextState, pendingStop: proposedStop },
    proposedStop, reason: "PROPOSE_RAISE", action: "PREVIEW_ONLY",
  };
}
/** Pure representation of broker ACK. Must NEVER be called before actual confirmed broker receipt. */
export function recordConfirmedPremiumStop(
  state: PremiumStopState, brokerConfirmedStop: number,
  options: Partial<PremiumStopConfig> = {},
): PremiumStopState {
  const config = resolveConfig(options);
  if (state.pendingStop === null) throw new Error("NO_PENDING_STOP_UPDATE");
  if (!Number.isFinite(brokerConfirmedStop) ||
      ticks(brokerConfirmedStop, config.tickSize) !== ticks(state.pendingStop, config.tickSize) ||
      brokerConfirmedStop < state.confirmedStop) throw new Error("BROKER_ACK_MISMATCH_OR_LOWER_STOP");
  return { ...state, confirmedStop: state.pendingStop, pendingStop: null };
}
/** A rejected/expired amendment must never erase the previous confirmed stop. */
export function rejectPendingPremiumStop(state: PremiumStopState): PremiumStopState {
  return { ...state, pendingStop: null };
}

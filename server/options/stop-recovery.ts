/**
 * Read-only recovery of SPX long-option protective stop state.
 *
 * A broker-side stop must survive a bot disconnect independently of the bot.
 * This module never sends orders, cancels stops or invents broker ACKs.
 */
import {
  previewPremiumStop,
  type PremiumStopState,
  type PremiumQuote,
  type PremiumStopPreview,
} from "./premium-stop-ladder.js";

export interface SavedSPXStop {
  accountId: string;
  conId: number;
  entryPremium: number;
  quantity: number;
  entryOrderId: number;
  stopOrderId: number;
  stopPermId: number | null;
  right: "CALL" | "PUT";
  expiry: string;
  strike: number;
  tickSize: number;
  peakBid: number;
  lastConfirmedStop: number;
  lastQuoteTimestampMs: number | null;
  recordedAtMs: number;
}
export interface BrokerSPXPosition {
  accountId: string;
  conId: number;
  symbol: string;
  secType: string;
  quantity: number;
  right?: string;
  expiry?: string;
  strike?: number;
}
export interface BrokerSPXOrder {
  orderId: number;
  permId?: number | null;
  conId: number;
  symbol: string;
  secType: string;
  action: string;
  orderType: string;
  status: string;
  auxPrice?: number | null;
  parentId?: number | null;
  totalQuantity: number;
}
export interface RecoveryBrokerSnapshot {
  connected: boolean;
  completed: boolean;
  accountId: string;
  retrievedAtMs: number;
  positions: readonly BrokerSPXPosition[];
  orders: readonly BrokerSPXOrder[];
}
export interface RecoveredSPXStop {
  saved: SavedSPXStop;
  stopState: PremiumStopState;
  activeStopOrderId: number;
  stopPriceAtBroker: number;
}
export type SPXRecoveryDecision =
  | { status: "FLAT"; reason: "NO_OPEN_EXPOSURE" }
  | { status: "BLOCK_AND_ALERT"; reason: string }
  | { status: "RESUME_MONITORING"; recovered: RecoveredSPXStop };

// PendingSubmit/ApiPending are NOT broker-confirmed working protective orders.
const workingStatuses = new Set(["SUBMITTED", "PRESUBMITTED"]);
function validNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function equalsWithinTick(a: number, b: number, tick: number): boolean {
  return Math.abs(a - b) < tick / 5;
}

/** Must be called only on a COMPLETED broker snapshot; unknown ≠ flat. */
export function reconcileSPXStop(
  saved: SavedSPXStop | null,
  broker: RecoveryBrokerSnapshot | null,
  expectedAccountId: string,
  nowMs: number,
  maxSnapshotAgeMs = 5000,
): SPXRecoveryDecision {
  const block = (reason: string): SPXRecoveryDecision => ({ status: "BLOCK_AND_ALERT", reason });
  if (!expectedAccountId || !broker || !broker.connected || !broker.completed ||
      broker.accountId !== expectedAccountId || !validNumber(nowMs) ||
      !validNumber(broker.retrievedAtMs) || nowMs < broker.retrievedAtMs ||
      nowMs - broker.retrievedAtMs > maxSnapshotAgeMs ||
      !Array.isArray(broker.positions) || !Array.isArray(broker.orders)) {
    return block("BROKER_SNAPSHOT_UNKNOWN_OR_STALE");
  }
  if (!saved) {
    return broker.positions.length === 0 && broker.orders.length === 0
      ? { status: "FLAT", reason: "NO_OPEN_EXPOSURE" }
      : block("ORPHANED_BROKER_EXPOSURE_NO_SAVED_STOP");
  }
  if (saved.accountId !== expectedAccountId ||
      !Number.isSafeInteger(saved.conId) || saved.conId <= 0 ||
      !Number.isSafeInteger(saved.stopOrderId) || saved.stopOrderId <= 0 ||
      !Number.isSafeInteger(saved.entryOrderId) || saved.entryOrderId <= 0 ||
      !validNumber(saved.entryPremium) || saved.entryPremium <= 0 ||
      !validNumber(saved.tickSize) || saved.tickSize <= 0 ||
      !validNumber(saved.lastConfirmedStop) || saved.lastConfirmedStop <= 0 ||
      !validNumber(saved.peakBid) || saved.peakBid < saved.entryPremium ||
      !validNumber(saved.strike) || saved.strike <= 0 ||
      saved.quantity !== 1 ||
      !/^\d{8}$/.test(saved.expiry) ||
      (saved.right !== "CALL" && saved.right !== "PUT") ||
      !validNumber(saved.recordedAtMs) || saved.recordedAtMs > nowMs) {
    return block("INVALID_SAVED_STOP_STATE");
  }
  const p = broker.positions.filter(pos => pos.quantity !== 0);
  if (p.length !== 1) {
    return block(p.length === 0 ? "SAVED_TRADE_NOT_AT_BROKER" : "MULTIPLE_OR_UNKNOWN_BROKER_POSITIONS");
  }
  const position = p[0];
  if (position.accountId !== expectedAccountId ||
      position.conId !== saved.conId || position.quantity !== saved.quantity ||
      position.secType.toUpperCase() !== "OPT" || position.symbol.toUpperCase() !== "SPX") {
    return block("BROKER_POSITION_CONTRACT_OR_QUANTITY_MISMATCH");
  }
  const stops = broker.orders.filter(o => o.orderId === saved.stopOrderId);
  if (stops.length !== 1) return block("SAVED_PROTECTIVE_STOP_NOT_VISIBLE_AT_BROKER");
  const stop = stops[0];
  if (stop.conId !== saved.conId || stop.secType.toUpperCase() !== "OPT" ||
      stop.symbol.toUpperCase() !== "SPX" || stop.action.toUpperCase() !== "SELL" ||
      stop.orderType.toUpperCase() !== "STP" || stop.totalQuantity !== saved.quantity ||
      !workingStatuses.has(stop.status.toUpperCase()) ||
      !validNumber(stop.auxPrice) || stop.auxPrice <= 0 ||
      stop.parentId !== saved.entryOrderId ||
      (saved.stopPermId !== null && stop.permId !== saved.stopPermId)) {
    return block("BROKER_STOP_CONTRACT_STATUS_OR_ID_MISMATCH");
  }
  // Unknown extra orders require an explicit review. Never silently adopt.
  if (broker.orders.some(o => o.orderId !== saved.stopOrderId)) {
    return block("OTHER_BROKER_ORDER_PRESENT");
  }
  if (stop.auxPrice < saved.lastConfirmedStop - saved.tickSize / 5) {
    return block("BROKER_STOP_LOWER_THAN_LAST_CONFIRMED");
  }
  // Never assume local requested stop took effect: broker ACK is authoritative.
  const actualStop = stop.auxPrice;
  const stopState: PremiumStopState = {
    entryPremium: saved.entryPremium,
    peakBid: saved.peakBid,
    confirmedStop: actualStop,
    pendingStop: null, // a crashed pending modification MUST be rechecked, not trusted
    lastQuoteTimestampMs: null, // only fresh post-recovery quotes can be used
  };
  return {
    status: "RESUME_MONITORING",
    recovered: {
      saved: { ...saved, lastConfirmedStop: actualStop, lastQuoteTimestampMs: null },
      stopState, activeStopOrderId: saved.stopOrderId, stopPriceAtBroker: actualStop,
    },
  };
}

/**
 * Create a durable stop record ONLY after the broker confirms both the
 * filled position and its working stop child with the SAME contract identity.
 * A locally assumed fill / simulated broker ACK must never reach this method.
 */
export function createVerifiedSPXStopRecord(input: {
  accountId: string;
  conId: number;
  entryPremium: number;
  quantity: number;
  entryOrderId: number;
  stopOrderId: number;
  right: "CALL" | "PUT";
  expiry: string;
  strike: number;
  tickSize: number;
  broker: RecoveryBrokerSnapshot;
  nowMs: number;
}): SavedSPXStop {
  const stop = input.broker.orders.find(o => o.orderId === input.stopOrderId);
  const position = input.broker.positions.find(p => p.conId === input.conId);
  if (!stop || !position || !validNumber(stop.auxPrice) ||
      !validNumber(input.entryPremium) || input.entryPremium <= 0 ||
      !validNumber(input.tickSize) || input.tickSize <= 0 ||
      !validNumber(stop.permId) || stop.permId <= 0) {
    throw new Error("SPX_INITIAL_STOP_NOT_VERIFIED_BY_BROKER");
  }
  const record: SavedSPXStop = {
    accountId: input.accountId, conId: input.conId,
    entryPremium: input.entryPremium, quantity: input.quantity,
    entryOrderId: input.entryOrderId, stopOrderId: input.stopOrderId,
    stopPermId: stop.permId, right: input.right,
    expiry: input.expiry, strike: input.strike, tickSize: input.tickSize,
    peakBid: input.entryPremium, lastConfirmedStop: stop.auxPrice,
    lastQuoteTimestampMs: null, recordedAtMs: input.nowMs,
  };
  const decision = reconcileSPXStop(record, input.broker, input.accountId, input.nowMs);
  if (decision.status !== "RESUME_MONITORING" ||
      stop.auxPrice < input.entryPremium * 0.55 - input.tickSize / 5) {
    throw new Error("SPX_INITIAL_STOP_POSITION_OR_PROTECTION_UNVERIFIED");
  }
  return record;
}

/** Pure recommendation. Never modify broker stop until ack confirmed. */
export function previewRecoveredSPXStopRaise(
  recovered: RecoveredSPXStop,
  quote: PremiumQuote,
  nowMs: number,
): PremiumStopPreview {
  return previewPremiumStop(recovered.stopState, quote, nowMs, {
    tickSize: recovered.saved.tickSize,
  });
}
/** Persist AFTER positive broker confirmation; a request/submission isn't an ACK. */
export function commitConfirmedRecoveredSPXStop(
  recovered: RecoveredSPXStop,
  confirmedStop: number,
  brokerOrderId: number,
): RecoveredSPXStop {
  if (brokerOrderId !== recovered.activeStopOrderId ||
      !validNumber(confirmedStop) ||
      confirmedStop < recovered.stopPriceAtBroker ||
      !equalsWithinTick(confirmedStop, recovered.stopState.pendingStop ?? NaN, recovered.saved.tickSize)) {
    throw new Error("SPX_STOP_AMENDMENT_NOT_BROKER_CONFIRMED");
  }
  return {
    ...recovered,
    stopPriceAtBroker: confirmedStop,
    saved: { ...recovered.saved, lastConfirmedStop: confirmedStop, peakBid: recovered.stopState.peakBid },
    stopState: {
      ...recovered.stopState,
      confirmedStop,
      pendingStop: null,
    },
  };
}

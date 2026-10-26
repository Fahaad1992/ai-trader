/**
 * SPX paper-only event-driven reducer. Call on each incoming qualified live
 * option quote or separately verified entry signal; NO timers or IBKR I/O.
 *
 * This is NOT connected to any live market feed or broker yet.
 */
import {
  createPremiumStopState, previewPremiumStop, recordConfirmedPremiumStop,
  type PremiumStopState, type PremiumQuote,
} from "./premium-stop-ladder.js";
import {
  previewAutonomousSPXEntry,
  type AutonomousSignal, type LiveSPXOptionQuote,
  type VerifiedSPXContract, type AccountRiskSnapshot, type AutonomousEntryLimits,
} from "./autonomous-entry-guard.js";

export interface PaperSPXPosition {
  contractId: number;
  entryPremium: number;
  entryTimeMs: number;
  stopState: PremiumStopState;
  multiplier: number;
  minTick: number;
}
export interface PaperSPXState {
  position: PaperSPXPosition | null;
  closedTrades: number;
  realizedPnLUsd: number;
  lastEvent: PaperSPXEvent | null;
}
export interface PaperSPXEvent {
  type: "PAPER_ENTRY" | "PAPER_EXIT" | "PAPER_STOP_RAISED" | "PAPER_REJECT" | "PAPER_NO_CHANGE";
  reason: string;
  contractId?: number;
  price?: number;
  stop?: number;
  estimatedPnLUsd?: number;
}
export const EMPTY_PAPER_SPX_STATE: Readonly<PaperSPXState> = Object.freeze({
  position: null, closedTrades: 0, realizedPnLUsd: 0, lastEvent: null,
});

export function onSPXPaperSignal(
  state: PaperSPXState,
  input: {
    nowMs: number;
    signal: AutonomousSignal;
    quote: LiveSPXOptionQuote;
    contract: VerifiedSPXContract;
    account: AccountRiskSnapshot;
    limits: AutonomousEntryLimits;
  },
): PaperSPXState {
  if (state.position !== null) {
    return { ...state, lastEvent: { type: "PAPER_REJECT", reason: "ONE_POSITION_ALREADY_OPEN" } };
  }
  const candidate = previewAutonomousSPXEntry(input);
  if (candidate.action !== "PAPER_ENTRY_CANDIDATE") {
    return { ...state, lastEvent: {
      type: "PAPER_REJECT", reason: candidate.reasons.join(","),
    } };
  }
  // PAPER ONLY: assume a fill at quoted ask for simulation; not a broker fill.
  const initial = createPremiumStopState(input.quote.ask, {
    tickSize: input.contract.minTick, initialStopFraction: input.limits.initialStopFraction,
  });
  return {
    ...state,
    position: {
      contractId: input.contract.conId,
      entryPremium: input.quote.ask,
      entryTimeMs: input.nowMs,
      multiplier: input.contract.multiplier,
      minTick: input.contract.minTick,
      stopState: initial,
    },
    lastEvent: {
      type: "PAPER_ENTRY", reason: "SIMULATED_ASK_FILL_NO_LIVE_ORDER",
      contractId: input.contract.conId, price: input.quote.ask, stop: initial.confirmedStop,
    },
  };
}

export function onSPXPaperQuote(
  state: PaperSPXState,
  event: { nowMs: number; contractId: number; quote: PremiumQuote },
): PaperSPXState {
  const p = state.position;
  if (!p) return { ...state, lastEvent: { type: "PAPER_NO_CHANGE", reason: "NO_POSITION" } };
  if (event.contractId !== p.contractId) {
    return { ...state, lastEvent: { type: "PAPER_REJECT", reason: "WRONG_CONTRACT" } };
  }
  // Reject stale/invalid quote BEFORE even evaluating the paper exit.
  const quote = event.quote;
  if (!quote.connected || quote.marketDataType !== "LIVE" ||
      !Number.isFinite(quote.bid) || quote.bid <= 0 ||
      !Number.isFinite(quote.ask) || quote.ask < quote.bid ||
      !Number.isFinite(quote.timestampMs) || quote.timestampMs > event.nowMs ||
      event.nowMs - quote.timestampMs > 2000 ||
      (p.stopState.lastQuoteTimestampMs !== null &&
       quote.timestampMs <= p.stopState.lastQuoteTimestampMs)) {
    return { ...state, lastEvent: { type: "PAPER_REJECT", reason: "UNVERIFIED_OR_STALE_QUOTE" } };
  }
  if (quote.bid <= p.stopState.confirmedStop) {
    // PAPER model: simulated exit at available bid; gap-through losses possible.
    const pnlUsd = Number(((quote.bid - p.entryPremium) * p.multiplier).toFixed(2));
    return {
      ...state, position: null, closedTrades: state.closedTrades + 1,
      realizedPnLUsd: Number((state.realizedPnLUsd + pnlUsd).toFixed(2)),
      lastEvent: {
        type: "PAPER_EXIT", reason: "SIMULATED_STOP_BID_FILL_NOT_GUARANTEED",
        contractId: p.contractId, price: quote.bid, stop: p.stopState.confirmedStop,
        estimatedPnLUsd: pnlUsd,
      },
    };
  }
  const proposal = previewPremiumStop(p.stopState, quote, event.nowMs, { tickSize: p.minTick });
  if (proposal.proposedStop === null) {
    return { ...state, position: { ...p, stopState: proposal.nextState }, lastEvent: {
      type: "PAPER_NO_CHANGE", reason: proposal.reason, contractId: p.contractId,
    } };
  }
  // This is an explicitly *simulated* paper acknowledgement; it is never a live broker ACK.
  const paperAcknowledged = recordConfirmedPremiumStop(proposal.nextState, proposal.proposedStop, {
    tickSize: p.minTick,
  });
  return {
    ...state, position: { ...p, stopState: paperAcknowledged },
    lastEvent: {
      type: "PAPER_STOP_RAISED", reason: "SIMULATED_ACK_NO_BROKER_ORDER",
      contractId: p.contractId, stop: proposal.proposedStop,
    },
  };
}

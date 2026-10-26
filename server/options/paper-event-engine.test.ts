import { describe, expect, it } from "vitest";
import { EMPTY_PAPER_SPX_STATE, onSPXPaperSignal, onSPXPaperQuote } from "./paper-event-engine.js";

const T = 1793000000000;
const limits = {
  minConfidence: 75, maxQuoteAgeMs: 1000, maxSignalAgeMs: 1000,
  maxSpreadFractionOfAsk: 0.04, maxOpenPositions: 1, maxDayTrades: 3,
  maxDailyLossUsd: 50, maxPremiumOutlayUsd: 350, maxInitialLossUsd: 150,
  initialStopFraction: 0.55,
};
const base = () => ({
  nowMs: T,
  signal: {
    decision: "EXECUTE" as const, confidence: 90,
    timestampMs: T, right: "CALL" as const,
    confirmedTrend: true, confirmedLiquidity: true, newsClear: true,
    reasonCodes: ["TREND_UP", "VOLUME", "NEWS_CLEAR"],
  },
  quote: { bid: 2.95, ask: 3, timestampMs: T,
    connected: true, marketDataType: "LIVE" as const },
  contract: { conId: 785432, symbol: "SPX", expiryEpochMs: T + 3600000,
    multiplier: 100, minTick: 0.05, right: "CALL" as const },
  account: {
    brokerConnected: true, accountMatchesConfigured: true,
    availableFundsUsd: 500, buyingPowerUsd: 500,
    netLiquidationUsd: 500, dailyRealizedPnlUsd: 0,
    openPositionCount: 0, pendingEntryOrders: 0, dayTradesCount: 0,
    sessionOpenVerified: true, stopProtectionServiceReady: true,
  },
  limits,
});
function tick(bid: number, sequence: number, marketDataType: "LIVE" | "DELAYED" = "LIVE") {
  return {
    nowMs: T + sequence * 100,
    contractId: 785432,
    quote: { bid, ask: Number((bid + 0.05).toFixed(2)),
      timestampMs: T + sequence * 100,
      connected: true, marketDataType },
  };
}
describe("SPX paper-only event-driven lifecycle", () => {
  it("rejects entry when real account is unfunded", () => {
    const input = base();
    input.account.availableFundsUsd = 11.51;
    input.account.buyingPowerUsd = 11.51;
    const state = onSPXPaperSignal(EMPTY_PAPER_SPX_STATE, input);
    expect(state.position).toBeNull();
    expect(state.lastEvent?.reason).toContain("INSUFFICIENT_PURCHASING_POWER");
  });
  it("simulates entry, raises stops on quote events, exits at gap-through bid", () => {
    let state = onSPXPaperSignal(EMPTY_PAPER_SPX_STATE, base());
    expect(state.lastEvent?.type).toBe("PAPER_ENTRY");
    expect(state.position?.stopState.confirmedStop).toBe(1.65);
    for (const [i, price, stop] of [[1, 3.5, 3.2], [2, 4, 3.5], [3, 4.05, 4]] as const) {
      state = onSPXPaperQuote(state, tick(price, i));
      expect(state.lastEvent?.type).toBe("PAPER_STOP_RAISED");
      expect(state.position?.stopState.confirmedStop).toBe(stop);
    }
    state = onSPXPaperQuote(state, tick(3.90, 4));
    expect(state.lastEvent?.type).toBe("PAPER_EXIT");
    expect(state.lastEvent?.price).toBe(3.9);
    expect(state.position).toBeNull();
    expect(state.realizedPnLUsd).toBe(90);
  });
  it("does not exit on stale or delayed quote", () => {
    let state = onSPXPaperSignal(EMPTY_PAPER_SPX_STATE, base());
    state = onSPXPaperQuote(state, tick(1.5, 1, "DELAYED"));
    expect(state.lastEvent?.type).toBe("PAPER_REJECT");
    expect(state.position).not.toBeNull();
    state = onSPXPaperQuote(state, {
      ...tick(1.5, 2), nowMs: T + 10000,
    });
    expect(state.lastEvent?.type).toBe("PAPER_REJECT");
    expect(state.position).not.toBeNull();
  });
  it("blocks duplicated position, wrong contract, and out-of-order price", () => {
    let state = onSPXPaperSignal(EMPTY_PAPER_SPX_STATE, base());
    state = onSPXPaperSignal(state, base());
    expect(state.lastEvent?.reason).toBe("ONE_POSITION_ALREADY_OPEN");
    state = onSPXPaperQuote(state, { ...tick(3.5, 1), contractId: 999 });
    expect(state.lastEvent?.reason).toBe("WRONG_CONTRACT");
    state = onSPXPaperQuote(state, tick(3.5, 1));
    state = onSPXPaperQuote(state, tick(3.6, 1));
    expect(state.lastEvent?.reason).toBe("UNVERIFIED_OR_STALE_QUOTE");
  });
  it("no actual IBKR order path, only paper state and events", () => {
    const state = onSPXPaperSignal(EMPTY_PAPER_SPX_STATE, base());
    expect(state.lastEvent?.reason).toContain("NO_LIVE_ORDER");
    expect("orderId" in state).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { previewAutonomousSPXEntry } from "./autonomous-entry-guard.js";

const NOW = 1793000000000;
function makeInput(overrides: Record<string, any> = {}) {
  return {
    nowMs: NOW,
    signal: {
      decision: "EXECUTE" as const,
      confidence: 85,
      timestampMs: NOW - 50,
      right: "CALL" as const,
      confirmedTrend: true,
      confirmedLiquidity: true,
      newsClear: true,
      reasonCodes: ["TREND", "LIQUIDITY", "NEWS_CLEAR"],
    },
    quote: {
      bid: 2.95,
      ask: 3,
      timestampMs: NOW - 50,
      marketDataType: "LIVE" as const,
      connected: true,
    },
    contract: {
      conId: 123456,
      symbol: "SPX",
      expiryEpochMs: NOW + 3600000,
      multiplier: 100,
      minTick: 0.05,
      right: "CALL" as const,
    },
    account: {
      brokerConnected: true,
      accountMatchesConfigured: true,
      availableFundsUsd: 500,
      buyingPowerUsd: 500,
      netLiquidationUsd: 500,
      dailyRealizedPnlUsd: 0,
      openPositionCount: 0,
      pendingEntryOrders: 0,
      dayTradesCount: 0,
      sessionOpenVerified: true,
      stopProtectionServiceReady: true,
    },
    limits: {
      minConfidence: 75,
      maxQuoteAgeMs: 1000,
      maxSignalAgeMs: 1000,
      maxSpreadFractionOfAsk: 0.04,
      maxOpenPositions: 1,
      maxDayTrades: 3,
      maxDailyLossUsd: 50,
      maxPremiumOutlayUsd: 350,
      maxInitialLossUsd: 150,
      initialStopFraction: 0.55,
    },
    ...overrides,
  };
}
describe("autonomous SPX candidate preflight (never executes)", () => {
  it("allows a fully checked paper candidate, not live trade", () => {
    const d = previewAutonomousSPXEntry(makeInput());
    expect(d.action).toBe("PAPER_ENTRY_CANDIDATE");
    expect(d.estimatedDebitUsd).toBe(300);
    expect(d.estimatedRiskUsd).toBe(135);
  });
  it("blocks $11.51 account for $3 option premium", () => {
    const inp = makeInput();
    inp.account.availableFundsUsd = 11.51;
    inp.account.buyingPowerUsd = 11.51;
    const d = previewAutonomousSPXEntry(inp);
    expect(d.action).toBe("BLOCK");
    expect(d.reasons).toContain("INSUFFICIENT_PURCHASING_POWER_OR_BUDGET");
  });
  it("blocks delayed quotes even if apparent signal is strong", () => {
    const inp = makeInput();
    const delayed = { ...inp, quote: { ...inp.quote, marketDataType: "DELAYED" as const } };
    const d = previewAutonomousSPXEntry(delayed);
    expect(d.reasons).toContain("OPTION_QUOTE_NOT_FRESH_LIVE");
  });
  it("blocks stale quote and stale signal", () => {
    const inp = makeInput();
    inp.quote.timestampMs = NOW - 2500;
    inp.signal.timestampMs = NOW - 3000;
    const d = previewAutonomousSPXEntry(inp);
    expect(d.reasons).toContain("OPTION_QUOTE_NOT_FRESH_LIVE");
    expect(d.reasons).toContain("SIGNAL_STALE");
  });
  it("blocks absent stop order readiness", () => {
    const inp = makeInput();
    inp.account.stopProtectionServiceReady = false;
    expect(previewAutonomousSPXEntry(inp).reasons).toContain("BROKER_SIDE_STOP_NOT_READY");
  });
  it("blocks conflicting existing positions and pending entries", () => {
    const inp = makeInput();
    inp.account.openPositionCount = 1;
    inp.account.pendingEntryOrders = 1;
    expect(previewAutonomousSPXEntry(inp).reasons).toContain("ALREADY_EXPOSED_OR_PENDING_ENTRY");
  });
  it("blocks wrong contract or right", () => {
    const inp = makeInput();
    inp.contract.symbol = "SPY";
    const wrongRight = { ...inp, signal: { ...inp.signal, right: "PUT" as const } };
    const d = previewAutonomousSPXEntry(wrongRight);
    expect(d.reasons).toContain("CONTRACT_NOT_QUALIFIED");
    expect(d.reasons).toContain("SIGNAL_CONTRACT_DIRECTION_MISMATCH");
  });
  it("blocks high spreads", () => {
    const inp = makeInput();
    inp.quote.bid = 2.5;
    expect(previewAutonomousSPXEntry(inp).reasons).toContain("SPREAD_TOO_WIDE");
  });
  it("blocks missing news confirmation", () => {
    const inp = makeInput();
    inp.signal.newsClear = false;
    expect(previewAutonomousSPXEntry(inp).reasons).toContain("SIGNAL_CONFIRMATION_MISSING");
  });
  it("blocks invalid account and risk limits", () => {
    const inp = makeInput();
    inp.account.netLiquidationUsd = NaN;
    inp.limits.maxQuoteAgeMs = 10000;
    const d = previewAutonomousSPXEntry(inp);
    expect(d.reasons).toContain("ACCOUNT_SNAPSHOT_INVALID");
    expect(d.reasons).toContain("RISK_LIMITS_NOT_APPROVED");
  });
  it("blocks unverified session and broker account", () => {
    const inp = makeInput();
    inp.account.sessionOpenVerified = false;
    inp.account.accountMatchesConfigured = false;
    const d = previewAutonomousSPXEntry(inp);
    expect(d.reasons).toContain("SESSION_NOT_VERIFIED");
    expect(d.reasons).toContain("BROKER_ACCOUNT_NOT_VERIFIED");
  });
});

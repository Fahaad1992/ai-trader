/**
 * Unit Tests: Dollar-Based Trailing Stop on Option Premium
 * Tests getTrailingConfig + updateTrailingStop logic extracted from engine
 */
import { describe, it, expect } from "vitest";
import { getTrailingConfig } from "./engine.js";
import type { Trade, TrailingConfig } from "../../shared/types.js";

// Helper: create a mock trade for testing
function makeTrade(entryPremium: number, overrides?: Partial<Trade>): Trade {
  const tConfig = getTrailingConfig(entryPremium);
  return {
    id: "test-001",
    mode: "paper",
    strategy: "milking",
    underlying: "SPY",
    symbol: "SPY 2026-04-02 $560C",
    contractType: "call",
    strike: 560,
    expiry: "2026-04-02",
    entryPremium,
    currentPremium: entryPremium,
    quantity: 1,
    delta: 0.50,
    pnl: 0,
    pnlPercent: 0,
    peakPrice: entryPremium,
    trailingActive: false,
    trailingStopPrice: 0,
    trailingConfig: tConfig,
    openedAt: Date.now(),
    status: "open",
    dataSource: "real-data-paper",
    ...overrides,
  };
}

// Simulate the updateTrailingStop logic from engine (extracted for testing)
function updateTrailingStop(trade: Trade, currentPremium: number) {
  const { activation, distance } = trade.trailingConfig;

  // Update peak
  if (currentPremium > trade.peakPrice) {
    trade.peakPrice = currentPremium;
  }

  // Check activation
  if (!trade.trailingActive && currentPremium >= trade.entryPremium + activation) {
    trade.trailingActive = true;
    trade.trailingStopPrice = trade.entryPremium; // breakeven
  }

  // Move stop up only
  if (trade.trailingActive) {
    const newStop = Math.round((trade.peakPrice - distance) * 100) / 100;
    if (newStop > trade.trailingStopPrice) {
      trade.trailingStopPrice = newStop;
    }
  }

  // Update PnL
  trade.currentPremium = currentPremium;
  trade.pnl = Math.round((currentPremium - trade.entryPremium) * trade.quantity * 100 * 100) / 100;
  trade.pnlPercent = Math.round(((currentPremium - trade.entryPremium) / trade.entryPremium) * 10000) / 100;
}

// Check if trade should be closed
function shouldClose(trade: Trade): "trailing-stop" | "stop-loss" | null {
  const INITIAL_SL = 0.30;
  if (trade.trailingActive && trade.currentPremium <= trade.trailingStopPrice) {
    return "trailing-stop";
  }
  if (!trade.trailingActive) {
    const lossPct = (trade.entryPremium - trade.currentPremium) / trade.entryPremium;
    if (lossPct >= INITIAL_SL) return "stop-loss";
  }
  return null;
}

// ========== TESTS ==========

describe("getTrailingConfig", () => {
  it("1. cheap option (<$2): activation=$0.10, distance=$0.10", () => {
    const cfg = getTrailingConfig(1.50);
    expect(cfg.activation).toBe(0.10);
    expect(cfg.distance).toBe(0.10);
  });

  it("2. mid-range option ($2-$4): activation=$0.15, distance=$0.15", () => {
    const cfg = getTrailingConfig(3.00);
    expect(cfg.activation).toBe(0.15);
    expect(cfg.distance).toBe(0.15);
  });

  it("3. expensive option ($4+): activation=$0.20, distance=$0.20", () => {
    const cfg = getTrailingConfig(5.00);
    expect(cfg.activation).toBe(0.20);
    expect(cfg.distance).toBe(0.20);
  });

  it("4. boundary: $2.00 exactly = mid-range", () => {
    const cfg = getTrailingConfig(2.00);
    expect(cfg.activation).toBe(0.15);
    expect(cfg.distance).toBe(0.15);
  });

  it("5. boundary: $4.00 exactly = expensive", () => {
    const cfg = getTrailingConfig(4.00);
    expect(cfg.activation).toBe(0.20);
    expect(cfg.distance).toBe(0.20);
  });
});

describe("Trailing Stop Activation", () => {
  it("6. trailing NOT active before reaching activation threshold", () => {
    const t = makeTrade(3.00); // mid-range: activation=$0.15
    updateTrailingStop(t, 3.10); // +$0.10 < $0.15
    expect(t.trailingActive).toBe(false);
    expect(t.trailingStopPrice).toBe(0);
  });

  it("7. trailing activates at entry + activation, stop = breakeven", () => {
    const t = makeTrade(3.00); // activation=$0.15
    updateTrailingStop(t, 3.15); // exactly +$0.15
    expect(t.trailingActive).toBe(true);
    expect(t.trailingStopPrice).toBe(3.00); // breakeven = entry
  });

  it("8. trailing activates above threshold, stop = breakeven", () => {
    const t = makeTrade(3.00);
    updateTrailingStop(t, 3.50); // +$0.50 > $0.15
    expect(t.trailingActive).toBe(true);
    expect(t.trailingStopPrice).toBe(3.35); // peak(3.50) - distance(0.15) = 3.35
    // But since 3.35 > 3.00 (breakeven), stop moved up
  });
});

describe("Trailing Stop Movement", () => {
  it("9. stop moves UP as peak rises, never moves DOWN", () => {
    const t = makeTrade(1.50); // cheap: activation=$0.10, distance=$0.10

    // Price rises to activate
    updateTrailingStop(t, 1.60); // +$0.10 = activation
    expect(t.trailingActive).toBe(true);
    expect(t.trailingStopPrice).toBe(1.50); // breakeven initially

    // Price rises more - stop should move up
    updateTrailingStop(t, 1.80); // peak=1.80, stop=1.80-0.10=1.70
    expect(t.peakPrice).toBe(1.80);
    expect(t.trailingStopPrice).toBe(1.70);

    // Price drops - stop should NOT move down
    updateTrailingStop(t, 1.65);
    expect(t.peakPrice).toBe(1.80); // peak stays
    expect(t.trailingStopPrice).toBe(1.70); // stop stays

    // Price rises to new peak
    updateTrailingStop(t, 2.00);
    expect(t.peakPrice).toBe(2.00);
    expect(t.trailingStopPrice).toBe(1.90); // 2.00 - 0.10
  });
});

describe("Exit Decisions", () => {
  it("10. trailing stop triggers when price drops to stop level", () => {
    const t = makeTrade(1.50); // cheap: activation=$0.10, distance=$0.10

    updateTrailingStop(t, 1.80); // activate + peak
    expect(t.trailingActive).toBe(true);
    expect(t.trailingStopPrice).toBe(1.70);

    // Price drops to stop
    updateTrailingStop(t, 1.70);
    const result = shouldClose(t);
    expect(result).toBe("trailing-stop");
  });

  it("11. trailing stop triggers when price drops BELOW stop level", () => {
    const t = makeTrade(3.00); // mid: activation=$0.15, distance=$0.15

    updateTrailingStop(t, 3.50); // activate + peak
    expect(t.trailingStopPrice).toBe(3.35); // 3.50 - 0.15

    // Price gaps down below stop
    updateTrailingStop(t, 3.20);
    const result = shouldClose(t);
    expect(result).toBe("trailing-stop");
  });

  it("12. initial SL triggers at -30% BEFORE trailing activates", () => {
    const t = makeTrade(3.00); // not activated yet

    updateTrailingStop(t, 2.10); // -30% exactly
    expect(t.trailingActive).toBe(false);
    const result = shouldClose(t);
    expect(result).toBe("stop-loss");
  });

  it("13. no exit when price is between entry and stop (before activation)", () => {
    const t = makeTrade(3.00);

    updateTrailingStop(t, 2.50); // -16.7%, not -30%
    expect(t.trailingActive).toBe(false);
    const result = shouldClose(t);
    expect(result).toBeNull();
  });

  it("14. no exit when trailing active but price above stop", () => {
    const t = makeTrade(5.00); // expensive: activation=$0.20, distance=$0.20

    updateTrailingStop(t, 5.50); // activate
    expect(t.trailingActive).toBe(true);
    expect(t.trailingStopPrice).toBe(5.30); // 5.50 - 0.20

    updateTrailingStop(t, 5.35); // above 5.30
    const result = shouldClose(t);
    expect(result).toBeNull();
  });
});

describe("Full Trade Lifecycle (Option Premium Only)", () => {
  it("15. complete trade: entry $3.00 → peak $3.80 → exit $3.55 (profit)", () => {
    const t = makeTrade(3.00); // mid: activation=$0.15, distance=$0.15

    // Price rises gradually
    updateTrailingStop(t, 3.10); // not activated yet
    expect(t.trailingActive).toBe(false);

    updateTrailingStop(t, 3.15); // activated! stop=breakeven=$3.00
    expect(t.trailingActive).toBe(true);
    expect(t.trailingStopPrice).toBe(3.00);

    updateTrailingStop(t, 3.40); // stop=3.40-0.15=3.25
    expect(t.trailingStopPrice).toBe(3.25);

    updateTrailingStop(t, 3.80); // new peak, stop=3.80-0.15=3.65
    expect(t.peakPrice).toBe(3.80);
    expect(t.trailingStopPrice).toBe(3.65);

    // Price drops
    updateTrailingStop(t, 3.70); // above 3.65, no exit
    expect(shouldClose(t)).toBeNull();

    updateTrailingStop(t, 3.65); // exactly at stop
    expect(shouldClose(t)).toBe("trailing-stop");

    // Verify PnL is from OPTION PREMIUM only
    expect(t.pnl).toBe(65.00); // ($3.65 - $3.00) * 1 * 100 = $65
    expect(t.pnlPercent).toBeCloseTo(21.67, 1);
  });

  it("16. complete trade: entry $1.00 → never activates → SL at $0.70", () => {
    const t = makeTrade(1.00); // cheap: activation=$0.10, distance=$0.10

    updateTrailingStop(t, 1.05); // small rise, not enough
    expect(t.trailingActive).toBe(false);

    updateTrailingStop(t, 0.90); // dropping
    updateTrailingStop(t, 0.75); // -25%, not -30% yet
    expect(shouldClose(t)).toBeNull();

    updateTrailingStop(t, 0.70); // -30% exactly
    expect(shouldClose(t)).toBe("stop-loss");
    expect(t.pnl).toBe(-30.00); // ($0.70 - $1.00) * 1 * 100 = -$30
  });

  it("17. PnL uses option premium, NOT underlying stock price", () => {
    const t = makeTrade(2.50); // mid: activation=$0.15, distance=$0.15

    // Simulate: underlying SPY goes from $560 to $570 (+1.8%)
    // But option premium goes from $2.50 to $3.20 (+28%)
    updateTrailingStop(t, 3.20);

    // PnL should be based on premium difference, not stock
    expect(t.pnl).toBe(70.00); // ($3.20 - $2.50) * 1 * 100 = $70
    expect(t.pnlPercent).toBe(28.00); // 28% on premium
    // NOT 1.8% from stock
  });
});

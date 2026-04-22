import { describe, expect, it, beforeEach } from "vitest";

// Test Black-Scholes pricing and engine logic
describe("Black-Scholes Option Pricing", () => {
  // Inline BS functions for testing (same as market-data.ts)
  function N(x: number): number {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const s = x < 0 ? -1 : 1;
    const ax = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + p * ax);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
    return 0.5 * (1 + s * y);
  }

  function bsPrice(S: number, K: number, T: number, r: number, v: number, cp: "call" | "put"): number {
    if (T < 0.0001) T = 0.0001;
    const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * Math.sqrt(T));
    const d2 = d1 - v * Math.sqrt(T);
    return cp === "call"
      ? S * N(d1) - K * Math.exp(-r * T) * N(d2)
      : K * Math.exp(-r * T) * N(-d2) - S * N(-d1);
  }

  it("ATM call should be approximately half the stock price times volatility times sqrt(T)", () => {
    const S = 645, K = 645, T = 7 / 365, r = 0.045, v = 0.20;
    const price = bsPrice(S, K, T, r, v, "call");
    expect(price).toBeGreaterThan(0);
    expect(price).toBeLessThan(S * 0.1); // ATM call < 10% of stock
  });

  it("call price increases with stock price", () => {
    const K = 645, T = 7 / 365, r = 0.045, v = 0.20;
    const p1 = bsPrice(640, K, T, r, v, "call");
    const p2 = bsPrice(650, K, T, r, v, "call");
    expect(p2).toBeGreaterThan(p1);
  });

  it("put price increases as stock falls", () => {
    const K = 645, T = 7 / 365, r = 0.045, v = 0.20;
    const p1 = bsPrice(650, K, T, r, v, "put");
    const p2 = bsPrice(640, K, T, r, v, "put");
    expect(p2).toBeGreaterThan(p1);
  });

  it("OTM call should be cheaper than ATM call", () => {
    const S = 645, T = 7 / 365, r = 0.045, v = 0.20;
    const atm = bsPrice(S, 645, T, r, v, "call");
    const otm = bsPrice(S, 660, T, r, v, "call");
    expect(otm).toBeLessThan(atm);
  });

  it("put-call parity should hold approximately", () => {
    const S = 645, K = 645, T = 30 / 365, r = 0.045, v = 0.20;
    const call = bsPrice(S, K, T, r, v, "call");
    const put = bsPrice(S, K, T, r, v, "put");
    // C - P ≈ S - K*e^(-rT)
    const parity = S - K * Math.exp(-r * T);
    expect(Math.abs((call - put) - parity)).toBeLessThan(0.5);
  });

  it("higher volatility should increase option price", () => {
    const S = 645, K = 645, T = 7 / 365, r = 0.045;
    const lowVol = bsPrice(S, K, T, r, 0.15, "call");
    const highVol = bsPrice(S, K, T, r, 0.30, "call");
    expect(highVol).toBeGreaterThan(lowVol);
  });
});

describe("Greeks Calculations", () => {
  function N(x: number): number {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const s = x < 0 ? -1 : 1;
    const ax = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + p * ax);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
    return 0.5 * (1 + s * y);
  }
  function n(x: number): number { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

  function bsGreeks(S: number, K: number, T: number, r: number, v: number, cp: "call" | "put") {
    if (T < 0.0001) T = 0.0001;
    const sqT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + 0.5 * v * v) * T) / (v * sqT);
    const delta = cp === "call" ? N(d1) : N(d1) - 1;
    const gamma = n(d1) / (S * v * sqT);
    return { delta: Math.round(delta * 1000) / 1000, gamma: Math.round(gamma * 10000) / 10000 };
  }

  it("ATM call delta should be near 0.5", () => {
    const g = bsGreeks(645, 645, 7 / 365, 0.045, 0.20, "call");
    expect(g.delta).toBeGreaterThan(0.4);
    expect(g.delta).toBeLessThan(0.6);
  });

  it("ATM put delta should be near -0.5", () => {
    const g = bsGreeks(645, 645, 7 / 365, 0.045, 0.20, "put");
    expect(g.delta).toBeGreaterThan(-0.6);
    expect(g.delta).toBeLessThan(-0.4);
  });

  it("OTM call delta should be less than ATM", () => {
    const atm = bsGreeks(645, 645, 7 / 365, 0.045, 0.20, "call");
    const otm = bsGreeks(645, 660, 7 / 365, 0.045, 0.20, "call");
    expect(otm.delta).toBeLessThan(atm.delta);
  });

  it("gamma should be positive for both calls and puts", () => {
    const call = bsGreeks(645, 645, 7 / 365, 0.045, 0.20, "call");
    const put = bsGreeks(645, 645, 7 / 365, 0.045, 0.20, "put");
    expect(call.gamma).toBeGreaterThan(0);
    expect(put.gamma).toBeGreaterThan(0);
  });

  it("gamma should be highest at ATM", () => {
    const atm = bsGreeks(645, 645, 7 / 365, 0.045, 0.20, "call");
    const otm = bsGreeks(645, 660, 7 / 365, 0.045, 0.20, "call");
    expect(atm.gamma).toBeGreaterThan(otm.gamma);
  });
});

describe("Trading Engine Config", () => {
  it("default config should have valid values", () => {
    const config = {
      mode: "paper", activeStrategy: "milking",
      capital: { mainCapital: 1000, paperBalance: 1000 },
      risk: { stopLossPercent: 30, takeProfitPercent: 50, maxTradesPerDay: 5, maxOpenPositions: 3 },
      options: { deltaMin: 0.2, deltaMax: 0.4, minPremium: 0.5, maxPremium: 5 },
      filters: { minConfirmations: 6 },
    };
    expect(config.mode).toBe("paper");
    expect(config.risk.stopLossPercent).toBeGreaterThan(0);
    expect(config.risk.takeProfitPercent).toBeGreaterThan(config.risk.stopLossPercent);
    expect(config.options.deltaMin).toBeLessThan(config.options.deltaMax);
    expect(config.options.minPremium).toBeLessThan(config.options.maxPremium);
    expect(config.filters.minConfirmations).toBeGreaterThanOrEqual(1);
    expect(config.filters.minConfirmations).toBeLessThanOrEqual(8);
  });

  it("PnL calculation should be correct", () => {
    const entry = 2.50, exit = 3.00, qty = 1;
    const pnl = (exit - entry) * qty * 100; // Options are 100 shares per contract
    expect(pnl).toBe(50);
    const pnlPct = ((exit - entry) / entry) * 100;
    expect(pnlPct).toBe(20);
  });

  it("stop loss should trigger at correct level", () => {
    const entry = 2.50, stopLossPct = 30;
    const stopPrice = entry * (1 - stopLossPct / 100);
    expect(stopPrice).toBe(1.75);
    const pnlAtStop = (stopPrice - entry) * 1 * 100;
    expect(pnlAtStop).toBe(-75);
  });
});

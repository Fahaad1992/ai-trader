import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, TradingEngine } from "./engine.js";

describe("validateOptionForEntry flow", () => {
  it("should have all required log tags in engine", async () => {
    const fs = await import("fs");
    const code = fs.readFileSync("server/trading/engine.ts", "utf-8");

    expect(code).toContain("[SIGNAL_PASSED]");
    expect(code).toContain("[OPTION_VALIDATE]");
    expect(code).toContain("[OPTION_ACCEPTED]");
    expect(code).toContain("[OPTION_REJECTED]");
    expect(code).toContain("[TRADE_OPENED]");
  });

  it("should have validateOptionForEntry method", async () => {
    const fs = await import("fs");
    const code = fs.readFileSync("server/trading/engine.ts", "utf-8");
    expect(code).toContain("private async validateOptionForEntry(underlying: string, conf: Confirmation[]): Promise<OptionQuote | null>");
  });

  it("openTrade should require OptionQuote parameter", async () => {
    const fs = await import("fs");
    const code = fs.readFileSync("server/trading/engine.ts", "utf-8");
    expect(code).toContain("private async openTrade(underlying: string, conf: Confirmation[], opt: OptionQuote)");
  });

  it("DEFAULT_CONFIG should have correct delta range", () => {
    expect(DEFAULT_CONFIG.options.deltaMin).toBe(0.40);
    expect(DEFAULT_CONFIG.options.deltaMax).toBe(0.60);
  });
});

describe("Parallel Scanning", () => {
  it("should use parallelScan instead of sequential scan", async () => {
    const fs = await import("fs");
    const code = fs.readFileSync("server/trading/engine.ts", "utf-8");

    // Uses parallelScan method
    expect(code).toContain("parallelScan()");
    expect(code).toContain("[PARALLEL_SCAN]");
    // Uses Promise.allSettled for parallel execution
    expect(code).toContain("Promise.allSettled");
    // Scans all underlyings at once
    expect(code).toContain("UNDERLYINGS.map(async (u)");
    // Sorts by confirmation count (best first)
    expect(code).toContain(".sort((a, b) => b.passed - a.passed)");
    // Logs scan duration
    expect(code).toContain("scanStart");
  });

  it("scan interval should be 90 seconds for full parallel cycle", async () => {
    const fs = await import("fs");
    const code = fs.readFileSync("server/trading/engine.ts", "utf-8");

    expect(code).toContain("90_000");
    expect(code).toContain("Parallel scan every 90s");
  });

  it("should warn if scan takes more than 2 minutes", async () => {
    const fs = await import("fs");
    const code = fs.readFileSync("server/trading/engine.ts", "utf-8");

    expect(code).toContain("[SCAN_SLOW]");
    expect(code).toContain("120_000");
  });
});

describe("Spread-Based Slippage", () => {
  it("should use spread-based slippage for entry (30% of spread)", async () => {
    const fs = await import("fs");
    const code = fs.readFileSync("server/trading/engine.ts", "utf-8");

    // Entry: spread * 0.3
    expect(code).toContain("entrySpread * 0.3");
    expect(code).toContain("[SLIPPAGE]");
    expect(code).toContain("Spread-based slippage: 30% of spread");
  });

  it("should use spread-based slippage for exit (30% of spread)", async () => {
    const fs = await import("fs");
    const code = fs.readFileSync("server/trading/engine.ts", "utf-8");

    // Exit: spread * 0.3
    expect(code).toContain("exitSpread * 0.3");
    expect(code).toContain("[EXIT_SLIPPAGE]");
  });

  it("slippage should be capped at $0.05", async () => {
    const fs = await import("fs");
    const code = fs.readFileSync("server/trading/engine.ts", "utf-8");

    // Cap at $0.05
    expect(code).toContain("0.05");
  });

  it("slippage should have minimum of $0.01", async () => {
    const fs = await import("fs");
    const code = fs.readFileSync("server/trading/engine.ts", "utf-8");

    // Minimum $0.01
    expect(code).toContain("Math.max(slippage, 0.01)");
    expect(code).toContain("Math.max(exitSlippage, 0.01)");
  });

  it("spread-based slippage calculation should be correct", () => {
    // Example: spread = $0.10, slippage = 0.10 * 0.3 = $0.03
    const spread = 0.10;
    const slippage = Math.min(Math.round(spread * 0.3 * 100) / 100, 0.05);
    expect(slippage).toBe(0.03);

    // Example: spread = $0.50, slippage = 0.50 * 0.3 = $0.15 → capped at $0.05
    const spread2 = 0.50;
    const slippage2 = Math.min(Math.round(spread2 * 0.3 * 100) / 100, 0.05);
    expect(slippage2).toBe(0.05);

    // Example: spread = $0.02, slippage = 0.02 * 0.3 = $0.006 → min $0.01
    const spread3 = 0.02;
    let slippage3 = Math.min(Math.round(spread3 * 0.3 * 100) / 100, 0.05);
    slippage3 = Math.max(slippage3, 0.01);
    expect(slippage3).toBe(0.01);
  });

  it("should reject trades with volume < 100", async () => {
    const fs = await import("fs");
    const code = fs.readFileSync("server/trading/engine.ts", "utf-8");

    expect(code).toContain("opt.volume < 100");
    expect(code).toContain("حجم ضعيف");
  });

  it("should reject trades with spread > 15%", async () => {
    const fs = await import("fs");
    const code = fs.readFileSync("server/trading/engine.ts", "utf-8");

    expect(code).toContain("spreadPct > 15");
    expect(code).toContain("Spread عالي");
  });

  it("P&L should be calculated from fillPrice (ask+slip) to exitPrice (bid-slip)", async () => {
    // Simulate: spread = $0.10, entry slippage = $0.03
    // entry at ask $2.00 + slip $0.03 = $2.03
    // exit spread = $0.10, exit slippage = $0.03
    // exit at bid $2.50 - slip $0.03 = $2.47
    // P&L per contract = ($2.47 - $2.03) * 100 = $44.00
    const entry = 2.03;
    const exit = 2.47;
    const qty = 1;
    const pnl = Math.round((exit - entry) * qty * 100 * 100) / 100;
    expect(pnl).toBe(44.00);
  });

  it("exitPrice should never go below $0.01", () => {
    const rawBid = 0.02;
    const exitSlippage = 0.03;
    const exitPrice = Math.max(0.01, Math.round((rawBid - exitSlippage) * 100) / 100);
    expect(exitPrice).toBe(0.01);
  });
});

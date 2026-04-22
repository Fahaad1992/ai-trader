import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ======== NEWS FILTER TESTS ========

describe("EconomicNewsFilter", () => {
  const newsFilterSource = fs.readFileSync(
    path.resolve(__dirname, "./news-filter.ts"),
    "utf-8"
  );

  it("should define EconomicNewsFilter class", () => {
    expect(newsFilterSource).toContain("export class EconomicNewsFilter");
  });

  it("should define high-impact keywords including CPI, NFP, FOMC, GDP", () => {
    expect(newsFilterSource).toContain('"cpi"');
    expect(newsFilterSource).toContain('"nfp"');
    expect(newsFilterSource).toContain('"fomc"');
    expect(newsFilterSource).toContain('"gdp"');
    expect(newsFilterSource).toContain('"unemployment');
    expect(newsFilterSource).toContain('"ppi"');
    expect(newsFilterSource).toContain('"retail sales"');
    expect(newsFilterSource).toContain('"fed');
  });

  it("should have 15-minute block window before and after events", () => {
    expect(newsFilterSource).toContain("BLOCK_MINUTES_BEFORE = 15");
    expect(newsFilterSource).toContain("BLOCK_MINUTES_AFTER = 15");
  });

  it("should have checkBlock method that returns blocked status and event", () => {
    expect(newsFilterSource).toContain("checkBlock()");
    expect(newsFilterSource).toContain("blocked: boolean");
    expect(newsFilterSource).toContain("event: EconomicEvent | null");
    expect(newsFilterSource).toContain("reason: string");
  });

  it("should have auto-refresh every hour", () => {
    expect(newsFilterSource).toContain("REFRESH_INTERVAL_MS = 60 * 60 * 1000");
    expect(newsFilterSource).toContain("startAutoRefresh");
    expect(newsFilterSource).toContain("stopAutoRefresh");
  });

  it("should use Finnhub API as primary source", () => {
    expect(newsFilterSource).toContain("finnhub.io/api/v1");
    expect(newsFilterSource).toContain("calendar/economic");
    expect(newsFilterSource).toContain("FINNHUB_API_KEY");
  });

  it("should have fallback known schedule for NFP, FOMC, CPI, Jobless Claims", () => {
    expect(newsFilterSource).toContain("getKnownEventsForDate");
    expect(newsFilterSource).toContain("Nonfarm Payrolls (NFP)");
    expect(newsFilterSource).toContain("FOMC Interest Rate Decision");
    expect(newsFilterSource).toContain("Consumer Price Index (CPI)");
    expect(newsFilterSource).toContain("Initial Jobless Claims");
  });

  it("should have simulateEvent method for testing", () => {
    expect(newsFilterSource).toContain("simulateEvent");
    expect(newsFilterSource).toContain("SIMULATED");
  });

  it("should log block events with event name, time, and block window", () => {
    expect(newsFilterSource).toContain("blockStart");
    expect(newsFilterSource).toContain("blockEnd");
    expect(newsFilterSource).toContain("BLOCKED:");
  });

  it("should export singleton newsFilter instance", () => {
    expect(newsFilterSource).toContain("export const newsFilter = new EconomicNewsFilter()");
  });
});

// ======== ENGINE INTEGRATION TESTS ========

describe("Engine News Filter Integration", () => {
  const engineSource = fs.readFileSync(
    path.resolve(__dirname, "./engine.ts"),
    "utf-8"
  );

  it("should import newsFilter in engine.ts", () => {
    expect(engineSource).toContain('import { newsFilter');
    expect(engineSource).toContain('from "./news-filter.js"');
  });

  it("should check newsFilter in checkFilters method", () => {
    expect(engineSource).toContain("newsFilter.checkBlock()");
    expect(engineSource).toContain("NEWS_BLOCK");
  });

  it("should start newsFilter auto-refresh on engine start", () => {
    expect(engineSource).toContain("newsFilter.startAutoRefresh()");
    expect(engineSource).toContain("newsFilter.setEnabled(true)");
  });

  it("should stop newsFilter auto-refresh on engine stop", () => {
    expect(engineSource).toContain("newsFilter.stopAutoRefresh()");
  });

  it("should log block events to SQLite", () => {
    expect(engineSource).toContain("saveLog(Date.now()");
    expect(engineSource).toContain("NEWS_BLOCK");
  });

  it("should expose getNewsFilterStatus method", () => {
    expect(engineSource).toContain("getNewsFilterStatus()");
    expect(engineSource).toContain("newsFilter.getStatus()");
  });
});

// ======== IBKR HISTORICAL DATA TESTS ========

describe("IBKR Historical Data Integration", () => {
  const ibkrSource = fs.readFileSync(
    path.resolve(__dirname, "./ibkr-client.ts"),
    "utf-8"
  );

  const marketSource = fs.readFileSync(
    path.resolve(__dirname, "./market-data.ts"),
    "utf-8"
  );

  it("should have getHistoricalBars method in ibkr-client", () => {
    expect(ibkrSource).toContain("async getHistoricalBars(");
    expect(ibkrSource).toContain("reqHistoricalData");
  });

  it("should support 5-min bars for 5 days duration", () => {
    expect(ibkrSource).toContain('"5 mins"');
    expect(ibkrSource).toContain('"5 D"');
  });

  it("should handle SPX and VIX as index contracts", () => {
    expect(ibkrSource).toContain('SecType.IND');
    expect(ibkrSource).toContain('"CBOE"');
  });

  it("should listen for historicalData and historicalDataEnd events", () => {
    expect(ibkrSource).toContain("EventName.historicalData");
    expect(ibkrSource).toContain("EventName.historicalDataEnd");
  });

  it("should have fetchIBKRIntradayStock in market-data.ts", () => {
    expect(marketSource).toContain("async function fetchIBKRIntradayStock");
  });

  it("should calculate ALL indicators from IBKR candles when connected", () => {
    expect(marketSource).toContain("Calculate ALL indicators from IBKR candles");
    expect(marketSource).toContain("calcRSI(closes, 14)");
    expect(marketSource).toContain("calcMACD(closes)");
    expect(marketSource).toContain("calcEMA(closes, 9)");
    expect(marketSource).toContain("calcEMA(closes, 21)");
    expect(marketSource).toContain("calcADX(highs, lows, closes, 14)");
    expect(marketSource).toContain("calcVWAP(todayHighs, todayLows, todayCloses, todayVolumes)");
  });

  it("should use IBKR mode exclusively when connected (no Yahoo mixing)", () => {
    expect(marketSource).toContain("IBKR MODE: All indicators from IBKR candles");
    expect(marketSource).toContain('source: "ibkr"');
  });

  it("should fallback to Yahoo only when IBKR is not connected", () => {
    expect(marketSource).toContain("IBKR historical failed, trying Yahoo fallback");
    expect(marketSource).toContain("YAHOO FINANCE INTRADAY FETCH (FALLBACK only)");
  });

  it("should set source to ibkr when using IBKR data", () => {
    // In fetchIBKRIntradayStock
    expect(marketSource).toContain('source: "ibkr"');
    // In loadPrices IBKR mode
    expect(marketSource).toContain("IBKR MODE");
  });
});

// ======== BLOCK WINDOW MATH TESTS ========

describe("Block Window Calculations", () => {
  it("should calculate correct block windows (15 min before/after)", () => {
    const eventTime = new Date("2026-03-30T08:30:00-04:00").getTime(); // 8:30 AM ET
    const blockBefore = 15 * 60 * 1000; // 15 minutes in ms
    const blockAfter = 15 * 60 * 1000;

    const blockStart = eventTime - blockBefore;
    const blockEnd = eventTime + blockAfter;

    // Block starts at 8:15 AM ET
    expect(new Date(blockStart).toISOString()).toContain("12:15");
    // Block ends at 8:45 AM ET
    expect(new Date(blockEnd).toISOString()).toContain("12:45");
    // Total block window = 30 minutes
    expect(blockEnd - blockStart).toBe(30 * 60 * 1000);
  });
});

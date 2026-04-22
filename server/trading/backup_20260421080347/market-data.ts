/**
 * Real Market Data Provider
 * - STOCK DATA: IBKR historical/live when connected, otherwise Polygon only
 * - OPTIONS DATA: Polygon only
 * - EXECUTION: IBKR only
 * - NO Yahoo fallback anywhere in the trading path
 * - If required IBKR/Polygon data is unavailable: NO trade, explicit block only
 */
import { ibkr, type IBKRStockData, type IBKROptionData } from "./ibkr-client.js";

const POLYGON_KEY = process.env.POLYGON_API_KEY || "";
const POLYGON_ENABLED = POLYGON_KEY.length > 10; // retained for dormant compatibility only
const POLYGON_BASE = "https://api.polygon.io";
const IBKR_ONLY_MODE = true;

console.log("[Market] IBKR-only trading path active; Polygon fallback disabled in trading path");

// ======== TYPES ========
export interface StockData {
  ticker: string;
  open: number;
  high: number;
  low: number;
  close: number;        // current price (latest bar close)
  volume: number;       // today's total volume
  vwap: number;         // calculated from today's intraday bars
  prevClose: number;    // yesterday's close
  change: number;       // close - prevClose
  changePct: number;    // change / prevClose * 100
  source: "polygon" | "ibkr";
  timestamp: number;
  delayed: boolean;     // false = intraday real-time
  // Technical indicators from real candles
  rsi14: number;
  macdLine: number;
  macdSignal: number;
  macdHist: number;
  ema9: number;
  ema21: number;
  adx: number;
  barsCount: number;
}

export interface OptionQuote {
  ticker: string;
  underlying: string;
  type: "call" | "put";
  strike: number;
  expiry: string;
  bid: number;
  ask: number;
  mid: number;
  last: number;
  volume: number;
  openInterest: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
  dte: number;
  moneyness: string;
  source: "polygon" | "ibkr";
  timestamp: number;
  delayed: boolean;
}

export interface TradingDecisionContext {
  symbol: string;
  dataSourceUsed: string;
  stockDataSource: "polygon" | "ibkr" | "none";
  optionDataSource: "polygon" | "ibkr" | "none";
  ibkrConnected: boolean;
  polygonAvailable: boolean;
  yahooFallbackUsed: boolean;
  tradingReady: boolean;
  blockReason?: string;
}

// ======== CACHE ========
const stockCache = new Map<string, { data: StockData; ts: number }>();
const optionCache = new Map<string, { data: OptionQuote[]; ts: number }>();
const STOCK_CACHE_TTL = 120_000;   // 2 min for intraday stocks
const OPTION_CACHE_TTL = 120_000;  // 2 min for options

// Rate limiter for Polygon (options only)
let polygonCallTimestamps: number[] = [];
const MAX_POLYGON_PER_MIN = 5;

function canCallPolygon(): boolean {
  const now = Date.now();
  polygonCallTimestamps = polygonCallTimestamps.filter(ts => now - ts < 60_000);
  return polygonCallTimestamps.length < MAX_POLYGON_PER_MIN;
}
function recordPolygonCall() { polygonCallTimestamps.push(Date.now()); }

// ======== HELPERS ========
function r2(x: number) { return Math.round(x * 100) / 100; }
function r3(x: number) { return Math.round(x * 1000) / 1000; }
function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function daysUntil(dateStr: string): number {
  return Math.max(0.1, (new Date(dateStr).getTime() - Date.now()) / 86400000);
}

function nextFriday(daysMin: number = 2): string {
  const d = new Date();
  d.setDate(d.getDate() + daysMin);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

// ======== TECHNICAL INDICATORS (from real candles) ========

function calcEMA(closes: number[], period: number): number[] {
  const ema: number[] = [];
  const k = 2 / (period + 1);
  ema[0] = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return r2(100 - (100 / (1 + rs)));
}

function calcMACD(closes: number[]): { line: number; signal: number; hist: number } {
  if (closes.length < 26) return { line: 0, signal: 0, hist: 0 };
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(ema12[i] - ema26[i]);
  }
  const signal = calcEMA(macdLine, 9);
  const last = closes.length - 1;
  return {
    line: r3(macdLine[last]),
    signal: r3(signal[last]),
    hist: r3(macdLine[last] - signal[last])
  };
}

function calcVWAP(highs: number[], lows: number[], closes: number[], volumes: number[]): number {
  let cumPV = 0, cumV = 0;
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    const v = volumes[i] || 0;
    cumPV += tp * v;
    cumV += v;
  }
  return cumV > 0 ? r2(cumPV / cumV) : closes[closes.length - 1];
}

function calcADX(highs: number[], lows: number[], closes: number[], period: number = 14): number {
  if (closes.length < period * 2) return 20;
  const trueRanges: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const h = highs[i], l = lows[i], pc = closes[i - 1];
    trueRanges.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  // Smoothed averages
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let aPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let aMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const dxValues: number[] = [];
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    aPlusDM = (aPlusDM * (period - 1) + plusDM[i]) / period;
    aMinusDM = (aMinusDM * (period - 1) + minusDM[i]) / period;
    const plusDI = atr > 0 ? (aPlusDM / atr) * 100 : 0;
    const minusDI = atr > 0 ? (aMinusDM / atr) * 100 : 0;
    const sum = plusDI + minusDI;
    dxValues.push(sum > 0 ? (Math.abs(plusDI - minusDI) / sum) * 100 : 0);
  }
  if (dxValues.length < period) return r2(dxValues.reduce((a, b) => a + b, 0) / (dxValues.length || 1));
  let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }
  return r2(adx);
}

// ======== US MARKET HOURS CHECK ========
export function isMarketOpen(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  const hour = et.getHours();
  const min = et.getMinutes();
  const timeNum = hour * 100 + min;
  if (day === 0 || day === 6) return false;
  if (timeNum < 930 || timeNum >= 1600) return false;
  return true;
}

export function getMarketStatus(): { open: boolean; nextOpen: string; currentTimeET: string } {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  const hour = et.getHours();
  const min = et.getMinutes();
  const open = isMarketOpen();

  let nextOpen = "";
  if (!open) {
    const next = new Date(et);
    if (day === 6) next.setDate(next.getDate() + 2);
    else if (day === 0) next.setDate(next.getDate() + 1);
    else if (hour >= 16) next.setDate(next.getDate() + (day === 5 ? 3 : 1));
    next.setHours(9, 30, 0, 0);
    nextOpen = next.toISOString();
  }

  return {
    open,
    nextOpen,
    currentTimeET: `${hour.toString().padStart(2, "0")}:${min.toString().padStart(2, "0")} ET`
  };
}

// ======== IBKR HISTORICAL DATA FETCH (PRIMARY when connected) ========
async function fetchIBKRIntradayStock(ticker: string): Promise<StockData | null> {
  const cached = stockCache.get(`ibkr_${ticker}`);
  if (cached && Date.now() - cached.ts < STOCK_CACHE_TTL) return cached.data;

  try {
    // Request 5-min bars for 5 days from IBKR (enough for RSI-14, MACD-26, ADX-14)
    const bars = await ibkr.getHistoricalBars(ticker, "5 mins", "5 D", "TRADES");

    if (bars.length < 5) {
      console.warn(`[IBKR Hist] ${ticker}: only ${bars.length} bars, insufficient`);
      return null;
    }

    const closes = bars.map(b => b.close);
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const volumes = bars.map(b => b.volume);

    // Today's bars only (for VWAP)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayTs = todayStart.getTime() / 1000;
    const todayBars = bars.filter(b => b.time >= todayTs);
    const todayHighs = todayBars.map(b => b.high);
    const todayLows = todayBars.map(b => b.low);
    const todayCloses = todayBars.map(b => b.close);
    const todayVolumes = todayBars.map(b => b.volume);

    // Calculate ALL indicators from IBKR candles
    const rsi14 = calcRSI(closes, 14);
    const macd = calcMACD(closes);
    const ema9 = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const adx = calcADX(highs, lows, closes, 14);

    // VWAP from today's bars only
    const vwap = todayCloses.length > 0
      ? calcVWAP(todayHighs, todayLows, todayCloses, todayVolumes)
      : closes[closes.length - 1];

    // Get real-time price from IBKR tick data
    const ibkrLive = ibkr.getStockPrice(ticker);
    const currentPrice = ibkrLive?.last || closes[closes.length - 1];
    const prevClose = bars.length > 78 ? bars[bars.length - 78]?.close || closes[0] : closes[0]; // ~78 bars = 1 day of 5min
    const change = r2(currentPrice - prevClose);
    const changePct = prevClose > 0 ? r2((change / prevClose) * 100) : 0;

    // Today's total volume
    const todayVolume = ibkrLive?.volume || todayVolumes.reduce((a, b) => a + b, 0);

    // Latest bar for OHLC
    const lastBar = todayBars.length > 0 ? todayBars[todayBars.length - 1] : bars[bars.length - 1];

    const result: StockData = {
      ticker,
      open: todayBars.length > 0 ? todayBars[0].open : lastBar.open,
      high: ibkrLive?.high || Math.max(...todayHighs.length > 0 ? todayHighs : [lastBar.high]),
      low: ibkrLive?.low || Math.min(...todayLows.length > 0 ? todayLows : [lastBar.low]),
      close: currentPrice,
      volume: todayVolume,
      vwap,
      prevClose,
      change,
      changePct,
      source: "ibkr",
      timestamp: Date.now(),
      delayed: false,
      rsi14,
      macdLine: macd.line,
      macdSignal: macd.signal,
      macdHist: macd.hist,
      ema9: r2(ema9[ema9.length - 1]),
      ema21: r2(ema21[ema21.length - 1]),
      adx,
      barsCount: bars.length,
    };

    stockCache.set(`ibkr_${ticker}`, { data: result, ts: Date.now() });
    console.log(`[IBKR Hist] ${ticker}: $${currentPrice} | RSI:${rsi14} MACD:${macd.hist > 0 ? '+' : ''}${macd.hist} ADX:${adx} VWAP:$${vwap} | ${bars.length} IBKR bars`);
    return result;
  } catch (e: any) {
    console.error(`[IBKR Hist] Failed to fetch ${ticker}:`, e.message);
    return null;
  }
}

// ======== YAHOO DISABLED IN TRADING PATH ========
async function fetchIntradayStock(_ticker: string): Promise<StockData | null> {
  console.error("[DATA_BLOCK] Yahoo fallback disabled - returning null");
  return null;
}

// ======== POLYGON OPTIONS SNAPSHOT (unchanged) ========
async function fetchOptionsChain(
  underlying: string,
  type: "call" | "put",
  minStrike: number,
  maxStrike: number,
  minExpiry: string,
  maxExpiry: string,
  limit: number = 10
): Promise<OptionQuote[]> {
  const cacheKey = `${underlying}_${type}_${Math.round(minStrike)}_${Math.round(maxStrike)}_${minExpiry}`;
  const cached = optionCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < OPTION_CACHE_TTL) return cached.data;

  if (!POLYGON_KEY) return [];
  if (!canCallPolygon()) {
    console.warn(`[Options] Rate limit: skipping ${underlying} ${type}`);
    return cached?.data || [];
  }

  try {
    recordPolygonCall();
    const url = `${POLYGON_BASE}/v3/snapshot/options/${underlying}?` +
      `strike_price.gte=${minStrike}&strike_price.lte=${maxStrike}` +
      `&expiration_date.gte=${minExpiry}&expiration_date.lte=${maxExpiry}` +
      `&contract_type=${type}&limit=${limit}` +
      `&apiKey=${POLYGON_KEY}`;

    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) {
      console.error(`[Options] API error: ${r.status} ${r.statusText}`);
      return cached?.data || [];
    }
    const d = await r.json() as any;
    if (!d.results?.length) return [];

    const quotes: OptionQuote[] = d.results.map((item: any) => {
      const det = item.details || {};
      const day = item.day || {};
      const greeks = item.greeks || {};
      const strike = det.strike_price || 0;
      const expiry = det.expiration_date || "";
      const dte = daysUntil(expiry);

      const close = day.close || 0;
      const spread = Math.max(0.05, close * 0.03);
      const bid = item.last_quote?.bid || r2(close - spread / 2);
      const ask = item.last_quote?.ask || r2(close + spread / 2);
      const mid = r2((bid + ask) / 2);
      const last = item.last_trade?.price || close;

      const stockPrice = stockCache.get(underlying)?.data.close || strike;
      const m = (stockPrice - strike) / stockPrice * (type === "call" ? 1 : -1);
      const mStr = Math.abs(m) < 0.005 ? "ATM" : m > 0 ? "ITM" : "OTM";

      return {
        ticker: det.ticker || `O:${underlying}`,
        underlying,
        type: det.contract_type || type,
        strike, expiry,
        bid: Math.max(0.01, bid), ask: Math.max(0.02, ask),
        mid: Math.max(0.01, mid), last: Math.max(0.01, last),
        volume: day.volume || 0, openInterest: item.open_interest || 0,
        delta: r3(greeks.delta || 0), gamma: r3(greeks.gamma || 0),
        theta: r2(greeks.theta || 0), vega: r2(greeks.vega || 0),
        iv: r3(item.implied_volatility || 0),
        dte: Math.round(dte * 10) / 10, moneyness: mStr,
        source: "polygon" as const, timestamp: Date.now(), delayed: false
      };
    });

    quotes.sort((a, b) => b.volume - a.volume);
    optionCache.set(cacheKey, { data: quotes, ts: Date.now() });
    return quotes;
  } catch (e: any) {
    console.error(`[Options] Failed to fetch ${underlying} ${type}:`, e.message);
    return cached?.data || [];
  }
}

// ======== MAIN PROVIDER ========
export class MarketDataProvider {
  private prices: Record<string, StockData> = {};
  private loaded = false;
  private ibkrMode = false;

  async connectIBKR(): Promise<boolean> {
    console.log("[Market] Attempting IBKR connection...");
    const connected = await ibkr.connect();
    if (connected) {
      this.ibkrMode = true;
      console.log("[Market] IBKR connected! Using IBKR for stock candles/live prices and IBKR for execution.");
      const tickers = ["SPY", "QQQ", "AAPL", "TSLA", "NVDA", "MSFT", "META", "AMZN", "SPX"];
      for (const t of tickers) {
        await ibkr.subscribeStock(t);
        await delay(500);
      }
      await delay(3000);
      return true;
    }
    this.ibkrMode = false;
    console.warn("[Market] IBKR connection failed. Trading path remains fail-safe: no fallback data source, no execution.");
    return false;
  }

  isIBKRConnected(): boolean {
    return this.ibkrMode && ibkr.isConnected();
  }

  getIBKRAccountId(): string {
    return ibkr.getAccountId();
  }

  getIBKRStatus() {
    return ibkr.getStatus();
  }

  isPolygonAvailable(): boolean {
    return IBKR_ONLY_MODE ? false : POLYGON_ENABLED;
  }

  getDecisionContext(symbol: string, optionDataSource: "polygon" | "ibkr" | "none" = "none"): TradingDecisionContext {
    const stockSource = this.prices[symbol]?.source === "ibkr"
      ? "ibkr"
      : this.prices[symbol]?.source === "polygon"
        ? "polygon"
        : "none";
    const ibkrConnected = this.isIBKRConnected();
    const polygonAvailable = IBKR_ONLY_MODE ? false : POLYGON_ENABLED;
    let blockReason: string | undefined;
    if (!ibkrConnected) blockReason = "ibkr_execution_unavailable";
    if (ibkrConnected && stockSource === "none") blockReason = `ibkr_stock_data_unavailable:${symbol}`;
    const dataSourceUsed = `stock:${stockSource}|options:${optionDataSource}|execution:${ibkrConnected ? "ibkr" : "none"}`;
    return {
      symbol,
      dataSourceUsed,
      stockDataSource: stockSource,
      optionDataSource,
      ibkrConnected,
      polygonAvailable,
      yahooFallbackUsed: false,
      tradingReady: !blockReason,
      blockReason,
    };
  }

  async loadPrices(): Promise<boolean> {
    const tickers = ["SPY", "QQQ", "AAPL", "TSLA", "NVDA", "MSFT", "META", "AMZN"];
    let success = 0;

    if (!(this.ibkrMode && ibkr.isConnected())) {
      console.error("[DATA] ❌ IBKR-only mode active but gateway/data connection is not available");
      return false;
    }

    console.log(`[Market] === IBKR-ONLY MODE: All indicators from IBKR candles ===`);
    for (const t of tickers) {
      const data = await fetchIBKRIntradayStock(t);
      if (data) {
        this.prices[t] = data;
        success++;
        console.log(`[Market] ${t}: $${data.close} (IBKR) | RSI:${data.rsi14} MACD:${data.macdHist > 0 ? '+' : ''}${data.macdHist} ADX:${data.adx} VWAP:$${data.vwap}`);
      } else {
        delete this.prices[t];
        console.error(`[DATA_BLOCK] ${t}: IBKR historical/live data unavailable | source=ibkr | polygonAvailable=false | yahooFallbackUsed=false`);
      }
      await delay(500);
    }

    this.loaded = success >= 2;
    if (!this.loaded) {
      console.error("[Market] CRITICAL: Cannot load minimum required IBKR data");
    }
    return this.loaded;
  }

  getPrice(ticker: string): number | null {
    return this.prices[ticker]?.close || null;
  }

  getStockData(ticker: string): StockData | null {
    return this.prices[ticker] || null;
  }

  getVIX(): number | null {
    return this.prices["VIX"]?.close || null;
  }

  hasRealData(): boolean {
    return this.loaded && !!this.prices["SPY"] && !!this.prices["QQQ"];
  }

  isConfigured(): boolean {
    return true;
  }

  getDataTimestamp(): number {
    return this.prices["SPY"]?.timestamp || 0;
  }

  isDataFresh(maxAgeMs: number = 300_000): boolean {
    const ts = this.getDataTimestamp();
    return ts > 0 && (Date.now() - ts) < maxAgeMs;
  }

  async findOptionIBKR(
    underlying: string,
    type: "call" | "put",
    strike: number,
    expiry: string
  ): Promise<OptionQuote | null> {
    if (!this.ibkrMode || !ibkr.isConnected()) return null;
    try {
      const opt = await ibkr.getOptionSnapshot(underlying, type, strike, expiry);
      if (!opt) return null;
      const dte = daysUntil(expiry);
      const stockPrice = this.getPrice(underlying) || strike;
      const m = (stockPrice - strike) / stockPrice * (type === "call" ? 1 : -1);
      const mStr = Math.abs(m) < 0.005 ? "ATM" : m > 0 ? "ITM" : "OTM";
      return {
        ticker: opt.ticker,
        underlying,
        type,
        strike,
        expiry,
        bid: opt.bid,
        ask: opt.ask,
        mid: opt.mid || (opt.bid + opt.ask) / 2,
        last: opt.last,
        volume: opt.volume,
        openInterest: opt.openInterest,
        delta: opt.delta,
        gamma: opt.gamma,
        theta: opt.theta,
        vega: opt.vega,
        iv: opt.iv,
        dte: Math.round(dte * 10) / 10,
        moneyness: mStr,
        source: "ibkr" as const,
        timestamp: Date.now(),
        delayed: false,
      };
    } catch (e: any) {
      console.error(`[IBKR Options] Failed: ${e.message}`);
      return null;
    }
  }

  async findOption(
    underlying: string,
    type: "call" | "put",
    deltaRange: [number, number],
    premiumRange: [number, number],
    daysToExpiry: number = 3
  ): Promise<OptionQuote | null> {
    if (!POLYGON_ENABLED) {
      console.error(`[DATA_BLOCK] ${underlying}: Polygon unavailable for option lookup | source=none | ibkrConnected=${this.isIBKRConnected()} | polygonAvailable=false | yahooFallbackUsed=false`);
      return null;
    }
    const stockPrice = this.getPrice(underlying);
    if (!stockPrice) {
      console.error(`[DATA_BLOCK] ${underlying}: stock price unavailable before option lookup | source=none | ibkrConnected=${this.isIBKRConnected()} | polygonAvailable=${POLYGON_ENABLED} | yahooFallbackUsed=false`);
      return null;
    }

    const otmPct = 0.03;
    const minStrike = type === "call"
      ? Math.floor(stockPrice * (1 - 0.01))
      : Math.floor(stockPrice * (1 - otmPct));
    const maxStrike = type === "call"
      ? Math.ceil(stockPrice * (1 + otmPct))
      : Math.ceil(stockPrice * (1 + 0.01));

    const minExpiry = new Date().toISOString().split("T")[0];
    const maxExpiry = nextFriday(daysToExpiry + 5);

    console.log(`[Options] Searching ${underlying} ${type} ATM | Strike: ${minStrike}-${maxStrike} | Delta: ${deltaRange[0]}-${deltaRange[1]}`);

    const chain = await fetchOptionsChain(underlying, type, minStrike, maxStrike, minExpiry, maxExpiry, 10);
    console.log(`[OPTION_DIAG] ${underlying} ${type} | before_filters=${chain.length} | expiry_window=${minExpiry}..${maxExpiry} | requested_dte=${daysToExpiry}`);
    if (chain.length === 0) {
      console.warn(`[OPTION_DIAG] ${underlying} ${type} | no contracts returned before filtering`);
      return null;
    }

    const expiryDteCandidates = chain.filter(q => q.expiry >= minExpiry && q.expiry <= maxExpiry);
    console.log(`[OPTION_DIAG] ${underlying} ${type} | after_expiry_dte=${expiryDteCandidates.length}`);

    const deltaCandidates = expiryDteCandidates.filter(q => {
      const absDelta = Math.abs(q.delta);
      return absDelta >= deltaRange[0] && absDelta <= deltaRange[1];
    });
    console.log(`[OPTION_DIAG] ${underlying} ${type} | after_delta=${deltaCandidates.length}`);

    const premiumCandidates = deltaCandidates.filter(q => q.mid >= premiumRange[0] && q.mid <= premiumRange[1]);
    console.log(`[OPTION_DIAG] ${underlying} ${type} | after_premium=${premiumCandidates.length}`);

    let lastRejectedReason = "none";
    for (const q of chain) {
      if (!(q.expiry >= minExpiry && q.expiry <= maxExpiry)) {
        lastRejectedReason = `${q.ticker} | expiry_dte_filtered | expiry=${q.expiry} | dte=${q.dte}`;
        continue;
      }
      const absDelta = Math.abs(q.delta);
      if (!(absDelta >= deltaRange[0] && absDelta <= deltaRange[1])) {
        lastRejectedReason = `${q.ticker} | delta_filtered | delta=${absDelta.toFixed(3)} | target=${deltaRange[0]}-${deltaRange[1]}`;
        continue;
      }
      if (!(q.mid >= premiumRange[0] && q.mid <= premiumRange[1])) {
        lastRejectedReason = `${q.ticker} | premium_filtered | mid=$${q.mid.toFixed(2)} | target=$${premiumRange[0]}-$${premiumRange[1]}`;
        continue;
      }
      if (!(q.volume > 0)) {
        lastRejectedReason = `${q.ticker} | liquidity_filtered | volume=${q.volume}`;
        continue;
      }
    }
    console.log(`[OPTION_DIAG] ${underlying} ${type} | last_rejected=${lastRejectedReason}`);

    const candidates = chain.filter(q => {
      const absDelta = Math.abs(q.delta);
      return absDelta >= deltaRange[0] && absDelta <= deltaRange[1] &&
             q.mid >= premiumRange[0] && q.mid <= premiumRange[1] &&
             q.volume > 0;
    });

    if (candidates.length > 0) {
      const top3 = [...candidates]
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 3)
        .map(q => `${q.ticker} | exp=${q.expiry} | strike=${q.strike} | dte=${q.dte} | Δ${Math.abs(q.delta).toFixed(3)} | Mid:$${q.mid.toFixed(2)} | Vol:${q.volume}`)
        .join(" || ");
      console.log(`[OPTION_DIAG] ${underlying} ${type} | top_3=${top3}`);
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.volume - a.volume);
    const best = candidates[0];
    console.log(`[Options] Found ATM: ${best.ticker} | Δ${best.delta} | Mid:$${best.mid} | Vol:${best.volume}`);
    return best;
  }

  async getOptionPrice(
    underlying: string,
    type: "call" | "put",
    strike: number,
    expiry: string
  ): Promise<OptionQuote | null> {
    if (!POLYGON_ENABLED) {
      console.error(`[DATA_BLOCK] ${underlying}: Polygon unavailable for option pricing | source=none | ibkrConnected=${this.isIBKRConnected()} | polygonAvailable=false | yahooFallbackUsed=false`);
      return null;
    }
    const chain = await fetchOptionsChain(underlying, type, strike - 1, strike + 1, expiry, expiry, 5);
    return chain.find(q => q.strike === strike && q.expiry === expiry) || null;
  }

  async refreshPrices(): Promise<void> {
    for (const t of ["SPY", "QQQ"]) {
      stockCache.delete(`ibkr_${t}`);
      stockCache.delete(t);
      const data = this.ibkrMode && ibkr.isConnected()
        ? await fetchIBKRIntradayStock(t)
        : null;
      if (data) {
        this.prices[t] = data;
      } else {
        delete this.prices[t];
        console.error(`[DATA_BLOCK] ${t}: refresh failed | source=ibkr | ibkrConnected=${this.isIBKRConnected()} | polygonAvailable=false | yahooFallbackUsed=false`);
      }
      await delay(500);
    }
  }

  getAllStockData(): Record<string, StockData> {
    return { ...this.prices };
  }
}

export const market = new MarketDataProvider();


// ======== POLYGON.IO STOCK DATA FETCH ========
async function fetchPolygonStock(ticker: string): Promise<StockData | null> {
  if (!POLYGON_KEY) return null;
  
  try {
    // Get previous close and aggregates from Polygon
    const baseUrl = "https://api.polygon.io/v2";
    const params = `?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY}`;
    
    // Get previous day close
    const prevUrl = `${baseUrl}/aggs/ticker/${ticker}/prev${params}`;
    const prevRes = await fetch(prevUrl);
    if (!prevRes.ok) return null;
    const prevData = await prevRes.json();
    
    if (!prevData.results || prevData.results.length === 0) return null;
    
    const prev = prevData.results[0];
    const prevClose = prev.c;
    const prevOpen = prev.o;
    
    // Get intraday bars for indicators (last 5 days, 5min)
    const aggsUrl = `${baseUrl}/aggs/ticker/${ticker}/range/5/minute/2025-01-01/2025-12-31${params}`;
    const aggsRes = await fetch(aggsUrl);
    if (!aggsRes.ok) return null;
    const aggsData = await aggsRes.json();
    
    if (!aggsData.results || aggsData.results.length < 50) return null;
    
    const bars = aggsData.results.slice(-500); // Last 500 5-min bars
    
    // Calculate indicators
    const closes = bars.map((b: any) => b.c);
    const volumes = bars.map((b: any) => b.v);
    
    // RSI(14)
    const rsi14 = calculateRSI(closes, 14);
    
    // MACD(12,26,9)
    const macd = calculateMACD(closes, 12, 26, 9);
    
    // ADX(14)
    const adx = calculateADX(bars, 14);
    
    // VWAP
    const vwap = calculateVWAP(bars);
    
    // Current price from last bar
    const currentPrice = bars[bars.length - 1].c;
    
    return {
      ticker,
      close: currentPrice,
      open: prevOpen,
      high: Math.max(...bars.map((b: any) => b.h)),
      low: Math.min(...bars.map((b: any) => b.l)),
      volume: volumes.reduce((a: number, b: number) => a + b, 0),
      prevClose,
      vwap,
      rsi14,
      macdHist: macd.hist,
      macdSignal: macd.signal,
      macdLine: macd.line,
      adx,
      ema9: calculateEMA(closes, 9),
      ema21: calculateEMA(closes, 21),
      ema50: calculateEMA(closes, 50),
      barsCount: bars.length,
      source: "polygon",
      timestamp: Date.now(),
      delayed: false
    };
  } catch (e: any) {
    console.error(`[Polygon] ${ticker} error:`, e.message);
    return null;
  }
}

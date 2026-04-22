import re

with open("market-data.ts", "r") as f:
    content = f.read()

# 1. Update the header to include Polygon
old_header = ''' * - PRIMARY: IBKR (Interactive Brokers) via IB Gateway for real-time data
 * - FALLBACK: Yahoo Finance for intraday stock data
 * - OPTIONS: IBKR for real options data (Greeks, IV, Bid/Ask, Volume, OI)'''

new_header = ''' * - PRIMARY DATA: Polygon.io (with Polygon API Key)
 * - FALLBACK: Yahoo Finance (disabled for now)
 * - SECONDARY: IBKR for real-time prices only (no historical)
 * - OPTIONS: Polygon.io for real options data (Greeks, IV, Bid/Ask, Volume, OI)
 * - EXECUTION: IBKR only (no change)
 * - If no Polygon API Key: NO trading, just wait'''

content = content.replace(old_header, new_header)

# 2. Add Polygon key check constant after POLYGON_KEY
old_key = 'const POLYGON_KEY = process.env.POLYGON_API_KEY || "";'
new_key = '''const POLYGON_KEY = process.env.POLYGON_API_KEY || "";
const POLYGON_ENABLED = POLYGON_KEY.length > 10; // Need at least 10 chars for valid key'''

content = content.replace(old_key, new_key)

# 3. Add Polygon status check at the beginning of loadPrices
old_load_prices = '''async loadPrices(): Promise<boolean> {
    const tickers = ["SPY", "QQQ", "AAPL", "TSLA", "NVDA", "MSFT", "META", "AMZN"];
    let success = 0;

    // IBKR CONNECTED: Use IBKR historical candles for ALL indicators (NO Yahoo mixing)'''

new_load_prices = '''async loadPrices(): Promise<boolean> {
    const tickers = ["SPY", "QQQ", "AAPL", "TSLA", "NVDA", "MSFT", "META", "AMZN"];
    let success = 0;

    // ====== POLYGON STATUS CHECK ======
    if (!POLYGON_ENABLED) {
      console.log("[DATA] ⚠️ Polygon NOT active - waiting for API Key");
      console.log("[DATA] To activate: Set POLYGON_API_KEY in .env");
      console.log("[EXECUTION] IBKR execution ready but NO trading without data source");
      return false; // Don't trade without data source
    }
    console.log("[DATA] ✅ Polygon active - using for all stock data");
    console.log("[EXECUTION] IBKR ready for options execution");

    // If Polygon is active, use it instead of IBKR historical'''

content = content.replace(old_load_prices, new_load_prices)

# 4. Add Polygon data fetching (replace Yahoo)
old_pure_yahoo = '''    } else {
      // Pure Yahoo mode
      for (const t of tickers) {'''

new_pure_yahoo = '''    } else if (POLYGON_ENABLED) {
      // Polygon mode - fetch from Polygon API
      console.log("[DATA] === POLYGON MODE: Fetching from Polygon ===");
      for (const t of tickers) {
        const data = await fetchPolygonStock(t);
        if (data) {
          this.prices[t] = data;
          success++;
          console.log(`[Market] ${t}: $${data.close} (Polygon) | RSI:${data.rsi14} MACD:${data.macdHist > 0 ? '+' : ''}${data.macdHist} ADX:${data.adx} VWAP:$${data.vwap}`);
        } else {
          console.warn(`[Market] ${t}: Polygon fetch failed`);
        }
        await delay(500);
      }
    } else {
      // No data source - should not happen due to check above
      console.error("[DATA] ❌ No data source available!");
      return false;'''

content = content.replace(old_pure_yahoo, new_pure_yahoo)

# 5. Add fetchPolygonStock function
# Find where fetchIntradayStock is defined and add Polygon after it
polygon_function = '''
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
'''

# Add the function after fetchIntradayStock function
content = content + "\n" + polygon_function

with open("market-data.ts", "w") as f:
    f.write(content)

print("OK - Polygon integration added to market-data.ts")
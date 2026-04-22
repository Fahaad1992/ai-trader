/**
 * IBKR Client - Connects to IB Gateway via TWS API
 * Uses @stoqey/ib library for real-time market data and order execution
 */
import { IBApi, EventName, Contract, Order, OrderAction, OrderType, SecType, BarSizeSetting, WhatToShow } from "@stoqey/ib";
import { assertOptionsRuntimeAllowed } from "./trade-mode.js";

const IBKR_HOST = process.env.IBKR_HOST || "127.0.0.1";
const IBKR_PORT = parseInt(process.env.IBKR_PORT || "4002");
const IBKR_CLIENT_ID = parseInt(process.env.IBKR_CLIENT_ID || "1");
const IBKR_TRADING_MODE = (process.env.IBKR_MODE || process.env.TRADING_MODE || process.env.BOT_MODE || "paper").toLowerCase();
const IBKR_MARKET_DATA_TYPE = IBKR_TRADING_MODE === "live" ? 1 : 3;
const IBKR_MARKET_DATA_TYPE_LABEL = IBKR_MARKET_DATA_TYPE === 1 ? "LIVE" : "DELAYED";
const MES_FUTURES_EXCHANGE = "CME";
const MES_MONTH_CODE_TO_MONTH: Record<string, string> = {
  H: "03",
  M: "06",
  U: "09",
  Z: "12",
};

function inferFourDigitYearFromSingleDigit(singleDigitYear: number, asOf: Date = new Date()): number {
  const currentYear = asOf.getUTCFullYear();
  const decadeBase = Math.floor(currentYear / 10) * 10;
  let inferredYear = decadeBase + singleDigitYear;
  if (inferredYear < currentYear - 5) inferredYear += 10;
  if (inferredYear > currentYear + 5) inferredYear -= 10;
  return inferredYear;
}

function parseMesTastytradeSymbol(tastytradeSymbol: string): { symbol: "MES"; monthCode: "H" | "M" | "U" | "Z"; year: number; contractMonth: string } {
  const match = /^\/MES([HMUZ])(\d)$/.exec(String(tastytradeSymbol || "").trim().toUpperCase());
  if (!match) throw new Error(`[MES_FEED] Unsupported MES tastytrade symbol: ${tastytradeSymbol}`);
  const monthCode = match[1] as "H" | "M" | "U" | "Z";
  const year = inferFourDigitYearFromSingleDigit(Number(match[2]));
  const contractMonth = MES_MONTH_CODE_TO_MONTH[monthCode];
  return { symbol: "MES", monthCode, year, contractMonth };
}

// ======== TYPES ========
export interface IBKRStockData {
  ticker: string;
  last: number;
  bid: number;
  ask: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export interface IBKROptionData {
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
  timestamp: number;
}

export interface IBKROrderResult {
  orderId: number;
  status: string;
  filled: number;
  remaining: number;
  avgFillPrice: number;
  lastFillPrice: number;
  stopOrderId?: number;
  permId?: number;
  parentStatus?: string;
  childStopStatus?: string;
  code?: number;
  errorMessage?: string;
  rejectReason?: string;
  advancedOrderRejectJson?: string;
}

export interface IBKRAccountSummary {
  accountId: string;
  netLiquidation: number;
  totalCashValue: number;
  availableFunds: number;
  buyingPower: number;
  currency: string;
  timestamp: number;
}

// ======== IBKR CLIENT ========
class IBKRClient {
  private ib: IBApi | null = null;
  private connected = false;
  private connecting = false;
  private nextOrderId = 0;
  private accountId = "";
  private reqId = 1000;
  private latestMarketDataMode: "live" | "delayed" | "unknown" = IBKR_MARKET_DATA_TYPE === 1 ? "unknown" : "delayed";
  private tickerFeedModes = new Map<string, "live" | "delayed">();
  private lastAccountSummary: IBKRAccountSummary | null = null;

  // Data storage
  private stockPrices = new Map<string, IBKRStockData>();
  private optionData = new Map<string, IBKROptionData[]>();
  private orderResults = new Map<number, IBKROrderResult>();
  private tickerReqMap = new Map<number, string>();
  private underlyingConIds = new Map<string, number>();

  // Promises for async operations
  private pendingRequests = new Map<number, { resolve: (data: any) => void; reject: (err: any) => void; timeout: ReturnType<typeof setTimeout> }>();

  private getNextReqId(): number {
    return this.reqId++;
  }

  async connect(): Promise<boolean> {
    if (this.connected) return true;
    if (this.connecting) {
      // Wait for existing connection attempt
      await new Promise(r => setTimeout(r, 3000));
      return this.connected;
    }

    this.connecting = true;
    console.log(`[IBKR] Connecting to ${IBKR_HOST}:${IBKR_PORT} (clientId: ${IBKR_CLIENT_ID})...`);

    return new Promise((resolve) => {
      try {
        this.ib = new IBApi({ host: IBKR_HOST, port: IBKR_PORT, clientId: IBKR_CLIENT_ID });

        // Connection events
        this.ib.on(EventName.connected, () => {
          console.log("[IBKR] Connected to IB Gateway!");
          this.connected = true;
          this.connecting = false;
          // Use LIVE market data in live trading, otherwise fall back to DELAYED.
          this.ib!.reqMarketDataType(IBKR_MARKET_DATA_TYPE);
          console.log(`[IBKR] Market data type set to ${IBKR_MARKET_DATA_TYPE_LABEL} (${IBKR_MARKET_DATA_TYPE}) for TRADING_MODE=${IBKR_TRADING_MODE}`);
          this.ib!.reqCurrentTime();
          this.ib!.reqManagedAccts();
          resolve(true);
        });

        this.ib.on(EventName.disconnected, () => {
          console.log("[IBKR] Disconnected from IB Gateway");
          this.connected = false;
          this.connecting = false;
        });

        this.ib.on(EventName.error, (err: Error & { advancedOrderRejectJson?: string }, code: number, reqId: number, advancedOrderRejectJson?: string) => {
          const errorMessage = err?.message || String(err);
          const msg = `[IBKR] Error: ${errorMessage} (code: ${code}, reqId: ${reqId})`;
          const advancedReject = advancedOrderRejectJson || err?.advancedOrderRejectJson || undefined;

          // Don't log non-critical errors
          if (code === 2104 || code === 2106 || code === 2158) {
            // Market data farm connection messages - informational
            console.log(`[IBKR] Info: ${errorMessage}`);
          } else if (code === 2103 || code === 2105) {
            console.warn(`[IBKR] Warning: ${errorMessage}`);
          } else {
            console.error(msg);
            if (advancedReject) console.error(`[IBKR] advancedOrderRejectJson: ${advancedReject}`);
          }

          if (reqId > 0) {
            const existingOrderResult = this.orderResults.get(reqId);
            this.orderResults.set(reqId, {
              orderId: reqId,
              status: existingOrderResult?.status || "Rejected",
              filled: existingOrderResult?.filled || 0,
              remaining: existingOrderResult?.remaining || 0,
              avgFillPrice: existingOrderResult?.avgFillPrice || 0,
              lastFillPrice: existingOrderResult?.lastFillPrice || 0,
              stopOrderId: existingOrderResult?.stopOrderId,
              permId: existingOrderResult?.permId,
              parentStatus: existingOrderResult?.parentStatus || existingOrderResult?.status || "Rejected",
              childStopStatus: existingOrderResult?.childStopStatus,
              code,
              errorMessage,
              rejectReason: msg,
              advancedOrderRejectJson: advancedReject,
            });
          }

          // Reject pending request if applicable
          const pending = this.pendingRequests.get(reqId);
          if (pending) {
            clearTimeout(pending.timeout);
            const enrichedError = Object.assign(new Error(msg), {
              code,
              reqId,
              errorMessage,
              rejectReason: msg,
              advancedOrderRejectJson: advancedReject,
            });
            pending.reject(enrichedError);
            this.pendingRequests.delete(reqId);
          }
        });

        // Next valid order ID
        this.ib.on(EventName.nextValidId, (orderId: number) => {
          this.nextOrderId = orderId;
          console.log(`[IBKR] Next valid order ID: ${orderId}`);
        });

        // Managed accounts
        this.ib.on(EventName.managedAccounts, (accountsList: string) => {
          this.accountId = accountsList.split(",")[0]?.trim() || "";
          console.log(`[IBKR] Account ID: ${this.accountId}`);
        });

        // Current time
        this.ib.on(EventName.currentTime, (time: number) => {
          console.log(`[IBKR] Server time: ${new Date(time * 1000).toISOString()}`);
        });

        // Tick price data
        this.ib.on(EventName.tickPrice, (reqId: number, tickType: number, price: number) => {
          const ticker = this.tickerReqMap.get(reqId);
          if (!ticker || price <= 0) return;

          const delayedTickTypes = new Set([66, 67, 68, 72, 73, 75, 76]);
          const liveTickTypes = new Set([1, 2, 4, 6, 7, 9, 14]);
          if (delayedTickTypes.has(tickType)) {
            this.latestMarketDataMode = "delayed";
            this.tickerFeedModes.set(ticker, "delayed");
          } else if (liveTickTypes.has(tickType)) {
            this.latestMarketDataMode = "live";
            if (this.tickerFeedModes.get(ticker) !== "delayed") {
              this.tickerFeedModes.set(ticker, "live");
            }
          }

          const existing = this.stockPrices.get(ticker) || {
            ticker, last: 0, bid: 0, ask: 0, open: 0, high: 0, low: 0, close: 0, volume: 0, timestamp: Date.now()
          };

          // tickType: 1/66=bid, 2/67=ask, 4/68=last, 6/72=high, 7/73=low, 9/75=close, 14/76=open
          switch (tickType) {
            case 1:
            case 66:
              existing.bid = price;
              break;
            case 2:
            case 67:
              existing.ask = price;
              break;
            case 4:
            case 68:
              existing.last = price;
              existing.close = price;
              break;
            case 6:
            case 72:
              existing.high = price;
              break;
            case 7:
            case 73:
              existing.low = price;
              break;
            case 9:
            case 75:
              existing.close = price;
              break;
            case 14:
            case 76:
              existing.open = price;
              break;
          }
          existing.timestamp = Date.now();
          this.stockPrices.set(ticker, existing);
        });

        // Tick size data (volume)
        this.ib.on(EventName.tickSize, (reqId: number, tickType: number, size: number) => {
          const ticker = this.tickerReqMap.get(reqId);
          if (!ticker) return;

          const existing = this.stockPrices.get(ticker);
          if (!existing) return;

          // tickType: 8=volume
          if (tickType === 8) {
            existing.volume = size;
            existing.timestamp = Date.now();
            this.stockPrices.set(ticker, existing);
          }
        });

        // Option computation (greeks)
        this.ib.on(EventName.tickOptionComputation, (reqId: number, tickType: number, tickAttrib: number, impliedVol: number, delta: number, optPrice: number, pvDividend: number, gamma: number, vega: number, theta: number) => {
          const pending = this.pendingRequests.get(reqId);
          if (pending && tickType === 13) { // 13 = model option computation
            clearTimeout(pending.timeout);
            pending.resolve({ iv: impliedVol, delta, gamma, vega, theta, optPrice });
            this.pendingRequests.delete(reqId);
          }
        });

        // Order status
        this.ib.on(EventName.orderStatus, (orderId: number, status: string, filled: number, remaining: number, avgFillPrice: number, permId: number, parentId: number, lastFillPrice: number) => {
          const existingOrderResult = this.orderResults.get(orderId);
          this.orderResults.set(orderId, {
            ...existingOrderResult,
            orderId,
            status,
            filled,
            remaining,
            avgFillPrice,
            lastFillPrice,
            permId: permId > 0 ? permId : existingOrderResult?.permId,
            parentStatus: parentId === 0 ? status : existingOrderResult?.parentStatus,
            childStopStatus: parentId > 0 ? status : existingOrderResult?.childStopStatus,
          });

          const pending = this.pendingRequests.get(orderId);
          if (pending && (status === "Filled" || status === "Cancelled" || status === "Inactive" || status === "Rejected")) {
            clearTimeout(pending.timeout);
            pending.resolve(this.orderResults.get(orderId));
            this.pendingRequests.delete(orderId);
          }
        });

        // Contract details response
        this.ib.on(EventName.contractDetails, (reqId: number, contractDetails: any) => {
          const pending = this.pendingRequests.get(reqId);
          if (pending) {
            // Accumulate contract details
            if (!pending.resolve._data) pending.resolve._data = [];
            pending.resolve._data.push(contractDetails);
          }
        });

        this.ib.on(EventName.contractDetailsEnd, (reqId: number) => {
          const pending = this.pendingRequests.get(reqId);
          if (pending) {
            clearTimeout(pending.timeout);
            pending.resolve(pending.resolve._data || []);
            this.pendingRequests.delete(reqId);
          }
        });

        // Security definition option parameters
        this.ib.on(EventName.securityDefinitionOptionParameter, (reqId: number, exchange: string, underlyingConId: number, tradingClass: string, multiplier: string, expirations: string[], strikes: number[]) => {
          const pending = this.pendingRequests.get(reqId);
          if (pending) {
            if (!pending.resolve._data) pending.resolve._data = [];
            pending.resolve._data.push({ exchange, underlyingConId, tradingClass, multiplier, expirations, strikes });
          }
        });

        this.ib.on(EventName.securityDefinitionOptionParameterEnd, (reqId: number) => {
          const pending = this.pendingRequests.get(reqId);
          if (pending) {
            clearTimeout(pending.timeout);
            pending.resolve(pending.resolve._data || []);
            this.pendingRequests.delete(reqId);
          }
        });

        // Connect
        this.ib.connect();

        // Timeout
        setTimeout(() => {
          if (!this.connected) {
            console.error("[IBKR] Connection timeout after 15s");
            this.connecting = false;
            resolve(false);
          }
        }, 15000);

      } catch (err: any) {
        console.error(`[IBKR] Connection error: ${err.message}`);
        this.connecting = false;
        resolve(false);
      }
    });
  }

  disconnect() {
    if (this.ib) {
      this.ib.disconnect();
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getAccountId(): string {
    return this.accountId;
  }

  // ======== MARKET DATA ========

  async subscribeStock(ticker: string): Promise<void> {
    if (!this.connected || !this.ib) return;
    if (Array.from(this.tickerReqMap.values()).includes(ticker)) {
      console.log(`[IBKR] Already subscribed to , skipping duplicate market data request`);
      return;
    }

    const reqId = this.getNextReqId();
    this.tickerReqMap.set(reqId, ticker);

    const contract: Contract = {
      symbol: ticker,
      secType: SecType.STK,
      exchange: "SMART",
      currency: "USD",
    };

    // For SPX index
    if (ticker === "SPX") {
      contract.symbol = "SPX";
      contract.secType = SecType.IND;
      contract.exchange = "CBOE";
    }

    this.ib.reqMktData(reqId, contract, "", false, false);
    console.log(`[IBKR] Subscribed to ${ticker} market data (reqId: ${reqId})`);
  }

  getStockPrice(ticker: string): IBKRStockData | null {
    return this.stockPrices.get(ticker) || null;
  }

  private buildMesFutureContract(tastytradeSymbol: string = "/MESM6"): Contract {
    const parsed = parseMesTastytradeSymbol(tastytradeSymbol);
    return {
      symbol: parsed.symbol,
      secType: SecType.FUT,
      exchange: MES_FUTURES_EXCHANGE,
      currency: "USD",
      tradingClass: parsed.symbol,
      lastTradeDateOrContractMonth: `${parsed.year}${parsed.contractMonth}`,
    };
  }

  async subscribeMesFuture(tastytradeSymbol: string = "/MESM6"): Promise<void> {
    if (!this.connected || !this.ib) return;
    if (Array.from(this.tickerReqMap.values()).includes(tastytradeSymbol)) {
      console.log(`[MES_FEED] source=ibkr-${IBKR_MARKET_DATA_TYPE_LABEL.toLowerCase()} symbol=${tastytradeSymbol} status=already-subscribed`);
      return;
    }
    const reqId = this.getNextReqId();
    this.tickerReqMap.set(reqId, tastytradeSymbol);
    if (!this.stockPrices.has(tastytradeSymbol)) {
      this.stockPrices.set(tastytradeSymbol, {
        ticker: tastytradeSymbol,
        last: 0,
        bid: 0,
        ask: 0,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        volume: 0,
        timestamp: Date.now(),
      });
    }
    const contract = this.buildMesFutureContract(tastytradeSymbol);
    this.ib.reqMktData(reqId, contract, "", false, false);
    console.log(`[MES_FEED] source=ibkr-${IBKR_MARKET_DATA_TYPE_LABEL.toLowerCase()} symbol=${tastytradeSymbol} exchange=${MES_FUTURES_EXCHANGE} contractMonth=${contract.lastTradeDateOrContractMonth} status=subscribed reqId=${reqId}`);
  }

  getMesFuturePrice(tastytradeSymbol: string = "/MESM6"): Pick<IBKRStockData, "ticker" | "last" | "bid" | "ask" | "timestamp"> | null {
    const data = this.stockPrices.get(tastytradeSymbol);
    if (!data) return null;
    return {
      ticker: data.ticker,
      last: data.last,
      bid: data.bid,
      ask: data.ask,
      timestamp: data.timestamp,
    };
  }

  private buildUnderlyingContract(underlying: string): Contract {
    return {
      symbol: underlying === "SPX" ? "SPX" : underlying,
      secType: underlying === "SPX" ? SecType.IND : SecType.STK,
      exchange: underlying === "SPX" ? "CBOE" : "SMART",
      currency: "USD",
    };
  }
  private async getUnderlyingConId(underlying: string): Promise<number | null> {
    const cached = this.underlyingConIds.get(underlying);
    if (cached && cached > 0) return cached;
    if (!this.connected || !this.ib) return null;
    const reqId = this.getNextReqId();
    const contract = this.buildUnderlyingContract(underlying);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        resolve(null);
      }, 15000);
      this.pendingRequests.set(reqId, {
        resolve: (details: any[]) => {
          const items = Array.isArray(details) ? details : [];
          const conId = items[0]?.contract?.conId || null;
          if (conId && conId > 0) {
            this.underlyingConIds.set(underlying, conId);
            resolve(conId);
            return;
          }
          resolve(null);
        },
        reject: () => resolve(null),
        timeout,
      });
      this.ib!.reqContractDetails(reqId, contract);
    });
  }
  async getOptionChain(underlying: string, type: "call" | "put", minStrike: number, maxStrike: number, expiry: string): Promise<IBKROptionData[]> {
    assertOptionsRuntimeAllowed("ibkr option chain");
    if (!this.connected || !this.ib) return [];

    const reqId = this.getNextReqId();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        resolve([]);
      }, 20000);

      const resolveWithData = (data: any) => resolve(data);
      resolveWithData._data = [];
      this.pendingRequests.set(reqId, { resolve: resolveWithData, reject, timeout });

      // Request option chain parameters
      const contract: Contract = {
        symbol: underlying === "SPX" ? "SPX" : underlying,
        secType: underlying === "SPX" ? SecType.IND : SecType.STK,
        exchange: underlying === "SPX" ? "CBOE" : "SMART",
        currency: "USD",
      };

      void (async () => {
        const underlyingConId = await this.getUnderlyingConId(underlying);
        if (!underlyingConId) {
          clearTimeout(timeout);
          this.pendingRequests.delete(reqId);
          resolve([]);
          return;
        }
        this.ib!.reqSecDefOptParams(reqId, underlying, "", contract.secType as string, underlyingConId);
      })();
    });
  }

  async getOptionSnapshot(underlying: string, type: "call" | "put", strike: number, expiry: string): Promise<IBKROptionData | null> {
    if (!this.connected || !this.ib) return null;

    const reqId = this.getNextReqId();
    const normalizedExpiry = expiry.replace(/-/g, "");
    const chainRows = await this.getOptionChain(underlying, type, 0, 0, normalizedExpiry);
    const validRows = (chainRows as any[]).filter((row: any) =>
      Array.isArray(row?.expirations) && row.expirations.includes(normalizedExpiry) &&
      Array.isArray(row?.strikes) && row.strikes.some((value: number) => typeof value === "number" && value > 0)
    );
    const preferredRows = validRows.filter((row: any) => String(row?.exchange || "").toUpperCase() === "SMART");
    const optionRows = preferredRows.length ? preferredRows : validRows;
    if (!optionRows.length) return null;

    const underlyingPrice = (() => {
      const stock = this.getStockPrice(underlying);
      if (!stock) return 0;
      if (stock.last > 0) return stock.last;
      if (stock.close > 0) return stock.close;
      if (stock.bid > 0 && stock.ask > 0) return Number(((stock.bid + stock.ask) / 2).toFixed(2));
      return stock.bid > 0 ? stock.bid : (stock.ask > 0 ? stock.ask : 0);
    })();

    const availableStrikes = [...new Set(optionRows.flatMap((row: any) => row.strikes || []))]
      .filter((value: any) => typeof value === "number" && value > 0)
      .sort((a: number, b: number) => a - b);
    if (!availableStrikes.length) return null;

    let resolvedStrike = strike > 0 ? strike : 0;
    const strikeExists = resolvedStrike > 0 && availableStrikes.some((value: number) => Math.abs(value - resolvedStrike) < 0.0001);
    if (!strikeExists) {
      const anchorPrice = underlyingPrice > 0 ? underlyingPrice : (resolvedStrike > 0 ? resolvedStrike : 0);
      if (!(anchorPrice > 0)) return null;
      resolvedStrike = [...availableStrikes].sort((a: number, b: number) => Math.abs(a - anchorPrice) - Math.abs(b - anchorPrice))[0];
    }

    const contractRow = optionRows.find((row: any) => Array.isArray(row?.strikes) && row.strikes.some((value: number) => Math.abs(value - resolvedStrike) < 0.0001)) || optionRows[0];
    if (!contractRow) return null;

    const contract: Contract = {
      symbol: underlying,
      secType: SecType.OPT,
      exchange: contractRow.exchange || "SMART",
      currency: "USD",
      lastTradeDateOrContractMonth: normalizedExpiry,
      strike: resolvedStrike,
      right: type === "call" ? "C" : "P",
      multiplier: contractRow.multiplier || "100",
      tradingClass: contractRow.tradingClass || underlying,
    };

    return new Promise((resolve) => {
      let greeks: any = null;
      const finish = () => {
        clearTimeout(timeout);
        this.pendingRequests.delete(reqId);
        try { this.ib!.cancelMktData(reqId); } catch {}
        const priceData = this.stockPrices.get(`OPT_${reqId}`) || { bid: 0, ask: 0, last: 0, volume: 0 };
        const hasPrice = (priceData.bid || 0) > 0 || (priceData.ask || 0) > 0 || (priceData.last || 0) > 0;
        if (!hasPrice && !greeks) {
          resolve(null);
          return;
        }
        resolve({
          ticker: `${underlying}${normalizedExpiry}${type === "call" ? "C" : "P"}${resolvedStrike}`,
          underlying,
          type,
          strike: resolvedStrike,
          expiry: normalizedExpiry,
          bid: priceData.bid || 0,
          ask: priceData.ask || 0,
          mid: priceData.bid && priceData.ask ? (priceData.bid + priceData.ask) / 2 : 0,
          last: priceData.last || 0,
          volume: priceData.volume || 0,
          openInterest: 0,
          delta: greeks?.delta || 0,
          gamma: greeks?.gamma || 0,
          theta: greeks?.theta || 0,
          vega: greeks?.vega || 0,
          iv: greeks?.iv || 0,
          timestamp: Date.now(),
        });
      };

      const timeout = setTimeout(() => finish(), 12000);

      this.pendingRequests.set(reqId, {
        resolve: (data: any) => {
          greeks = data || greeks;
        },
        reject: () => {
          clearTimeout(timeout);
          this.pendingRequests.delete(reqId);
          try { this.ib!.cancelMktData(reqId); } catch {}
          resolve(null);
        },
        timeout,
      });

      this.tickerReqMap.set(reqId, `OPT_${reqId}`);
      this.ib!.reqMktData(reqId, contract, "100,101,104,106", false, false);
    });
  }

  // ======== ORDER EXECUTION ========

  private buildOptionContract(
    underlying: string,
    type: "call" | "put",
    strike: number,
    expiry: string
  ): Contract {
    return {
      symbol: underlying,
      secType: SecType.OPT,
      exchange: "SMART",
      currency: "USD",
      lastTradeDateOrContractMonth: expiry.replace(/-/g, ""),
      strike,
      right: type === "call" ? "C" : "P",
      multiplier: "100",
    } as Contract;
  }

  async placeOrder(
    underlying: string,
    type: "call" | "put",
    strike: number,
    expiry: string,
    action: "BUY" | "SELL",
    quantity: number,
    limitPrice?: number
  ): Promise<IBKROrderResult | null> {
    if (!this.connected || !this.ib) return null;

    const orderId = this.nextOrderId++;
    const contract = this.buildOptionContract(underlying, type, strike, expiry);

    const order: Order = {
      action: action as OrderAction,
      totalQuantity: quantity,
      orderType: limitPrice ? OrderType.LMT : OrderType.MKT,
      lmtPrice: limitPrice,
      tif: "DAY",
      transmit: true,
    };

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(orderId);
        const result = this.orderResults.get(orderId);
        resolve(result || null);
      }, 30000);

      this.pendingRequests.set(orderId, {
        resolve: (result: IBKROrderResult) => resolve(result),
        reject: () => resolve(null),
        timeout,
      });

      console.log(`[IBKR] Placing order: ${action} ${quantity} ${underlying} ${type} ${strike} ${expiry} @ ${limitPrice || 'MKT'}`);
      this.ib!.placeOrder(orderId, contract, order);
    });
  }

  async placeProtectiveStopOrder(
    underlying: string,
    type: "call" | "put",
    strike: number,
    expiry: string,
    quantity: number,
    stopLossPrice: number
  ): Promise<IBKROrderResult | null> {
    if (!this.connected || !this.ib) return null;

    const orderId = this.nextOrderId++;
    const contract = this.buildOptionContract(underlying, type, strike, expiry);
    const order: Order = {
      action: "SELL" as OrderAction,
      totalQuantity: quantity,
      orderType: OrderType.STP,
      auxPrice: stopLossPrice,
      tif: "GTC",
      transmit: true,
    };

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(orderId);
        const result = this.orderResults.get(orderId);
        resolve(result || null);
      }, 30000);

      this.pendingRequests.set(orderId, {
        resolve: (result: IBKROrderResult) => resolve(result),
        reject: () => resolve(null),
        timeout,
      });

      console.log(`[IBKR] Placing protective STP order: SELL ${quantity} ${underlying} ${type.toUpperCase()} ${strike} ${expiry} STOP ${stopLossPrice}`);
      this.ib!.placeOrder(orderId, contract, order);
    });
  }

  async placeBracketOrder(
    underlying: string,
    type: "call" | "put",
    strike: number,
    expiry: string,
    quantity: number,
    entryLimitPrice: number,
    stopLossPrice: number
  ): Promise<IBKROrderResult | null> {
    if (!this.connected || !this.ib) return null;

    const parentOrderId = this.nextOrderId++;
    const stopOrderId = this.nextOrderId++;
    const contract = this.buildOptionContract(underlying, type, strike, expiry);

    const parentOrder: Order = {
      action: "BUY" as OrderAction,
      totalQuantity: quantity,
      orderType: OrderType.LMT,
      lmtPrice: entryLimitPrice,
      tif: "DAY",
      transmit: false,
    };

    const stopOrder: Order = {
      action: "SELL" as OrderAction,
      totalQuantity: quantity,
      orderType: OrderType.STP,
      auxPrice: stopLossPrice,
      tif: "GTC",
      parentId: parentOrderId,
      transmit: true,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(parentOrderId);
        const parentResult = this.orderResults.get(parentOrderId);
        const childResult = this.orderResults.get(stopOrderId);
        resolve(parentResult ? {
          ...parentResult,
          stopOrderId,
          parentStatus: parentResult.parentStatus || parentResult.status,
          childStopStatus: childResult?.status || parentResult.childStopStatus,
        } : null);
      }, 30000);

      this.pendingRequests.set(parentOrderId, {
        resolve: (result: IBKROrderResult) => {
          const childResult = this.orderResults.get(stopOrderId);
          resolve({
            ...result,
            stopOrderId,
            parentStatus: result.parentStatus || result.status,
            childStopStatus: childResult?.status || result.childStopStatus,
          });
        },
        reject: (err: Error & { code?: number; errorMessage?: string; rejectReason?: string; advancedOrderRejectJson?: string }) => {
          const parentResult = this.orderResults.get(parentOrderId);
          const childResult = this.orderResults.get(stopOrderId);
          resolve({
            orderId: parentOrderId,
            status: parentResult?.status || "Rejected",
            filled: parentResult?.filled || 0,
            remaining: parentResult?.remaining ?? quantity,
            avgFillPrice: parentResult?.avgFillPrice || 0,
            lastFillPrice: parentResult?.lastFillPrice || 0,
            stopOrderId,
            permId: parentResult?.permId,
            parentStatus: parentResult?.parentStatus || parentResult?.status || "Rejected",
            childStopStatus: childResult?.status || parentResult?.childStopStatus,
            code: err?.code,
            errorMessage: err?.errorMessage || err?.message || String(err),
            rejectReason: err?.rejectReason || err?.message || String(err),
            advancedOrderRejectJson: err?.advancedOrderRejectJson,
          });
        },
        timeout,
      });

      console.log(`[IBKR] Placing BRACKET order ${parentOrderId}/${stopOrderId}: BUY ${quantity} ${underlying} ${type.toUpperCase()} ${strike} ${expiry} @ ${entryLimitPrice} | STOP ${stopLossPrice}`);
      this.ib!.placeOrder(parentOrderId, contract, parentOrder);
      this.ib!.placeOrder(stopOrderId, contract, stopOrder);
    }).then((result) => {
      if (!result) return null;
      const childResult = this.orderResults.get(stopOrderId);
      return {
        ...result,
        stopOrderId,
        parentStatus: result.parentStatus || result.status,
        childStopStatus: childResult?.status || result.childStopStatus,
      };
    });
  }

  async cancelOrder(orderId: number): Promise<void> {
    if (!this.connected || !this.ib) return;
    this.ib.cancelOrder(orderId);
  }

  // ======== HISTORICAL DATA ========

  async getHistoricalBars(
    ticker: string,
    barSize: string = "5 mins",
    duration: string = "5 D",
    whatToShow: string = "TRADES"
  ): Promise<{ time: number; open: number; high: number; low: number; close: number; volume: number }[]> {
    if (!this.connected || !this.ib) return [];

    const reqId = this.getNextReqId();

    const contract: Contract = {
      symbol: ticker,
      secType: SecType.STK,
      exchange: "SMART",
      currency: "USD",
    };

    // For SPX index
    if (ticker === "SPX") {
      contract.symbol = "SPX";
      contract.secType = SecType.IND;
      contract.exchange = "CBOE";
    }

    // For VIX index
    if (ticker === "VIX") {
      contract.symbol = "VIX";
      contract.secType = SecType.IND;
      contract.exchange = "CBOE";
    }

    return new Promise((resolve) => {
      const bars: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        console.warn(`[IBKR] Historical data timeout for ${ticker} (${bars.length} bars received)`);
        resolve(bars);
      }, 30000);

      // Listen for historical data
      const onHistData = (rId: number, bar: any) => {
        if (rId !== reqId) return;
        if (bar && bar.close !== undefined) {
          bars.push({
            time: typeof bar.time === 'string' ? new Date(bar.time).getTime() / 1000 : bar.time,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume || 0,
          });
        }
      };

      const onHistEnd = (rId: number) => {
        if (rId !== reqId) return;
        clearTimeout(timeout);
        this.pendingRequests.delete(reqId);
        // Remove listeners
        this.ib!.off(EventName.historicalData, onHistData);
        this.ib!.off(EventName.historicalDataEnd, onHistEnd);
        console.log(`[IBKR] Historical data for ${ticker}: ${bars.length} bars`);
        resolve(bars);
      };

      this.ib!.on(EventName.historicalData, onHistData);
      this.ib!.on(EventName.historicalDataEnd, onHistEnd);

      this.pendingRequests.set(reqId, {
        resolve: () => {},
        reject: () => resolve([]),
        timeout,
      });

      // Request historical data
      // Empty endDateTime = current time
      this.ib!.reqHistoricalData(
        reqId,
        contract,
        "", // endDateTime - empty = now
        duration, // durationStr
        barSize, // barSizeSetting
        whatToShow as WhatToShow, // whatToShow
        1, // useRTH (1 = regular trading hours only)
        1, // formatDate
        false // keepUpToDate
      );
    });
  }

  // ======== SPX SPECIFIC ========

  async getSPXPrice(): Promise<number | null> {
    const data = this.stockPrices.get("SPX");
    if (data && data.last > 0) return data.last;

    // If not subscribed yet, subscribe and wait
    await this.subscribeStock("SPX");
    await new Promise(r => setTimeout(r, 3000));

    const updated = this.stockPrices.get("SPX");
    return updated?.last || updated?.close || null;
  }

  async getAccountSummary(): Promise<IBKRAccountSummary | null> {
    if (!this.connected || !this.ib) return null;

    const reqId = this.getNextReqId();
    const tags = "NetLiquidation,TotalCashValue,AvailableFunds,BuyingPower";

    return new Promise((resolve) => {
      const summary: Partial<IBKRAccountSummary> = {
        accountId: this.accountId,
        netLiquidation: 0,
        totalCashValue: 0,
        availableFunds: 0,
        buyingPower: 0,
        currency: "USD",
        timestamp: Date.now(),
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.ib!.off(EventName.accountSummary, onSummary);
        this.ib!.off(EventName.accountSummaryEnd, onEnd);
        try { this.ib!.cancelAccountSummary(reqId); } catch {}
      };

      const finalize = () => {
        const result: IBKRAccountSummary = {
          accountId: String(summary.accountId || this.accountId || ""),
          netLiquidation: Number(summary.netLiquidation || 0),
          totalCashValue: Number(summary.totalCashValue || 0),
          availableFunds: Number(summary.availableFunds || 0),
          buyingPower: Number(summary.buyingPower || 0),
          currency: String(summary.currency || "USD"),
          timestamp: Date.now(),
        };
        this.lastAccountSummary = result;
        cleanup();
        resolve(result);
      };

      const onSummary = (incomingReqId: number, account: string, tag: string, value: string, currency: string) => {
        if (incomingReqId !== reqId) return;
        summary.accountId = account || summary.accountId || this.accountId;
        if (currency) summary.currency = currency;
        const numericValue = Number(value || 0);
        if (tag === "NetLiquidation") summary.netLiquidation = numericValue;
        if (tag === "TotalCashValue") summary.totalCashValue = numericValue;
        if (tag === "AvailableFunds") summary.availableFunds = numericValue;
        if (tag === "BuyingPower") summary.buyingPower = numericValue;
      };

      const onEnd = (incomingReqId: number) => {
        if (incomingReqId !== reqId) return;
        finalize();
      };

      const timeout = setTimeout(finalize, 10000);
      this.ib!.on(EventName.accountSummary, onSummary);
      this.ib!.on(EventName.accountSummaryEnd, onEnd);
      this.ib!.reqAccountSummary(reqId, "All", tags);
    });
  }

  getQuoteSnapshot(ticker: string): (IBKRStockData & { marketDataMode: "live" | "delayed" | "unknown" }) | null {
    const data = this.stockPrices.get(ticker);
    if (!data) return null;
    return {
      ...data,
      marketDataMode: this.tickerFeedModes.get(ticker) || this.latestMarketDataMode,
    };
  }

  getMarketDataMode(): "live" | "delayed" | "unknown" {
    return this.latestMarketDataMode;
  }

  getLastAccountSummary(): IBKRAccountSummary | null {
    return this.lastAccountSummary;
  }

  // ======== STATUS ========

  getStatus(): { connected: boolean; accountId: string; host: string; port: number; subscribedTickers: string[]; marketDataMode: "live" | "delayed" | "unknown"; requestedMarketDataType: "LIVE" | "DELAYED"; lastAccountSummary: IBKRAccountSummary | null } {
    return {
      connected: this.connected,
      accountId: this.accountId,
      host: IBKR_HOST,
      port: IBKR_PORT,
      subscribedTickers: [...new Set(Array.from(this.tickerReqMap.values()).filter(t => !t.startsWith("OPT_")))],
      marketDataMode: this.latestMarketDataMode,
      requestedMarketDataType: IBKR_MARKET_DATA_TYPE_LABEL as "LIVE" | "DELAYED",
      lastAccountSummary: this.lastAccountSummary,
    };
  }
}

// Singleton
export const ibkr = new IBKRClient();

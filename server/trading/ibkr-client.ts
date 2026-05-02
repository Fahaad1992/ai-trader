/**
 * IBKR Client - Connects to IB Gateway via TWS API
 * Uses @stoqey/ib library for real-time market data and order execution
 */
import IB from "ib";
import { assertOptionsRuntimeAllowed, isFuturesMode, isSPXOptionsMode } from "./trade-mode.js";

type IBApi = any;
type Contract = Record<string, any>;
type Order = Record<string, any>;
type OrderAction = "BUY" | "SELL";

type MarketDataMode = "live" | "delayed" | "unknown";

const EventName = {
  connected: "connected",
  disconnected: "disconnected",
  error: "error",
  nextValidId: "nextValidId",
  managedAccounts: "managedAccounts",
  currentTime: "currentTime",
  marketDataType: "marketDataType",
  tickPrice: "tickPrice",
  tickSize: "tickSize",
  tickOptionComputation: "tickOptionComputation",
  orderStatus: "orderStatus",
  contractDetails: "contractDetails",
  contractDetailsEnd: "contractDetailsEnd",
  securityDefinitionOptionParameter: "securityDefinitionOptionParameter",
  securityDefinitionOptionParameterEnd: "securityDefinitionOptionParameterEnd",
  historicalData: "historicalData",
  accountSummary: "accountSummary",
  accountSummaryEnd: "accountSummaryEnd",
} as const;

const SecType = {
  STK: "STK",
  IND: "IND",
  FUT: "FUT",
  OPT: "OPT",
} as const;

const OrderType = {
  LMT: "LMT",
  MKT: "MKT",
  STP: "STP",
} as const;

function parseHistoricalDateToEpochSeconds(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").trim();
  if (!text) return 0;
  if (/^\d{8}$/.test(text)) {
    const year = Number(text.slice(0, 4));
    const month = Number(text.slice(4, 6)) - 1;
    const day = Number(text.slice(6, 8));
    return Math.floor(Date.UTC(year, month, day) / 1000);
  }
  if (/^\d+$/.test(text) && text.length <= 10) return Number(text);
  const normalized = text.replace(/\s{2,}/g, " ");
  const parsed = Date.parse(`${normalized} UTC`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function normalizeMarketDataMode(marketDataType: number): MarketDataMode {
  if (marketDataType === 1) return "live";
  if (marketDataType === 2 || marketDataType === 3 || marketDataType === 4) return "delayed";
  return "unknown";
}

function extractConIdFromContractDetails(details: any): number | null {
  const candidate = details?.contract?.conId ?? details?.summary?.conId ?? details?.conId ?? null;
  return typeof candidate === "number" && candidate > 0 ? candidate : null;
}

function isHistoricalDataFinishedMarker(value: unknown): boolean {
  return String(value ?? "").toLowerCase().startsWith("finished");
}

function isIgnorableIbInfoCode(code: number): boolean {
  return code === 2104 || code === 2106 || code === 2158;
}

function isWarningIbCode(code: number): boolean {
  return code === 2103 || code === 2105;
}

function isRelevantRequestId(reqId: number): boolean {
  return Number.isFinite(reqId) && reqId > 0;
}

function hasEventEmitterOff(target: any): target is { off: (event: string, listener: (...args: any[]) => void) => void } {
  return !!target && typeof target.off === "function";
}

function hasEventEmitterRemoveListener(target: any): target is { removeListener: (event: string, listener: (...args: any[]) => void) => void } {
  return !!target && typeof target.removeListener === "function";
}

function removeListenerSafe(target: any, event: string, listener: (...args: any[]) => void): void {
  if (hasEventEmitterOff(target)) {
    target.off(event, listener);
    return;
  }
  if (hasEventEmitterRemoveListener(target)) {
    target.removeListener(event, listener);
  }
}

function createIbClient(options: { host: string; port: number; clientId: number }): IBApi {
  return new (IB as any)(options);
}

const IBKR_HOST = process.env.IBKR_HOST || "127.0.0.1";
const IBKR_PORT = parseInt(process.env.IBKR_PORT || "4002");
const IBKR_CLIENT_ID = parseInt(process.env.IBKR_CLIENT_ID || "1");
const IBKR_TRADING_MODE = (process.env.IBKR_MODE || process.env.TRADING_MODE || process.env.BOT_MODE || "paper").toLowerCase();
const IBKR_MARKET_DATA_TYPE = (IBKR_TRADING_MODE === "live" || isSPXOptionsMode()) ? 1 : 3;
const IBKR_MARKET_DATA_TYPE_LABEL = IBKR_MARKET_DATA_TYPE === 1 ? "LIVE" : "DELAYED";
const IBKR_MES_SYMBOL = process.env.IBKR_FUTURES_SYMBOL || "/MESM6";
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
  targetOrderId?: number;          // Task B: 3-leg bracket (optional)
  permId?: number;
  parentStatus?: string;
  childStopStatus?: string;
  childTargetStatus?: string;      // Task B: 3-leg bracket (optional)
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
  private connectTime = 0;
  private nextOrderId = 0;
  private accountId = "";
  private reqId = 1000;
  private latestMarketDataMode: MarketDataMode = IBKR_MARKET_DATA_TYPE === 1 ? "unknown" : "delayed";
  private tickerFeedModes = new Map<string, Exclude<MarketDataMode, "unknown">>();
  private lastAccountSummary: IBKRAccountSummary | null = null;
  private connectPromise: Promise<boolean> | null = null;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;

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

  private clearConnectTimeout(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
  }

  private cleanupConnectionState(options: { disconnectSocket?: boolean } = {}): void {
    const { disconnectSocket = false } = options;
    const client = this.ib as (IBApi & { removeAllListeners?: () => void }) | null;

    this.clearConnectTimeout();

    if (client?.removeAllListeners) {
      try { client.removeAllListeners(); } catch {}
    }

    if (disconnectSocket && client) {
      try { client.disconnect(); } catch {}
    }

    for (const [, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      try {
        pending.reject(new Error("[IBKR] Connection lost"));
      } catch {}
    }
    this.pendingRequests.clear();

    this.ib = null;
    this.connected = false;
    this.connecting = false;
    this.connectPromise = null;
    this.accountId = "";
    this.nextOrderId = 0;
    this.latestMarketDataMode = IBKR_MARKET_DATA_TYPE === 1 ? "unknown" : "delayed";
    this.lastAccountSummary = null;
    this.tickerReqMap.clear();
    this.tickerFeedModes.clear();
    this.underlyingConIds.clear();
  }

  async connect(): Promise<boolean> {
    if (this.connected && this.ib) return true;
    if (this.connectPromise) return this.connectPromise;

    if (this.ib) {
      this.cleanupConnectionState({ disconnectSocket: true });
    }

    this.connecting = true;
    console.log(`[IBKR] Connecting to ${IBKR_HOST}:${IBKR_PORT} (clientId: ${IBKR_CLIENT_ID})...`);

    this.connectPromise = new Promise((resolve) => {
      let settled = false;
      const finalize = (ok: boolean) => {
        if (settled) return;
        settled = true;
        this.clearConnectTimeout();
        this.connecting = false;
        this.connectPromise = null;
        resolve(ok);
      };

      try {
        const client = createIbClient({ host: IBKR_HOST, port: IBKR_PORT, clientId: IBKR_CLIENT_ID });
        this.ib = client;

        // Connection events
        client.on(EventName.connected, () => {
          if (this.ib !== client) return;
          console.log("[IBKR] Connected to IB Gateway!");
          this.connected = true;
          this.connectTime = Date.now();
          this.connecting = false;
          this.clearConnectTimeout();
          // Use LIVE market data in live trading, otherwise fall back to DELAYED.
          client.reqMarketDataType(IBKR_MARKET_DATA_TYPE);
          console.log(`[IBKR] Market data type set to ${IBKR_MARKET_DATA_TYPE_LABEL} (${IBKR_MARKET_DATA_TYPE}) for TRADING_MODE=${IBKR_TRADING_MODE}`);
          client.reqCurrentTime();
          client.reqManagedAccts();
          client.reqIds(1);
          finalize(true);
        });

        client.on(EventName.disconnected, () => {
          if (this.ib !== client) return;
          const uptime = this.connected ? Date.now() - (this.connectTime || 0) : 0;
          console.log(`[IBKR] Disconnected from IB Gateway | wasConnected=${this.connected} | uptimeMs=${uptime} | accountId=${this.accountId || "none"} | subscribedTickers=${Array.from(this.tickerReqMap.values()).join(",") || "none"}`);
          const wasConnected = this.connected;
          this.cleanupConnectionState({ disconnectSocket: false });
          if (!wasConnected) finalize(false);
        });

        client.on(EventName.error, (err: Error, data?: { id?: number; code?: number }) => {
          if (this.ib !== client) return;
          const code = Number(data?.code ?? -1);
          const reqId = Number(data?.id ?? -1);
          const errorMessage = err?.message || String(err);
          const msg = `[IBKR] Error: ${errorMessage} (code: ${code}, reqId: ${reqId})`;

          if (isIgnorableIbInfoCode(code)) {
            console.log(`[IBKR] Info: ${errorMessage}`);
          } else if (isWarningIbCode(code)) {
            console.warn(`[IBKR] Warning: ${errorMessage}`);
          } else {
            console.error(msg);
          }

          if (isRelevantRequestId(reqId)) {
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
            });
          }

          const pending = this.pendingRequests.get(reqId);
          if (pending) {
            clearTimeout(pending.timeout);
            const enrichedError = Object.assign(new Error(msg), {
              code,
              reqId,
              errorMessage,
              rejectReason: msg,
            });
            pending.reject(enrichedError);
            this.pendingRequests.delete(reqId);
          }
        });

        client.on(EventName.marketDataType, (reqId: number, marketDataType: number) => {
          if (this.ib !== client) return;
          const mode = normalizeMarketDataMode(marketDataType);
          if (mode !== "unknown") {
            this.latestMarketDataMode = mode;
          }
          const ticker = this.tickerReqMap.get(reqId);
          if (ticker && mode !== "unknown") {
            this.tickerFeedModes.set(ticker, mode);
          }
          console.log(`[IBKR] marketDataType event: reqId=${reqId}, type=${marketDataType}, mode=${mode}`);
        });

        // Next valid order ID
        client.on(EventName.nextValidId, (orderId: number) => {
          if (this.ib !== client) return;
          this.nextOrderId = orderId;
          console.log(`[IBKR] Next valid order ID: ${orderId}`);
        });

        // Managed accounts
        client.on(EventName.managedAccounts, (accountsList: string) => {
          if (this.ib !== client) return;
          this.accountId = accountsList.split(",")[0]?.trim() || "";
          console.log(`[IBKR] Account ID: ${this.accountId}`);
        });

        // Current time
        client.on(EventName.currentTime, (time: number) => {
          if (this.ib !== client) return;
          console.log(`[IBKR] Server time: ${new Date(time * 1000).toISOString()}`);
        });

        // Tick price data
        client.on(EventName.tickPrice, (reqId: number, tickType: number, price: number) => {
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
        client.on(EventName.tickSize, (reqId: number, tickType: number, size: number) => {
          if (this.ib !== client) return;
          const ticker = this.tickerReqMap.get(reqId);
          if (!ticker) return;

          const existing = this.stockPrices.get(ticker);
          if (!existing) return;

          if (tickType === 8) {
            existing.volume = size;
            existing.timestamp = Date.now();
            this.stockPrices.set(ticker, existing);
          }
        });

        // Option computation (greeks)
        client.on(EventName.tickOptionComputation, (reqId: number, tickType: number, impliedVol: number, delta: number, optPrice: number, pvDividend: number, gamma: number, vega: number, theta: number) => {
          if (this.ib !== client) return;
          const pending = this.pendingRequests.get(reqId);
          if (pending && tickType === 13) {
            clearTimeout(pending.timeout);
            pending.resolve({ iv: impliedVol, delta, gamma, vega, theta, optPrice, pvDividend });
            this.pendingRequests.delete(reqId);
          }
        });

        // Order status
        client.on(EventName.orderStatus, (orderId: number, status: string, filled: number, remaining: number, avgFillPrice: number, permId: number, parentId: number, lastFillPrice: number) => {
          if (this.ib !== client) return;
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
        client.on(EventName.contractDetails, (reqId: number, contractDetails: any) => {
          if (this.ib !== client) return;
          const pending = this.pendingRequests.get(reqId);
          if (pending) {
            if (!pending.resolve._data) pending.resolve._data = [];
            pending.resolve._data.push(contractDetails);
          }
        });

        client.on(EventName.contractDetailsEnd, (reqId: number) => {
          if (this.ib !== client) return;
          const pending = this.pendingRequests.get(reqId);
          if (pending) {
            clearTimeout(pending.timeout);
            pending.resolve(pending.resolve._data || []);
            this.pendingRequests.delete(reqId);
          }
        });

        // Security definition option parameters
        client.on(EventName.securityDefinitionOptionParameter, (reqId: number, exchange: string, underlyingConId: number, tradingClass: string, multiplier: string, expirations: string[], strikes: number[]) => {
          if (this.ib !== client) return;
          const pending = this.pendingRequests.get(reqId);
          if (pending) {
            if (!pending.resolve._data) pending.resolve._data = [];
            pending.resolve._data.push({ exchange, underlyingConId, tradingClass, multiplier, expirations, strikes });
          }
        });

        client.on(EventName.securityDefinitionOptionParameterEnd, (reqId: number) => {
          if (this.ib !== client) return;
          const pending = this.pendingRequests.get(reqId);
          if (pending) {
            clearTimeout(pending.timeout);
            pending.resolve(pending.resolve._data || []);
            this.pendingRequests.delete(reqId);
          }
        });

        // Connect
        client.connect();

        // Timeout
        this.connectTimeout = setTimeout(() => {
          if (this.ib !== client || this.connected) return;
          console.error("[IBKR] Connection timeout after 15s");
          this.cleanupConnectionState({ disconnectSocket: true });
          finalize(false);
        }, 15000);

      } catch (err: any) {
        console.error(`[IBKR] Connection error: ${err.message}`);
        this.cleanupConnectionState({ disconnectSocket: true });
        finalize(false);
      }
    });

    return this.connectPromise;
  }

  disconnect() {
    this.cleanupConnectionState({ disconnectSocket: true });
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
    // For VIX index
    if (ticker === "VIX") {
      contract.symbol = "VIX";
      contract.secType = SecType.IND;
      contract.exchange = "CBOE";
    }

    this.ib.reqMktData(reqId, contract, "", false, false);
    console.log(`[IBKR] Subscribed to ${ticker} market data (reqId: ${reqId})`);
  }

  getStockPrice(ticker: string): IBKRStockData | null {
    return this.stockPrices.get(ticker) || null;
  }

  private buildMesFutureContract(tastytradeSymbol: string = IBKR_MES_SYMBOL): Contract {
    const parsed = parseMesTastytradeSymbol(tastytradeSymbol);
    const localSymbol = `${parsed.symbol}${parsed.monthCode}${String(parsed.year % 10)}`;
    return {
      symbol: parsed.symbol,
      secType: SecType.FUT,
      exchange: MES_FUTURES_EXCHANGE,
      currency: "USD",
      tradingClass: parsed.symbol,
      lastTradeDateOrContractMonth: `${parsed.year}${parsed.contractMonth}`,
      localSymbol,
    };
  }

  async subscribeMesFuture(tastytradeSymbol: string = IBKR_MES_SYMBOL): Promise<void> {
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

  getMesFuturePrice(tastytradeSymbol: string = IBKR_MES_SYMBOL): Pick<IBKRStockData, "ticker" | "last" | "bid" | "ask" | "timestamp"> | null {
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
          const conId = extractConIdFromContractDetails(items[0]);
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

  // ============================================================
  // FUTURES PATH (MES) — added by fut4steps patch
  // Contract: secType=FUT, exchange=CME, symbol=MES, currency=USD,
  //           multiplier=5, lastTradeDateOrContractMonth=YYYYMM
  // ============================================================
  private buildFuturesContract(
    symbol: string,
    contractMonth: string,
  ): Contract {
    if (isSPXOptionsMode()) {
      throw new Error("[MES_FUTURES_DISABLED_SPX_ONLY] buildFuturesContract blocked: SPX Options mode does not use FUT contracts");
    }
    return {
      symbol,
      secType: SecType.FUT,
      exchange: "CME",
      currency: "USD",
      lastTradeDateOrContractMonth: contractMonth,
      multiplier: "5",
    } as Contract;
  }
  /**
   * Place a 3-leg bracket order on a CME futures contract (e.g. MES).
   * - parent: BUY LMT @ entryLimitPrice (transmit=false)
   * - target: SELL LMT @ targetPrice    (transmit=false, parentId=parent)
   * - stop  : SELL STP @ stopLossPrice  (transmit=true,  parentId=parent)
   *
   * NOTE: This function NEVER builds or sends an option contract. It refuses to
   * proceed if symbol is empty or contractMonth is malformed.
   */
  async placeFuturesBracket(
    symbol: string,
    contractMonth: string,
    quantity: number,
    entryLimitPrice: number,
    stopLossPrice: number,
    targetPrice?: number,
  ): Promise<IBKROrderResult | null> {
    if (isSPXOptionsMode()) {
      console.warn("[MES_FUTURES_DISABLED_SPX_ONLY] placeFuturesBracket blocked: SPX Options mode does not use FUT bracket orders");
      return { orderId: -1, status: "Rejected", filled: 0, remaining: 0, avgFillPrice: 0, lastFillPrice: 0, rejectReason: "MES_FUTURES_DISABLED_SPX_ONLY", errorMessage: "placeFuturesBracket blocked in SPX Options mode" } as IBKROrderResult;
    }
    if (!this.connected || !this.ib) return null;
    if (!symbol || typeof symbol !== "string") {
      console.warn("[FUT_BRACKET] aborted: missing symbol");
      return null;
    }
    if (!/^[0-9]{6}$/.test(String(contractMonth || ""))) {
      console.warn(`[FUT_BRACKET] aborted: invalid contractMonth=${contractMonth}`);
      return null;
    }
    if (!(quantity > 0) || !(entryLimitPrice > 0) || !(stopLossPrice > 0)) {
      console.warn(`[FUT_BRACKET] aborted: bad args qty=${quantity} entry=${entryLimitPrice} stop=${stopLossPrice}`);
      return null;
    }
    const useTarget = typeof targetPrice === "number" && isFinite(targetPrice) && targetPrice > 0;
    const parentOrderId = this.nextOrderId++;
    const targetOrderId = useTarget ? this.nextOrderId++ : undefined;
    const stopOrderId = this.nextOrderId++;
    const contract = this.buildFuturesContract(symbol, contractMonth);
    // Hard sanity check on built contract
    if (contract.secType !== SecType.FUT || contract.exchange !== "CME" || contract.symbol !== symbol) {
      console.warn(`[FUT_BRACKET] aborted: contract sanity failed ${JSON.stringify(contract)}`);
      return null;
    }
    const parentOrder: Order = {
      action: "BUY" as OrderAction,
      totalQuantity: quantity,
      orderType: OrderType.LMT,
      lmtPrice: entryLimitPrice,
      tif: "DAY",
      transmit: false,
    };
    const targetOrder: Order | null = useTarget ? {
      action: "SELL" as OrderAction,
      totalQuantity: quantity,
      orderType: OrderType.LMT,
      lmtPrice: targetPrice!,
      tif: "GTC",
      parentId: parentOrderId,
      transmit: false,
    } : null;
    const stopOrder: Order = {
      action: "SELL" as OrderAction,
      totalQuantity: quantity,
      orderType: OrderType.STP,
      auxPrice: stopLossPrice,
      tif: "GTC",
      parentId: parentOrderId,
      transmit: true,
    };
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(parentOrderId);
        const parentResult = this.orderResults.get(parentOrderId);
        const stopResult = this.orderResults.get(stopOrderId);
        const targetResult = targetOrderId !== undefined ? this.orderResults.get(targetOrderId) : undefined;
        resolve(parentResult ? {
          ...parentResult,
          stopOrderId,
          targetOrderId,
          parentStatus: parentResult.parentStatus || parentResult.status,
          childStopStatus: stopResult?.status || parentResult.childStopStatus,
          childTargetStatus: targetResult?.status,
        } : null);
      }, 30000);
      this.pendingRequests.set(parentOrderId, {
        resolve: (result: IBKROrderResult) => {
          const stopResult = this.orderResults.get(stopOrderId);
          const targetResult = targetOrderId !== undefined ? this.orderResults.get(targetOrderId) : undefined;
          resolve({
            ...result,
            stopOrderId,
            targetOrderId,
            parentStatus: result.parentStatus || result.status,
            childStopStatus: stopResult?.status || result.childStopStatus,
            childTargetStatus: targetResult?.status,
          });
        },
        reject: (err: Error & { code?: number; errorMessage?: string; rejectReason?: string; advancedOrderRejectJson?: string }) => {
          const parentResult = this.orderResults.get(parentOrderId);
          const stopResult = this.orderResults.get(stopOrderId);
          const targetResult = targetOrderId !== undefined ? this.orderResults.get(targetOrderId) : undefined;
          resolve({
            orderId: parentOrderId,
            status: parentResult?.status || "Rejected",
            filled: parentResult?.filled || 0,
            remaining: parentResult?.remaining ?? quantity,
            avgFillPrice: parentResult?.avgFillPrice || 0,
            lastFillPrice: parentResult?.lastFillPrice || 0,
            stopOrderId,
            targetOrderId,
            permId: parentResult?.permId,
            parentStatus: parentResult?.parentStatus || parentResult?.status || "Rejected",
            childStopStatus: stopResult?.status || parentResult?.childStopStatus,
            childTargetStatus: targetResult?.status,
            code: err?.code,
            errorMessage: err?.errorMessage || err?.message || String(err),
            rejectReason: err?.rejectReason || err?.message || String(err),
            advancedOrderRejectJson: err?.advancedOrderRejectJson,
          } as IBKROrderResult);
        },
        timeout,
      });
      const legsLog = useTarget
        ? `FUT_BRACKET3 ${parentOrderId}/${targetOrderId}/${stopOrderId}: BUY ${quantity} ${symbol} FUT ${contractMonth} @ ${entryLimitPrice} | TARGET ${targetPrice} | STOP ${stopLossPrice}`
        : `FUT_BRACKET2 ${parentOrderId}/${stopOrderId}: BUY ${quantity} ${symbol} FUT ${contractMonth} @ ${entryLimitPrice} | STOP ${stopLossPrice}`;
      console.log(`[IBKR] Placing ${legsLog}`);
      this.ib!.placeOrder(parentOrderId, contract, parentOrder);
      if (targetOrder && targetOrderId !== undefined) {
        this.ib!.placeOrder(targetOrderId, contract, targetOrder);
      }
      this.ib!.placeOrder(stopOrderId, contract, stopOrder);
    });
  }
  /**
   * Build an option contract (SMART, OPT). KEPT for options mode.
   */
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

  /**
   * Modify a working futures STP order in-place (same orderId).
   * IBKR/CME accepts re-issuing placeOrder with the existing orderId
   * to update auxPrice. Returns true on Submitted/PreSubmitted ACK.
   */
  async modifyFuturesStopPrice(
    stopOrderId: number,
    symbol: string,
    contractMonth: string,
    side: "LONG" | "SHORT",
    quantity: number,
    newAuxPrice: number,
  ): Promise<{ ok: boolean; status: string; permId?: number; reason?: string }> {
    if (!this.connected || !this.ib) return { ok: false, status: "not_connected", reason: "ibkr_not_connected" };
    if (!stopOrderId || stopOrderId <= 0) return { ok: false, status: "bad_id", reason: "missing_stopOrderId" };
    if (!/^[0-9]{6}$/.test(String(contractMonth || ""))) return { ok: false, status: "bad_month", reason: "invalid_contractMonth" };
    if (!(quantity > 0) || !(newAuxPrice > 0)) return { ok: false, status: "bad_args", reason: "bad_qty_or_price" };
    const contract = this.buildFuturesContract(symbol, contractMonth);
    if (contract.secType !== SecType.FUT || contract.exchange !== "CME") {
      return { ok: false, status: "bad_contract", reason: "contract_sanity_failed" };
    }
    const action: OrderAction = (side === "LONG" ? "SELL" : "BUY") as OrderAction;
    const order: Order = {
      action,
      totalQuantity: quantity,
      orderType: OrderType.STP,
      auxPrice: newAuxPrice,
      tif: "GTC",
      transmit: true,
    };
    return await new Promise((resolve) => {
      const done = (res: any) => { try { resolve(res); } catch {} };
      const t = setTimeout(() => done({ ok: false, status: "timeout", reason: "modify_ack_timeout" }), 8000);
      try {
        (this.pendingRequests as any).set(stopOrderId, {
          resolve: (r: IBKROrderResult) => {
            clearTimeout(t);
            const st = String(r?.status || "").toLowerCase();
            const ok = ["submitted", "presubmitted", "accepted"].some(s => st.includes(s));
            done({ ok, status: r?.status || "unknown", permId: r?.permId });
          },
          reject: (e: any) => {
            clearTimeout(t);
            done({ ok: false, status: e?.status || "rejected", reason: e?.errorMessage || e?.message || "modify_rejected" });
          },
        });
        this.ib!.placeOrder(stopOrderId, contract, order);
      } catch (e: any) {
        clearTimeout(t);
        done({ ok: false, status: "exception", reason: e?.message || String(e) });
      }
    });
  }

  async placeBracketOrder(
    underlying: string,
    type: "call" | "put",
    strike: number,
    expiry: string,
    quantity: number,
    entryLimitPrice: number,
    stopLossPrice: number,
    targetPrice?: number                      // Task B: optional 3-leg bracket
  ): Promise<IBKROrderResult | null> {
    // STEP 2 GUARD: refuse OPT bracket while tradeMode=futures
    if (isFuturesMode()) {
      const msg = `[OPT_BLOCKED_IN_FUTURES] placeBracketOrder refused: tradeMode=futures, would send OPT contract`;
      console.warn(msg);
      return {
        orderId: -1,
        status: "Rejected",
        filled: 0,
        remaining: 0,
        avgFillPrice: 0,
        lastFillPrice: 0,
        rejectReason: "OPT_BLOCKED_IN_FUTURES",
        errorMessage: msg,
      } as IBKROrderResult;
    }
    if (!this.connected || !this.ib) return null;

    const useTarget = typeof targetPrice === "number" && isFinite(targetPrice) && targetPrice > 0;
    const parentOrderId = this.nextOrderId++;
    const targetOrderId = useTarget ? this.nextOrderId++ : undefined;
    const stopOrderId = this.nextOrderId++;
    const contract = this.buildOptionContract(underlying, type, strike, expiry);

    // Parent BUY LMT — staged, will transmit with the LAST child.
    const parentOrder: Order = {
      action: "BUY" as OrderAction,
      totalQuantity: quantity,
      orderType: OrderType.LMT,
      lmtPrice: entryLimitPrice,
      tif: "DAY",
      transmit: false,
    };

    // Target child SELL LMT (only when useTarget). transmit=false so stop leg below
    // is the one that finalises the 3-leg transmission.
    const targetOrder: Order | null = useTarget ? {
      action: "SELL" as OrderAction,
      totalQuantity: quantity,
      orderType: OrderType.LMT,
      lmtPrice: targetPrice!,
      tif: "GTC",
      parentId: parentOrderId,
      transmit: false,
    } : null;

    // Stop child SELL STP — LAST child, transmit=true triggers full send.
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
        const stopResult = this.orderResults.get(stopOrderId);
        const targetResult = targetOrderId !== undefined ? this.orderResults.get(targetOrderId) : undefined;
        resolve(parentResult ? {
          ...parentResult,
          stopOrderId,
          targetOrderId,
          parentStatus: parentResult.parentStatus || parentResult.status,
          childStopStatus: stopResult?.status || parentResult.childStopStatus,
          childTargetStatus: targetResult?.status,
        } : null);
      }, 30000);

      this.pendingRequests.set(parentOrderId, {
        resolve: (result: IBKROrderResult) => {
          const stopResult = this.orderResults.get(stopOrderId);
          const targetResult = targetOrderId !== undefined ? this.orderResults.get(targetOrderId) : undefined;
          resolve({
            ...result,
            stopOrderId,
            targetOrderId,
            parentStatus: result.parentStatus || result.status,
            childStopStatus: stopResult?.status || result.childStopStatus,
            childTargetStatus: targetResult?.status,
          });
        },
        reject: (err: Error & { code?: number; errorMessage?: string; rejectReason?: string; advancedOrderRejectJson?: string }) => {
          const parentResult = this.orderResults.get(parentOrderId);
          const stopResult = this.orderResults.get(stopOrderId);
          const targetResult = targetOrderId !== undefined ? this.orderResults.get(targetOrderId) : undefined;
          resolve({
            orderId: parentOrderId,
            status: parentResult?.status || "Rejected",
            filled: parentResult?.filled || 0,
            remaining: parentResult?.remaining ?? quantity,
            avgFillPrice: parentResult?.avgFillPrice || 0,
            lastFillPrice: parentResult?.lastFillPrice || 0,
            stopOrderId,
            targetOrderId,
            permId: parentResult?.permId,
            parentStatus: parentResult?.parentStatus || parentResult?.status || "Rejected",
            childStopStatus: stopResult?.status || parentResult?.childStopStatus,
            childTargetStatus: targetResult?.status,
            code: err?.code,
            errorMessage: err?.errorMessage || err?.message || String(err),
            rejectReason: err?.rejectReason || err?.message || String(err),
            advancedOrderRejectJson: err?.advancedOrderRejectJson,
          });
        },
        timeout,
      });

      const legsLog = useTarget
        ? `BRACKET3 ${parentOrderId}/${targetOrderId}/${stopOrderId}: BUY ${quantity} ${underlying} ${type.toUpperCase()} ${strike} ${expiry} @ ${entryLimitPrice} | TARGET ${targetPrice} | STOP ${stopLossPrice}`
        : `BRACKET2 ${parentOrderId}/${stopOrderId}: BUY ${quantity} ${underlying} ${type.toUpperCase()} ${strike} ${expiry} @ ${entryLimitPrice} | STOP ${stopLossPrice}`;
      console.log(`[IBKR] Placing ${legsLog}`);
      this.ib!.placeOrder(parentOrderId, contract, parentOrder);
      if (targetOrder && targetOrderId !== undefined) {
        this.ib!.placeOrder(targetOrderId, contract, targetOrder);
      }
      this.ib!.placeOrder(stopOrderId, contract, stopOrder);
    }).then((result) => {
      if (!result) return null;
      const stopResult = this.orderResults.get(stopOrderId);
      const targetResult = targetOrderId !== undefined ? this.orderResults.get(targetOrderId) : undefined;
      return {
        ...result,
        stopOrderId,
        targetOrderId,
        parentStatus: result.parentStatus || result.status,
        childStopStatus: stopResult?.status || result.childStopStatus,
        childTargetStatus: targetResult?.status,
      };
    });
  }

  async cancelOrder(orderId: number): Promise<void> {
    if (!this.connected || !this.ib) return;
    this.ib.cancelOrder(orderId);
  }

  // ============================================================
  // TASK C: modifyStopOrder — tighten / move an existing STP child
  // ------------------------------------------------------------
  // Limitation: this wrapper cannot guarantee IBKR-side "modify" semantics
  // without knowing the exact contract + parentId + original tif used when
  // the stop was first placed. We therefore only invoke placeOrder with the
  // SAME orderId (IB TWS API convention for modify) and rely on the state
  // machine to reflect the change. If the underlying ib client rejects this
  // pattern we return a PENDING_MODIFY_STOP_REPLACE_AUDIT status rather than
  // invent a cancel+replace path.
  // ============================================================
  async modifyStopOrder(
    stopOrderId: number,
    newStopPrice: number,
    parentOrderId: number,
    contract: Contract,
    quantity: number
  ): Promise<{ ok: boolean; status: string; detail: string }> {
    if (!this.connected || !this.ib) {
      return { ok: false, status: "NOT_CONNECTED", detail: "IBKR not connected" };
    }
    if (typeof stopOrderId !== "number" || !isFinite(stopOrderId)) {
      return { ok: false, status: "BAD_STOP_ID", detail: `stopOrderId=${stopOrderId}` };
    }
    if (!isFinite(newStopPrice) || newStopPrice <= 0) {
      return { ok: false, status: "BAD_PRICE", detail: `newStopPrice=${newStopPrice}` };
    }
    try {
      const modified: Order = {
        action: "SELL" as OrderAction,
        totalQuantity: quantity,
        orderType: OrderType.STP,
        auxPrice: newStopPrice,
        tif: "GTC",
        parentId: parentOrderId,
        transmit: true,
      };
      this.ib.placeOrder(stopOrderId, contract, modified);
      console.log(`[IBKR] modifyStopOrder id=${stopOrderId} newStop=${newStopPrice} parent=${parentOrderId}`);
      return { ok: true, status: "MODIFY_SUBMITTED", detail: `id=${stopOrderId} price=${newStopPrice}` };
    } catch (e: any) {
      return { ok: false, status: "PENDING_MODIFY_STOP_REPLACE_AUDIT", detail: e?.message || String(e) };
    }
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
    const isMesHistorical = ticker === "MES" || ticker === IBKR_MES_SYMBOL || String(ticker).startsWith("/MES");

    const contract: Contract = (() => {
      if (isMesHistorical) {
        return this.buildMesFutureContract(ticker === "MES" ? IBKR_MES_SYMBOL : ticker);
      }
      const base: Contract = {
        symbol: ticker,
        secType: SecType.STK,
        exchange: "SMART",
        currency: "USD",
      };
      if (ticker === "SPX") {
        base.symbol = "SPX";
        base.secType = SecType.IND;
        base.exchange = "CBOE";
      }
      if (ticker === "VIX") {
        base.symbol = "VIX";
        base.secType = SecType.IND;
        base.exchange = "CBOE";
      }
      return base;
    })();

    return new Promise((resolve) => {
      const bars: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        console.warn(`[IBKR] Historical data timeout for ${ticker} (${bars.length} bars received)`);
        resolve(bars);
      }, 30000);

      const finalizeHistorical = () => {
        clearTimeout(timeout);
        this.pendingRequests.delete(reqId);
        removeListenerSafe(this.ib, EventName.historicalData, onHistData);
        console.log(`[IBKR] Historical data for ${ticker}: ${bars.length} bars`);
        resolve(bars);
      };

      // Listen for historical data
      const onHistData = (rId: number, date: unknown, open: number, high: number, low: number, close: number, volume: number) => {
        if (rId !== reqId) return;
        if (isHistoricalDataFinishedMarker(date)) {
          finalizeHistorical();
          return;
        }
        if (close !== undefined) {
          bars.push({
            time: parseHistoricalDateToEpochSeconds(date),
            open,
            high,
            low,
            close,
            volume: volume || 0,
          });
        }
      };

      this.ib!.on(EventName.historicalData, onHistData);

      this.pendingRequests.set(reqId, {
        resolve: () => {},
        reject: () => resolve([]),
        timeout,
      });

      // Request historical data
      // Empty endDateTime = current time
      const useRTH = isMesHistorical ? 0 : 1;
      this.ib!.reqHistoricalData(
        reqId,
        contract,
        "", // endDateTime - empty = now
        duration, // durationStr
        barSize,
        whatToShow,
        useRTH,
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

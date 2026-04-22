import { IBApi, EventName, SecType } from "@stoqey/ib";

const host = process.env.IBKR_HOST || "127.0.0.1";
const port = Number(process.env.IBKR_PORT || "4001");
const clientId = Number(process.env.IBKR_PROBE_CLIENT_ID || "91");
const tastytradeSymbol = (process.env.IBKR_FUTURES_SYMBOL || "/MESM6").toUpperCase();

const MONTH_MAP = { H: "03", M: "06", U: "09", Z: "12" };
function inferYear(singleDigitYear) {
  const currentYear = new Date().getUTCFullYear();
  const decadeBase = Math.floor(currentYear / 10) * 10;
  let inferredYear = decadeBase + singleDigitYear;
  if (inferredYear < currentYear - 5) inferredYear += 10;
  if (inferredYear > currentYear + 5) inferredYear -= 10;
  return inferredYear;
}
function buildMesContract(symbol) {
  const match = /^\/MES([HMUZ])(\d)$/.exec(String(symbol || "").trim().toUpperCase());
  if (!match) throw new Error(`Unsupported MES symbol: ${symbol}`);
  const monthCode = match[1];
  const year = inferYear(Number(match[2]));
  return {
    symbol: "MES",
    secType: SecType.FUT,
    exchange: "CME",
    currency: "USD",
    lastTradeDateOrContractMonth: `${year}${MONTH_MAP[monthCode]}`,
    multiplier: "5",
  };
}
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout:${label}`)), ms)),
  ]);
}
const state = {
  connected: false,
  accountId: "",
  marketDataMode: "unknown",
  requestedMarketDataType: "LIVE",
  quote: { ticker: tastytradeSymbol, last: 0, bid: 0, ask: 0, timestamp: 0 },
  accountSummary: { accountId: "", netLiquidation: 0, totalCashValue: 0, availableFunds: 0, buyingPower: 0, currency: "USD", timestamp: 0 },
  errors: [],
};
const ib = new IBApi({ host, port, clientId });
function finish(code) {
  try { ib.disconnect(); } catch {}
  process.exit(code);
}
function onceConnected() {
  return new Promise((resolve, reject) => {
    const onConnected = () => {
      cleanup();
      state.connected = true;
      resolve(true);
    };
    const onError = (err, code) => {
      state.errors.push({ stage: "connect", code, message: String(err) });
    };
    const cleanup = () => {
      ib.off(EventName.connected, onConnected);
      ib.off(EventName.error, onError);
    };
    ib.on(EventName.connected, onConnected);
    ib.on(EventName.error, onError);
  });
}
function getAccountSummary() {
  return new Promise((resolve) => {
    const reqId = 8101;
    const tags = "NetLiquidation,TotalCashValue,AvailableFunds,BuyingPower";
    const cleanup = () => {
      clearTimeout(timer);
      ib.off(EventName.accountSummary, onSummary);
      ib.off(EventName.accountSummaryEnd, onEnd);
      try { ib.cancelAccountSummary(reqId); } catch {}
    };
    const finalize = () => {
      cleanup();
      state.accountSummary.timestamp = Date.now();
      resolve({ ...state.accountSummary });
    };
    const onSummary = (incomingReqId, account, tag, value, currency) => {
      if (incomingReqId !== reqId) return;
      state.accountSummary.accountId = account || state.accountId || "";
      state.accountSummary.currency = currency || state.accountSummary.currency || "USD";
      const numericValue = Number(value || 0);
      if (tag === "NetLiquidation") state.accountSummary.netLiquidation = numericValue;
      if (tag === "TotalCashValue") state.accountSummary.totalCashValue = numericValue;
      if (tag === "AvailableFunds") state.accountSummary.availableFunds = numericValue;
      if (tag === "BuyingPower") state.accountSummary.buyingPower = numericValue;
    };
    const onEnd = (incomingReqId) => {
      if (incomingReqId !== reqId) return;
      finalize();
    };
    const timer = setTimeout(finalize, 10000);
    ib.on(EventName.accountSummary, onSummary);
    ib.on(EventName.accountSummaryEnd, onEnd);
    ib.reqAccountSummary(reqId, "All", tags);
  });
}
function getMesQuote() {
  return new Promise((resolve) => {
    const reqId = 8102;
    const contract = buildMesContract(tastytradeSymbol);
    const delayedTickTypes = new Set([66, 67, 68, 72, 73, 75, 76]);
    const liveTickTypes = new Set([1, 2, 4, 6, 7, 9, 14]);
    const cleanup = () => {
      clearTimeout(timer);
      ib.off(EventName.tickPrice, onTickPrice);
      ib.off(EventName.error, onError);
      try { ib.cancelMktData(reqId); } catch {}
    };
    const finalize = () => {
      cleanup();
      resolve({ ...state.quote, marketDataMode: state.marketDataMode });
    };
    const onTickPrice = (incomingReqId, tickType, price) => {
      if (incomingReqId !== reqId || !(price > 0)) return;
      if (delayedTickTypes.has(tickType)) state.marketDataMode = "delayed";
      if (liveTickTypes.has(tickType) && state.marketDataMode !== "delayed") state.marketDataMode = "live";
      if (tickType === 1 || tickType === 66) state.quote.bid = price;
      if (tickType === 2 || tickType === 67) state.quote.ask = price;
      if (tickType === 4 || tickType === 68) state.quote.last = price;
      state.quote.timestamp = Date.now();
      if (state.quote.last > 0 || state.quote.bid > 0 || state.quote.ask > 0) finalize();
    };
    const onError = (err, code, incomingReqId) => {
      if (incomingReqId !== reqId) return;
      state.errors.push({ stage: "quote", code, message: String(err) });
    };
    const timer = setTimeout(finalize, 12000);
    ib.on(EventName.tickPrice, onTickPrice);
    ib.on(EventName.error, onError);
    try { ib.reqMarketDataType(1); } catch {}
    ib.reqMktData(reqId, contract, "", false, false);
  });
}
(async () => {
  try {
    ib.on(EventName.managedAccounts, (accounts) => {
      if (typeof accounts === "string" && accounts.trim()) state.accountId = accounts.trim().split(",")[0];
      if (Array.isArray(accounts) && accounts.length) state.accountId = String(accounts[0]);
      if (!state.accountSummary.accountId && state.accountId) state.accountSummary.accountId = state.accountId;
    });
    ib.on(EventName.error, (err, code, reqId) => {
      state.errors.push({ stage: "general", code, reqId, message: String(err) });
    });
    ib.connect();
    await withTimeout(onceConnected(), 15000, "connect");
    ib.reqManagedAccts();
    try { ib.reqMarketDataType(1); } catch {}
    await new Promise((r) => setTimeout(r, 1500));
    await withTimeout(getAccountSummary(), 12000, "account_summary");
    const quote = await withTimeout(getMesQuote(), 15000, "mes_quote");
    console.log(JSON.stringify({
      ok: true,
      host,
      port,
      connected: state.connected,
      accountId: state.accountId,
      requestedMarketDataType: state.requestedMarketDataType,
      marketDataMode: state.marketDataMode,
      accountSummary: state.accountSummary,
      quote,
      notableErrors: state.errors.filter((e) => ![2104, 2106, 2158].includes(Number(e.code))).slice(-20),
    }, null, 2));
    finish(0);
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      host,
      port,
      connected: state.connected,
      accountId: state.accountId,
      requestedMarketDataType: state.requestedMarketDataType,
      marketDataMode: state.marketDataMode,
      accountSummary: state.accountSummary,
      quote: state.quote,
      errors: state.errors.slice(-20),
      failure: String(error?.message || error),
    }, null, 2));
    finish(1);
  }
})();

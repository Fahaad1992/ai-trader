import { IBApi, EventName, SecType } from "@stoqey/ib";

const host = process.env.IBKR_HOST || "127.0.0.1";
const port = Number(process.env.IBKR_PORT || 4002);
const clientId = Number(process.env.IBKR_CLIENT_ID || 91);
const underlying = process.env.UNDERLYING || "SPY";

const ib = new IBApi({ host, port, clientId });

const state = {
  connected: false,
  errors: [],
  accountId: null,
  stock: { bid: 0, ask: 0, last: 0, close: 0 },
  contract: null,
  optionRows: [],
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function finish(code = 0) {
  try { ib.disconnect(); } catch {}
  process.exit(code);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout:${label}`)), ms)),
  ]);
}

function onceConnected() {
  return new Promise((resolve, reject) => {
    ib.once(EventName.connected, () => {
      state.connected = true;
      resolve(true);
    });
    ib.once(EventName.error, (err, code) => {
      state.errors.push({ stage: "connect", code, message: String(err) });
      if (!state.connected) reject(new Error(`connect_error:${code || "unknown"}`));
    });
  });
}

function getUnderlyingContract() {
  return new Promise((resolve, reject) => {
    const reqId = 7001;
    const contract = {
      symbol: underlying,
      secType: SecType.STK,
      exchange: "SMART",
      currency: "USD",
    };

    const onDetails = (incomingReqId, details) => {
      if (incomingReqId !== reqId) return;
      state.contract = details?.contract ?? null;
    };
    const onEnd = (incomingReqId) => {
      if (incomingReqId !== reqId) return;
      cleanup();
      if (state.contract?.conId) resolve(state.contract);
      else reject(new Error("underlying_contract_not_found"));
    };
    const onError = (err, code, incomingReqId) => {
      if (incomingReqId !== reqId) return;
      state.errors.push({ stage: "contract", code, message: String(err) });
    };
    const cleanup = () => {
      ib.off(EventName.contractDetails, onDetails);
      ib.off(EventName.contractDetailsEnd, onEnd);
      ib.off(EventName.error, onError);
    };

    ib.on(EventName.contractDetails, onDetails);
    ib.on(EventName.contractDetailsEnd, onEnd);
    ib.on(EventName.error, onError);
    ib.reqContractDetails(reqId, contract);
  });
}

function getStockQuote() {
  return new Promise((resolve) => {
    const reqId = 7002;
    const contract = {
      symbol: underlying,
      secType: SecType.STK,
      exchange: "SMART",
      currency: "USD",
    };

    const finalize = () => {
      cleanup();
      try { ib.cancelMktData(reqId); } catch {}
      resolve({ ...state.stock });
    };
    const cleanup = () => {
      clearTimeout(timer);
      ib.off(EventName.tickPrice, onTickPrice);
      ib.off(EventName.error, onError);
    };
    const onTickPrice = (incomingReqId, tickType, price) => {
      if (incomingReqId !== reqId) return;
      if (tickType === 1) state.stock.bid = price || state.stock.bid;      // BID
      if (tickType === 2) state.stock.ask = price || state.stock.ask;      // ASK
      if (tickType === 4) state.stock.last = price || state.stock.last;    // LAST
      if (tickType === 9) state.stock.close = price || state.stock.close;  // CLOSE
      if (state.stock.last > 0 || state.stock.bid > 0 || state.stock.ask > 0 || state.stock.close > 0) {
        finalize();
      }
    };
    const onError = (err, code, incomingReqId) => {
      if (incomingReqId !== reqId) return;
      state.errors.push({ stage: "stock", code, message: String(err) });
    };
    const timer = setTimeout(finalize, 12000);

    ib.on(EventName.tickPrice, onTickPrice);
    ib.on(EventName.error, onError);
    try { ib.reqMarketDataType(3); } catch {}
    ib.reqMktData(reqId, contract, "", false, false);
  });
}

function getOptionChain() {
  return new Promise((resolve, reject) => {
    const reqId = 7003;
    state.optionRows = [];

    const cleanup = () => {
      clearTimeout(timer);
      ib.off(EventName.securityDefinitionOptionParameter, onParam);
      ib.off(EventName.securityDefinitionOptionParameterEnd, onEnd);
      ib.off(EventName.error, onError);
    };
    const onParam = (incomingReqId, exchange, underlyingConId, tradingClass, multiplier, expirations, strikes) => {
      if (incomingReqId !== reqId) return;
      state.optionRows.push({ exchange, underlyingConId, tradingClass, multiplier, expirations, strikes });
    };
    const onEnd = (incomingReqId) => {
      if (incomingReqId !== reqId) return;
      cleanup();
      const rows = state.optionRows.filter((row) => Array.isArray(row.expirations) && row.expirations.length && Array.isArray(row.strikes) && row.strikes.length);
      if (!rows.length) {
        reject(new Error("empty_option_chain"));
        return;
      }
      const smart = rows.find((row) => String(row.exchange).toUpperCase() === "SMART") || rows[0];
      resolve({
        rowCount: rows.length,
        exchange: smart.exchange,
        tradingClass: smart.tradingClass,
        expirationsCount: smart.expirations.length,
        strikesCount: smart.strikes.length,
        sampleExpiry: [...smart.expirations].sort()[0],
        sampleStrikes: [...smart.strikes].sort((a, b) => a - b).slice(0, 5),
      });
    };
    const onError = (err, code, incomingReqId) => {
      if (incomingReqId !== reqId) return;
      state.errors.push({ stage: "option_chain", code, message: String(err) });
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout:option_chain"));
    }, 15000);

    ib.on(EventName.securityDefinitionOptionParameter, onParam);
    ib.on(EventName.securityDefinitionOptionParameterEnd, onEnd);
    ib.on(EventName.error, onError);
    ib.reqSecDefOptParams(reqId, underlying, "", "STK", state.contract.conId);
  });
}

(async () => {
  try {
    const managedAccounts = [];
    ib.on(EventName.managedAccounts, (accounts) => {
      if (typeof accounts === "string" && accounts.trim()) state.accountId = accounts.trim().split(",")[0];
      if (Array.isArray(accounts) && accounts.length) state.accountId = String(accounts[0]);
      managedAccounts.push(accounts);
    });
    ib.on(EventName.error, (err, code, reqId) => {
      state.errors.push({ stage: "general", code, reqId, message: String(err) });
    });

    ib.connect();
    await withTimeout(onceConnected(), 15000, "connect");
    await wait(1500);
    await withTimeout(getUnderlyingContract(), 10000, "contract");
    const stock = await withTimeout(getStockQuote(), 15000, "stock");
    const optionChain = await withTimeout(getOptionChain(), 18000, "option_chain");

    console.log(JSON.stringify({
      ok: true,
      host,
      port,
      connected: state.connected,
      accountId: state.accountId,
      underlying,
      stock,
      optionChain,
      notableErrors: state.errors.filter((e) => ![2104, 2106, 2158].includes(Number(e.code))).slice(-10),
    }, null, 2));

    finish(0);
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      host,
      port,
      connected: state.connected,
      accountId: state.accountId,
      underlying,
      stock: state.stock,
      errors: state.errors.slice(-20),
      failure: String(error?.message || error),
    }, null, 2));
    finish(1);
  }
})();

import "dotenv/config";
import { IBApi, EventName, SecType } from "@stoqey/ib";

const host = process.env.IBKR_HOST || "127.0.0.1";
const port = parseInt(process.env.IBKR_PORT || "4002", 10);
const clientId = 3;
const symbol = "AAPL";
const ib = new IBApi({ host, port, clientId });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const result: any = {
  env: { host, port, clientId },
  source_guard: "ibkr_only_test",
  errors: []
};

ib.on(EventName.error, (err: any, code: number, reqId: number) => {
  const msg = String(err?.message || err || "unknown");
  if (![2104, 2106, 2158].includes(code)) {
    result.errors.push({ code, reqId, msg });
  }
});

const waitForConnect = async (): Promise<boolean> => {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 15000);
    ib.on(EventName.connected, () => {
      clearTimeout(timer);
      ib.reqMarketDataType(3);
      resolve(true);
    });
    ib.connect();
  });
};

const getConId = async (ticker: string): Promise<number | null> => {
  return await new Promise((resolve) => {
    const reqId = 3101;
    let conId: number | null = null;
    const onDetails = (rId: number, details: any) => {
      if (rId !== reqId) return;
      conId = details?.contract?.conId ?? details?.contract?.conid ?? conId;
    };
    const onEnd = (rId: number) => {
      if (rId !== reqId) return;
      ib.off(EventName.contractDetails, onDetails);
      ib.off(EventName.contractDetailsEnd, onEnd);
      resolve(conId);
    };
    ib.on(EventName.contractDetails, onDetails);
    ib.on(EventName.contractDetailsEnd, onEnd);
    ib.reqContractDetails(reqId, { symbol: ticker, secType: SecType.STK, exchange: "SMART", currency: "USD" } as any);
    setTimeout(() => {
      ib.off(EventName.contractDetails, onDetails);
      ib.off(EventName.contractDetailsEnd, onEnd);
      resolve(conId);
    }, 12000);
  });
};

const getStock = async (ticker: string) => {
  const reqId = 3102;
  const stock: any = { ticker, last: 0, bid: 0, ask: 0, close: 0, volume: 0 };
  const onPrice = (rId: number, tickType: number, price: number) => {
    if (rId !== reqId || !(price > 0)) return;
    if (tickType === 1) stock.bid = price;
    if (tickType === 2) stock.ask = price;
    if (tickType === 4) { stock.last = price; stock.close = price; }
    if (tickType === 9) stock.close = price;
  };
  const onSize = (rId: number, tickType: number, size: number) => {
    if (rId === reqId && tickType === 8) stock.volume = size;
  };
  ib.on(EventName.tickPrice, onPrice);
  ib.on(EventName.tickSize, onSize);
  ib.reqMktData(reqId, { symbol: ticker, secType: SecType.STK, exchange: "SMART", currency: "USD" } as any, "", false, false);
  await sleep(10000);
  ib.off(EventName.tickPrice, onPrice);
  ib.off(EventName.tickSize, onSize);
  return stock;
};

const getOptionChain = async (ticker: string, conId: number) => {
  return await new Promise<any[]>((resolve) => {
    const reqId = 3103;
    const rows: any[] = [];
    const onParam = (rId: number, exchange: string, underlyingConId: number, tradingClass: string, multiplier: string, expirations: string[], strikes: number[]) => {
      if (rId !== reqId) return;
      rows.push({ exchange, underlyingConId, tradingClass, multiplier, expirations, strikes });
    };
    const onEnd = (rId: number) => {
      if (rId !== reqId) return;
      ib.off(EventName.securityDefinitionOptionParameter, onParam);
      ib.off(EventName.securityDefinitionOptionParameterEnd, onEnd);
      resolve(rows);
    };
    ib.on(EventName.securityDefinitionOptionParameter, onParam);
    ib.on(EventName.securityDefinitionOptionParameterEnd, onEnd);
    ib.reqSecDefOptParams(reqId, ticker, "", SecType.STK as unknown as string, conId);
    setTimeout(() => {
      ib.off(EventName.securityDefinitionOptionParameter, onParam);
      ib.off(EventName.securityDefinitionOptionParameterEnd, onEnd);
      resolve(rows);
    }, 15000);
  });
};

(async () => {
  try {
    result.connected = await waitForConnect();
    if (!result.connected) {
      console.log(JSON.stringify(result));
      process.exit(0);
    }
    result.stock = await getStock(symbol);
    result.conId = await getConId(symbol);
    result.chain_groups = result.conId ? await getOptionChain(symbol, result.conId) : [];
    const first = result.chain_groups.find((x: any) => Array.isArray(x.expirations) && x.expirations.length && Array.isArray(x.strikes) && x.strikes.length);
    result.chain_sample = first ? {
      exchange: first.exchange,
      tradingClass: first.tradingClass,
      expirations: first.expirations.slice(0, 5),
      strikes: first.strikes.slice(0, 10)
    } : null;
    result.summary = {
      stock_ok: Boolean((result.stock?.last || result.stock?.close || 0) > 0),
      option_chain_ok: Boolean(first),
      data_source: "IBKR"
    };
  } catch (e: any) {
    result.fatal = String(e?.message || e);
  } finally {
    try { ib.disconnect(); } catch {}
    console.log(JSON.stringify(result));
    process.exit(0);
  }
})();

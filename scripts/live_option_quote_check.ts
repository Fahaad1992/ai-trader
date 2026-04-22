import 'dotenv/config';
import { IBApi, EventName, SecType } from '@stoqey/ib';

const host = process.env.IBKR_HOST || '127.0.0.1';
const port = parseInt(process.env.IBKR_PORT || '4002', 10);
const clientId = 91;
const symbol = 'AAPL';
const ib = new IBApi({ host, port, clientId });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const result: any = {
  env: { host, port, clientId },
  symbol,
  connected: false,
  stock: null,
  selected_option: null,
  contract_details: null,
  option_quote: null,
  errors: [],
  sent_order: false,
  source: 'IBKR'
};

ib.on(EventName.error, (err: any, code: number, reqId: number) => {
  const msg = String(err?.message || err || 'unknown');
  if (![2104, 2106, 2158, 2108].includes(code)) result.errors.push({ code, reqId, msg });
});

async function connect(): Promise<boolean> {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 15000);
    ib.on(EventName.connected, () => {
      clearTimeout(timer);
      try { ib.reqMarketDataType(1); } catch {}
      resolve(true);
    });
    ib.connect();
  });
}

async function getStockPrice(ticker: string) {
  return await new Promise<any>((resolve) => {
    const reqId = 5001;
    const stock: any = { symbol: ticker, bid: 0, ask: 0, last: 0, close: 0 };
    const onPrice = (rId: number, tickType: number, price: number) => {
      if (rId !== reqId || price <= 0) return;
      if (tickType === 1 || tickType === 66) stock.bid = price;
      if (tickType === 2 || tickType === 67) stock.ask = price;
      if (tickType === 4 || tickType === 68) stock.last = price;
      if (tickType === 9 || tickType === 75) stock.close = price;
    };
    ib.on(EventName.tickPrice, onPrice);
    ib.reqMktData(reqId, { symbol: ticker, secType: SecType.STK, exchange: 'SMART', currency: 'USD' } as any, '', false, false);
    setTimeout(() => {
      ib.off(EventName.tickPrice, onPrice);
      try { ib.cancelMktData(reqId); } catch {}
      resolve(stock);
    }, 9000);
  });
}

async function getStockConId(ticker: string): Promise<number | null> {
  return await new Promise((resolve) => {
    const reqId = 5002;
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
    ib.reqContractDetails(reqId, { symbol: ticker, secType: SecType.STK, exchange: 'SMART', currency: 'USD' } as any);
    setTimeout(() => {
      ib.off(EventName.contractDetails, onDetails);
      ib.off(EventName.contractDetailsEnd, onEnd);
      resolve(conId);
    }, 10000);
  });
}

async function getOptionChain(ticker: string, conId: number): Promise<any[]> {
  return await new Promise((resolve) => {
    const reqId = 5003;
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
    ib.reqSecDefOptParams(reqId, ticker, '', SecType.STK as unknown as string, conId);
    setTimeout(() => {
      ib.off(EventName.securityDefinitionOptionParameter, onParam);
      ib.off(EventName.securityDefinitionOptionParameterEnd, onEnd);
      resolve(rows);
    }, 12000);
  });
}

async function getOptionContractDetails(contract: any): Promise<any | null> {
  return await new Promise((resolve) => {
    const reqId = 5004;
    let detailsOut: any = null;
    const onDetails = (rId: number, details: any) => {
      if (rId !== reqId) return;
      if (!detailsOut) {
        detailsOut = {
          conId: details?.contract?.conId ?? null,
          localSymbol: details?.contract?.localSymbol ?? null,
          exchange: details?.contract?.exchange ?? null,
          primaryExchange: details?.contract?.primaryExch ?? null,
          tradingClass: details?.contract?.tradingClass ?? null,
          multiplier: details?.contract?.multiplier ?? null,
          lastTradeDateOrContractMonth: details?.contract?.lastTradeDateOrContractMonth ?? null,
          strike: details?.contract?.strike ?? null,
          right: details?.contract?.right ?? null,
          currency: details?.contract?.currency ?? null,
          minTick: details?.minTick ?? null,
          validExchanges: details?.validExchanges ?? null
        };
      }
    };
    const onEnd = (rId: number) => {
      if (rId !== reqId) return;
      ib.off(EventName.contractDetails, onDetails);
      ib.off(EventName.contractDetailsEnd, onEnd);
      resolve(detailsOut);
    };
    ib.on(EventName.contractDetails, onDetails);
    ib.on(EventName.contractDetailsEnd, onEnd);
    ib.reqContractDetails(reqId, contract as any);
    setTimeout(() => {
      ib.off(EventName.contractDetails, onDetails);
      ib.off(EventName.contractDetailsEnd, onEnd);
      resolve(detailsOut);
    }, 12000);
  });
}

async function getOptionQuote(contract: any) {
  return await new Promise<any>((resolve) => {
    const reqId = 5005;
    const quote: any = { bid: 0, ask: 0, last: 0, close: 0, mark: 0, premium: 0 };
    const onPrice = (rId: number, tickType: number, price: number) => {
      if (rId !== reqId || !(price > 0)) return;
      if (tickType === 1) quote.bid = price;
      if (tickType === 2) quote.ask = price;
      if (tickType === 4) quote.last = price;
      if (tickType === 9) quote.close = price;
    };
    ib.on(EventName.tickPrice, onPrice);
    ib.reqMktData(reqId, contract as any, '', false, false);
    setTimeout(() => {
      ib.off(EventName.tickPrice, onPrice);
      try { ib.cancelMktData(reqId); } catch {}
      quote.mark = quote.bid > 0 && quote.ask > 0 ? Number(((quote.bid + quote.ask) / 2).toFixed(2)) : 0;
      quote.premium = quote.mark > 0 ? quote.mark : (quote.last > 0 ? quote.last : (quote.close > 0 ? quote.close : 0));
      resolve(quote);
    }, 12000);
  });
}

(async () => {
  try {
    result.connected = await connect();
    if (!result.connected) throw new Error('ibkr_connect_failed');
    result.stock = await getStockPrice(symbol);
    const conId = await getStockConId(symbol);
    if (!conId) throw new Error('stock_conid_not_found');
    const chain = await getOptionChain(symbol, conId);
    const validRows = chain.filter((x: any) => Array.isArray(x.expirations) && x.expirations.length && Array.isArray(x.strikes) && x.strikes.length);
    if (!validRows.length) throw new Error('options_chain_empty');
    const smartRows = validRows.filter((x: any) => String(x.exchange || '').toUpperCase() === 'SMART');
    const preferredRows = smartRows.length ? smartRows : validRows;
    const basePx = result.stock?.last || result.stock?.close || (result.stock?.bid > 0 && result.stock?.ask > 0 ? Number(((result.stock.bid + result.stock.ask) / 2).toFixed(2)) : (result.stock?.bid || result.stock?.ask || 0));
    if (!(basePx > 0)) throw new Error('underlying_price_not_available');
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const expiries = [...new Set(preferredRows.flatMap((x: any) => Array.isArray(x.expirations) ? x.expirations : []))].sort();
    const expiry = expiries.find((e: string) => e >= today) || expiries[0];
    const expiryRows = preferredRows.filter((x: any) => Array.isArray(x.expirations) && x.expirations.includes(expiry));
    const strikes = [...new Set(expiryRows.flatMap((x: any) => Array.isArray(x.strikes) ? x.strikes : []))]
      .filter((s: any) => typeof s === 'number' && s > 0)
      .sort((a: number, b: number) => Math.abs(a - basePx) - Math.abs(b - basePx));
    const strike = strikes[0];
    const chainRow = expiryRows.find((x: any) => Array.isArray(x.strikes) && x.strikes.some((s: number) => Math.abs(s - strike) < 0.0001)) || expiryRows[0];
    if (!expiry || !(strike > 0) || !chainRow) throw new Error('option_selection_failed');
    const optionContract = {
      symbol,
      secType: SecType.OPT,
      exchange: chainRow.exchange || 'SMART',
      currency: 'USD',
      lastTradeDateOrContractMonth: expiry,
      strike: Number(strike),
      right: 'C',
      multiplier: chainRow.multiplier || '100',
      tradingClass: chainRow.tradingClass || symbol
    };
    result.selected_option = optionContract;
    result.contract_details = await getOptionContractDetails(optionContract);
    result.option_quote = await getOptionQuote(optionContract);
  } catch (e: any) {
    result.fatal = String(e?.message || e);
  } finally {
    await sleep(500);
    try { ib.disconnect(); } catch {}
    console.log(JSON.stringify(result));
    process.exit(0);
  }
})();

const { IBApi, EventName, SecType } = require('@stoqey/ib');

const host = process.env.IBKR_HOST || '127.0.0.1';
const port = parseInt(process.env.IBKR_PORT || '4001', 10);
const clientId = parseInt(process.env.IBKR_CLIENT_ID || '101', 10);

const result = {
  host,
  port,
  clientId,
  steps: {
    connect_called: false,
    connected_event: false,
    next_valid_id: false,
    account_summary_requested: false,
    account_summary_received: false,
    market_data_requested: false,
    market_data_received: false,
    error_before_connect: null,
    error_after_connect: null,
  },
  errors: [],
  events: [],
};

let ib;
let finished = false;
let reqId = 9000;
let orderIdSeen = null;
let accountSummaryTags = [];
let marketTicks = [];

function logEvent(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  result.events.push(line);
  console.log(line);
}

function finish(reason) {
  if (finished) return;
  finished = true;
  result.finishReason = reason;
  result.orderIdSeen = orderIdSeen;
  result.accountSummaryTags = accountSummaryTags;
  result.marketTicks = marketTicks;
  try {
    if (ib) ib.disconnect();
  } catch {}
  console.log('===PROBE_RESULT===');
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const timeout = setTimeout(() => finish('timeout'), 25000);

try {
  ib = new IBApi({ host, port, clientId });
  result.steps.connect_called = true;
  logEvent(`creating IBApi host=${host} port=${port} clientId=${clientId}`);

  ib.on(EventName.error, (err, code, reqIdX) => {
    const rec = { err: String(err), code, reqId: reqIdX };
    result.errors.push(rec);
    if (!result.steps.connected_event) {
      result.steps.error_before_connect = rec;
    } else {
      result.steps.error_after_connect = rec;
    }
    logEvent(`error event code=${code} reqId=${reqIdX} err=${String(err)}`);
  });

  ib.on(EventName.connected, () => {
    result.steps.connected_event = true;
    logEvent('connected event');
    try {
      ib.reqIds(-1);
      logEvent('reqIds sent');
    } catch (e) {
      result.errors.push({ stage: 'reqIds', err: String(e) });
      finish('reqIds_throw');
    }
  });

  ib.on(EventName.nextValidId, (orderId) => {
    result.steps.next_valid_id = true;
    orderIdSeen = orderId;
    logEvent(`nextValidId=${orderId}`);
    const accReqId = ++reqId;
    try {
      result.steps.account_summary_requested = true;
      ib.reqAccountSummary(accReqId, 'All', 'AccountType,NetLiquidation,BuyingPower');
      logEvent(`reqAccountSummary sent reqId=${accReqId}`);
    } catch (e) {
      result.errors.push({ stage: 'reqAccountSummary', err: String(e) });
      finish('reqAccountSummary_throw');
      return;
    }
    const mdReqId = ++reqId;
    try {
      result.steps.market_data_requested = true;
      const contract = {
        symbol: 'MES',
        secType: SecType.FUT,
        exchange: 'CME',
        currency: 'USD',
        tradingClass: 'MES',
        lastTradeDateOrContractMonth: '202606'
      };
      ib.reqMktData(mdReqId, contract, '', false, false);
      logEvent(`reqMktData sent reqId=${mdReqId} symbol=MES`);
    } catch (e) {
      result.errors.push({ stage: 'reqMktData', err: String(e) });
      finish('reqMktData_throw');
    }
  });

  ib.on(EventName.accountSummary, (reqIdX, account, tag, value, currency) => {
    result.steps.account_summary_received = true;
    accountSummaryTags.push({ reqId: reqIdX, account, tag, value, currency });
    logEvent(`accountSummary reqId=${reqIdX} account=${account} tag=${tag} value=${value}`);
  });

  ib.on(EventName.tickPrice, (tickerId, tickType, price) => {
    result.steps.market_data_received = true;
    marketTicks.push({ tickerId, tickType, price });
    logEvent(`tickPrice tickerId=${tickerId} tickType=${tickType} price=${price}`);
    if (marketTicks.length >= 1 || accountSummaryTags.length >= 1) {
      clearTimeout(timeout);
      setTimeout(() => finish('success_or_partial'), 1500);
    }
  });

  ib.on(EventName.tickSize, (tickerId, tickType, size) => {
    logEvent(`tickSize tickerId=${tickerId} tickType=${tickType} size=${size}`);
  });

  ib.on(EventName.disconnected, () => {
    logEvent('disconnected event');
  });

  ib.connect();
  logEvent('connect() called');
} catch (e) {
  result.errors.push({ stage: 'constructor_or_connect', err: String(e) });
  clearTimeout(timeout);
  finish('constructor_or_connect_throw');
}

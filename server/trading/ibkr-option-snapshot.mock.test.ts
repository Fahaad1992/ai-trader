import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ibkr } from "./ibkr-client.js";

const runtime = ibkr as any;
const oldValues = new Map<string, any>();

describe("simulated IBKR model-greeks-first market-data lifecycle (NO live orders)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for(const key of ["connected","ib","getCachedSPXChain","stockPrices","tickerReqMap","tickerFeedModes",
      "pendingRequests","reqId","brokerBackendLost","subscriptionsNeedRefresh"]){
      oldValues.set(key,runtime[key]);
    }
    runtime.connected=true;
    runtime.brokerBackendLost=false;
    runtime.subscriptionsNeedRefresh=false;
    runtime.reqId=15000;
    runtime.stockPrices=new Map();
    runtime.tickerReqMap=new Map();
    runtime.tickerFeedModes=new Map();
    runtime.pendingRequests=new Map();
    runtime.ib={
      reqMktData:vi.fn(),
      cancelMktData:vi.fn(),
    };
    runtime.getCachedSPXChain=vi.fn().mockResolvedValue([{
      exchange:"SMART",strikes:[7700],expirations:["20261026"],
      multiplier:"100",tradingClass:"SPXW",
    }]);
  });
  afterEach(() => {
    for(const [key,value] of oldValues) runtime[key]=value;
    oldValues.clear();
    vi.useRealTimers();
  });

  async function startQuote(){
    const pending=runtime.getOptionSnapshot("SPX","call",7700,"20261026");
    // Allow option-chain and the request constructor to complete.
    await Promise.resolve();await Promise.resolve();await Promise.resolve();await Promise.resolve();
    const requestCalls=runtime.ib.reqMktData.mock.calls;
    expect(requestCalls).toHaveLength(1);
    const reqId=requestCalls[0][0] as number;
    expect(runtime.pendingRequests.has(reqId)).toBe(true);
    return {pending,reqId};
  }

  it("Greeks before BID/ASK must NOT cancel 2500ms deadline or leak subscription",async()=>{
    const {pending,reqId}=await startQuote();
    runtime.acceptModelOptionGreeks(reqId,13,{delta:0.3,iv:0.2});
    expect(runtime.pendingRequests.has(reqId)).toBe(true);
    await vi.advanceTimersByTimeAsync(2600);
    expect(await pending).toBeNull();
    expect(runtime.pendingRequests.has(reqId)).toBe(false);
    expect(runtime.tickerReqMap.has(reqId)).toBe(false);
    expect(runtime.ib.cancelMktData).toHaveBeenCalledWith(reqId);
  });

  it("Greeks then valid LIVE bid/ask and volume returns the real contract",async()=>{
    const {pending,reqId}=await startQuote();
    const name=`OPT_${reqId}`;
    runtime.acceptModelOptionGreeks(reqId,13,{delta:0.27,iv:0.3});
    runtime.stockPrices.set(name,{
      bid:1.70,ask:1.75,volume:80,
      bidReceivedAtMs:Date.now(),askReceivedAtMs:Date.now(),
      last:1.72,
    });
    runtime.tickerFeedModes.set(name,"live");
    await vi.advanceTimersByTimeAsync(55);
    const quote=await pending;
    expect(quote?.strike).toBe(7700);
    expect(quote?.delta).toBe(0.27);
    expect(quote?.ask).toBe(1.75);
    expect(runtime.pendingRequests.size).toBe(0);
    expect(runtime.ib.cancelMktData).toHaveBeenCalledWith(reqId);
  });

  it("delayed option quotes must time out and never appear as LIVE",async()=>{
    const {pending,reqId}=await startQuote();
    const name=`OPT_${reqId}`;
    runtime.acceptModelOptionGreeks(reqId,13,{delta:0.27,iv:0.3});
    runtime.stockPrices.set(name,{
      bid:1.70,ask:1.75,volume:80,
      bidReceivedAtMs:Date.now(),askReceivedAtMs:Date.now(),
    });
    runtime.tickerFeedModes.set(name,"delayed");
    await vi.advanceTimersByTimeAsync(2600);
    expect(await pending).toBeNull();
  });

  it("unknown or missing volume and no greeks also expire without hanging",async()=>{
    const {pending,reqId}=await startQuote();
    const name=`OPT_${reqId}`;
    runtime.stockPrices.set(name,{
      bid:1.70,ask:1.75,volume:0,
      bidReceivedAtMs:Date.now(),askReceivedAtMs:Date.now(),
    });
    runtime.tickerFeedModes.set(name,"live");
    await vi.advanceTimersByTimeAsync(2600);
    expect(await pending).toBeNull();
  });
});

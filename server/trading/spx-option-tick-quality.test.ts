import { describe, it, expect } from "vitest";
import { verifySPXOptionTick } from "./spx-option-tick-quality.js";

const now = 1793040000000;
const quote = () => ({ bid: 2.95, ask: 3.00, bidReceivedAtMs: now - 150,
  askReceivedAtMs: now - 200, marketDataMode: "live" as const });
describe("SPX real tick freshness pre-live audit", () => {
  it("accepts recent live bid AND ask", () => {
    expect(verifySPXOptionTick(quote(), now)).toEqual({ok: true, bid:2.95,ask:3,timestampMs:now-200});
  });
  it("blocks delayed and unknown market data even when price looks current", () => {
    for (const marketDataMode of ["delayed", "unknown"] as const)
      expect(verifySPXOptionTick({ ...quote(), marketDataMode }, now)).toEqual({ok:false,reason:"NOT_LIVE"});
  });
  it("blocks missing bid or ask tick receipt time (snapshot timestamp alone not enough)", () => {
    expect(verifySPXOptionTick({...quote(),bidReceivedAtMs:null},now)).toEqual({ok:false,reason:"MISSING_TICK_TIMESTAMPS"});
    expect(verifySPXOptionTick({...quote(),askReceivedAtMs:undefined},now).ok).toBe(false);
  });
  it("blocks stale bid with fresh ask, or fresh bid with stale ask", () => {
    expect(verifySPXOptionTick({...quote(),bidReceivedAtMs:now-2200},now).ok).toBe(false);
    expect(verifySPXOptionTick({...quote(),askReceivedAtMs:now-2300},now).ok).toBe(false);
  });
  it("blocks future time, invalid clocks and crossed or zero quotes", () => {
    expect(verifySPXOptionTick({...quote(),bidReceivedAtMs:now+1},now).ok).toBe(false);
    expect(verifySPXOptionTick(quote(),Number.NaN).ok).toBe(false);
    expect(verifySPXOptionTick({...quote(),ask:2.80},now).ok).toBe(false);
    expect(verifySPXOptionTick({...quote(),bid:0},now).ok).toBe(false);
  });
  it("does not interpret volume/Greeks callback as a fresh bid/ask", () => {
    const q = quote();
    expect(verifySPXOptionTick(q,now+10000).ok).toBe(false);
  });
});

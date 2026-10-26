import { describe, expect, it } from "vitest";
import { deriveSPXBudget, assessSPXCandidate, rankSPXOptions } from "./spx-contract-selection.js";
const T=1793020000000;
const account = (cash=410.87) => ({ availableFunds:cash,buyingPower:cash,netLiquidation:cash,timestamp:T-100 });
const c=(overrides:Record<string,unknown>={}) => ({
  underlying:"SPX", type:"call" as const, ask:1.70,bid:1.65,
  delta:0.26,volume:100,openInterest:0,timestamp:T-100,
  delayed:false,strike:7690,expiry:"2026-10-26",...overrides,
});
describe("SPX adaptive risk-aware option selection",()=>{
  it("caps a $410.87 account below $2 premium, not at old $5",()=>{
    const b=deriveSPXBudget(account(),T);
    expect(b.ok).toBe(true);
    if(b.ok){
      expect(b.maximumPremium).toBe(1.82);
      expect(b.maximumDebitUsd).toBe(182);
      expect(b.maximumIntendedStopRiskUsd).toBe(81.9);
    }
  });
  it("refuses unsafe $3 contract for this equity, even if broker cash can pay",()=>{
    const b=deriveSPXBudget(account(),T);
    expect(assessSPXCandidate(c({ask:3,bid:2.9,delta:0.38}),b,T).reasons).toContain("ABOVE_BROKER_RISK_BUDGET");
  });
  it("allows a reasonably liquid CALL and PUT with signed delta",()=>{
    const b=deriveSPXBudget(account(),T);
    expect(assessSPXCandidate(c(),b,T).qualified).toBe(true);
    expect(assessSPXCandidate(c({type:"put",delta:-0.26}),b,T).qualified).toBe(true);
    expect(assessSPXCandidate(c({type:"put",delta:0.26}),b,T).qualified).toBe(false);
  });
  it("never relaxes below delta 0.18 or above 0.55 even if premium cheap",()=>{
    const b=deriveSPXBudget(account(),T);
    for(const delta of [0.05,0.12,0.15,0.60,NaN]) {
      expect(assessSPXCandidate(c({delta}),b,T).qualified).toBe(false);
    }
  });
  it("blocks stale, delayed, crossed, zero volume and wide spreads",()=>{
    const b=deriveSPXBudget(account(),T);
    for (const variant of [{timestamp:T-10000},{delayed:true},{bid:1.85},
      {volume:0},{bid:1.40},{ask:0.20,bid:0.15}]) {
      expect(assessSPXCandidate(c(variant),b,T).qualified).toBe(false);
    }
  });
  it("refuses stale balance, missing summary or zero cash",()=>{
    expect(deriveSPXBudget(null,T).ok).toBe(false);
    expect(deriveSPXBudget({...account(),timestamp:T-6000},T).ok).toBe(false);
    expect(deriveSPXBudget(account(0),T).ok).toBe(false);
    expect(deriveSPXBudget(account(50),T).ok).toBe(false);
  });
  it("chooses qualified delta nearest target over cheaper lottery ticket",()=>{
    const b=deriveSPXBudget(account(),T);
    const a=c({delta:0.20,ask:1,bid:0.96,strike:7700});
    const best=c({delta:0.32,ask:1.7,bid:1.65,strike:7690});
    const rejected=c({delta:0.06,ask:0.75,bid:0.70,strike:7750});
    expect(rankSPXOptions([a,rejected,best],b,T).map(x=>x.strike)).toEqual([7690,7700]);
  });
});

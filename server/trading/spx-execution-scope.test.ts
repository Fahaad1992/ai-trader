import { describe, expect, it } from "vitest";
import {
  checkLongSPXOrderScope, resolveLongSPXOptionFromTrend, enforceSPXOnlyRuntime,
} from "./spx-execution-scope.js";
const base = () => ({underlying:"SPX",secType:"OPT",right:"C",action:"BUY",quantity:1,multiplier:100,exchange:"SMART"});
describe("SPX long-only CALL/PUT and no futures scope",()=>{
  it("allows buying CALL and buying PUT, both long",()=>{
    expect(checkLongSPXOrderScope(base())).toEqual({allowed:true,intent:"BUY_TO_OPEN_LONG_CALL"});
    expect(checkLongSPXOrderScope({...base(),right:"P"})).toEqual({allowed:true,intent:"BUY_TO_OPEN_LONG_PUT"});
  });
  it("blocks naked short CALL or PUT and any order with SELL action",()=>{
    expect(checkLongSPXOrderScope({...base(),action:"SELL"}).allowed).toBe(false);
    expect(checkLongSPXOrderScope({...base(),right:"P",action:"SELL"}).allowed).toBe(false);
  });
  it("blocks stock, futures, NDX, QQQ, SPY, MES and unverified routes",()=>{
    for(const [underlying,secType] of [["MES","FUT"],["MNQ","FUT"],["SPX","FUT"],["SPY","OPT"],["QQQ","OPT"],["NDX","OPT"],["SPX","STK"]]){
      expect(checkLongSPXOrderScope({...base(),underlying,secType}).allowed).toBe(false);
    }
  });
  it("blocks two contracts, nonstandard multiplier, and wrong rights",()=>{
    expect(checkLongSPXOrderScope({...base(),quantity:2}).allowed).toBe(false);
    expect(checkLongSPXOrderScope({...base(),multiplier:50}).allowed).toBe(false);
    expect(checkLongSPXOrderScope({...base(),right:"X"}).allowed).toBe(false);
  });
  it("refuses to choose PUT on missing/failed/unknown trend",()=>{
    expect(resolveLongSPXOptionFromTrend(null)).toBe(null);
    expect(resolveLongSPXOptionFromTrend({passed:false,value:"هابط"})).toBe(null);
    expect(resolveLongSPXOptionFromTrend({passed:true,value:"غير معروف"})).toBe(null);
    expect(resolveLongSPXOptionFromTrend({passed:true,value:"صاعد وهابط"})).toBe(null);
    expect(resolveLongSPXOptionFromTrend({passed:true,value:"صاعد ↑ (9 > 21)"})).toBe("call");
    expect(resolveLongSPXOptionFromTrend({passed:true,value:"هابط ↓ (9 < 21)"})).toBe("put");
  });
  it("requires explicit spx_options trade mode and refuses old modes",()=>{
    expect(()=>enforceSPXOnlyRuntime("spx_options")).not.toThrow();
    for(const mode of ["options","futures","MES","","stocks"]){
      expect(()=>enforceSPXOnlyRuntime(mode)).toThrow();
    }
  });
});

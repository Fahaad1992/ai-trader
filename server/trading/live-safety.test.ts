import { describe, expect, it } from "vitest";
import { isProtectionReady } from "./live-safety.js";
const valid = () => ({ orderId: 40, status: "Filled", parentStatus: "Filled",
  stopOrderId: 41, childStopStatus: "Submitted" });
describe("SPX broker stop protection acceptance scenarios",()=>{
  it("requires a working stop child after entry fill",()=>{
    expect(isProtectionReady(valid(),false).ok).toBe(true);
    expect(isProtectionReady({...valid(),childStopStatus:"PreSubmitted"},false).ok).toBe(true);
  });
  it("rejects fake, missing, pending, canceled, rejected or already filled stop orders",()=>{
    for(const childStopStatus of ["", "PendingSubmit","ApiPending","Filled","Rejected","Cancelled","Inactive"]){
      expect(isProtectionReady({...valid(),childStopStatus},false).ok).toBe(false);
    }
    expect(isProtectionReady({...valid(),stopOrderId:undefined},false).ok).toBe(false);
    expect(isProtectionReady({...valid(),stopOrderId:-1},false).ok).toBe(false);
    expect(isProtectionReady({...valid(),orderId:-1},false).ok).toBe(false);
  });
  it("rejects canceled parent and missing target if a 3-leg bracket was requested",()=>{
    expect(isProtectionReady({...valid(),parentStatus:"Rejected"},false).ok).toBe(false);
    expect(isProtectionReady(valid(),true).ok).toBe(false);
  });
});

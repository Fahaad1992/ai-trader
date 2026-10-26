import { describe, it, expect } from "vitest";
import { checkBrokerEntrySafety, type BrokerEntryGateInput } from "./broker-exposure-guard.js";

const nowMs = 1793010000000;
function safe(): BrokerEntryGateInput {
  return {
    nowMs, brokerConnected: true, configuredAccountId: "DU123",
    connectedAccountId: "DU123",
    snapshot: { accountId: "DU123", fetchedAtMs: nowMs - 200, completed: true, positions: [], openOrders: [] },
    balance: { accountId: "DU123", availableFunds: 410.87, buyingPower: 410.87, netLiquidation: 410.87, timestamp: nowMs - 200 },
    localOpenTradeCount: 0, entryPremium: 3.0, quantity: 1, multiplier: 100,
  };
}
describe("IBKR restart / duplicate entry fail-closed protection", () => {
  it("permits only fully synchronized, funded 1-contract entry", () => {
    const a = checkBrokerEntrySafety(safe());
    expect(a.allowed).toBe(true);
    expect(a.costUsd).toBe(300);
    expect(a.fundsUsd).toBe(410.87);
  });
  it("blocks any broker position even if local DB is empty after reboot", () => {
    const a = safe();
    a.snapshot = { ...a.snapshot!, positions: [{ account: "DU123", conId: 1234, symbol: "SPX", quantity: 1 }] };
    expect(checkBrokerEntrySafety(a).reasons).toContain("BROKER_HAS_OPEN_POSITION");
  });
  it("blocks pending order with no broker position (unknown fill)", () => {
    const a = safe();
    a.snapshot = { ...a.snapshot!, openOrders: [{ orderId: 77, conId: 1234, symbol: "SPX", status: "Submitted" }] };
    expect(checkBrokerEntrySafety(a).reasons).toContain("BROKER_HAS_OPEN_ORDER");
  });
  it("blocks unrelated manual positions and orders", () => {
    const a = safe();
    a.snapshot = { ...a.snapshot!, positions: [{ account: "DU123", conId: 99, symbol: "MU", quantity: 2 }] };
    expect(checkBrokerEntrySafety(a).allowed).toBe(false);
  });
  it("blocks missing, stale, incomplete or mismatched snapshots", () => {
    for (const snap of [
      null, { ...safe().snapshot!, completed: false },
      { ...safe().snapshot!, fetchedAtMs: nowMs - 5000 },
      { ...safe().snapshot!, accountId: "DU999" },
    ]) {
      const a = safe(); a.snapshot = snap;
      expect(checkBrokerEntrySafety(a).reasons).toContain("BROKER_EXPOSURE_UNKNOWN_OR_STALE");
    }
  });
  it("blocks missing or stale buying power on reconnect", () => {
    const a = safe(); a.balance = null;
    expect(checkBrokerEntrySafety(a).reasons).toContain("BROKER_BALANCE_UNKNOWN_OR_STALE");
    a.balance = { ...safe().balance!, timestamp: nowMs - 10000 };
    expect(checkBrokerEntrySafety(a).allowed).toBe(false);
  });
  it("blocks changed account or lost broker connection", () => {
    const a = safe(); a.connectedAccountId = "DU999";
    expect(checkBrokerEntrySafety(a).reasons).toContain("BROKER_ACCOUNT_LOCK_MISMATCH");
    a.brokerConnected = false;
    expect(checkBrokerEntrySafety(a).reasons).toContain("BROKER_DISCONNECTED");
  });
  it("blocks local SQLite open position on restart", () => {
    const a = safe(); a.localOpenTradeCount = 1;
    expect(checkBrokerEntrySafety(a).reasons).toContain("LOCAL_POSITION_EXISTS_OR_UNVERIFIED");
  });
  it("uses true buying power and buffers for fees instead of config capital", () => {
    const a = safe(); a.balance!.availableFunds = 299; a.balance!.buyingPower = 299;
    expect(checkBrokerEntrySafety(a).reasons).toContain("INSUFFICIENT_REAL_BROKER_FUNDS");
    a.balance!.availableFunds = 304; a.balance!.buyingPower = 304;
    expect(checkBrokerEntrySafety(a).allowed).toBe(false);
  });
  it("blocks 2 contracts and invalid option premiums", () => {
    const a = safe(); a.quantity = 2;
    expect(checkBrokerEntrySafety(a).reasons).toContain("POSITION_SIZING_INVALID");
    a.quantity = 1; a.entryPremium = Number.NaN;
    expect(checkBrokerEntrySafety(a).allowed).toBe(false);
  });
  it("fails closed on unknown balance and exposure contents", () => {
    const a = safe(); (a.snapshot as any).positions = undefined;
    expect(checkBrokerEntrySafety(a).reasons).toContain("BROKER_EXPOSURE_INVALID");
  });
});

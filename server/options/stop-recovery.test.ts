import { describe, expect, it } from "vitest";
import {
  reconcileSPXStop, previewRecoveredSPXStopRaise, commitConfirmedRecoveredSPXStop, createVerifiedSPXStopRecord,
  type SavedSPXStop, type RecoveryBrokerSnapshot,
} from "./stop-recovery.js";

const NOW = 1793020000000;
const saved = (): SavedSPXStop => ({
  accountId: "DU123", conId: 789123, entryPremium: 3,
  quantity: 1, entryOrderId: 10, stopOrderId: 11, stopPermId: 1001,
  right: "CALL", expiry: "20261026", strike: 6000, tickSize: 0.01,
  peakBid: 3.50, lastConfirmedStop: 3.20,
  lastQuoteTimestampMs: NOW - 10000, recordedAtMs: NOW - 60000,
});
const broker = (): RecoveryBrokerSnapshot => ({
  connected: true, completed: true, accountId: "DU123", retrievedAtMs: NOW,
  positions: [{ accountId: "DU123", conId: 789123, symbol: "SPX", secType: "OPT", quantity: 1 }],
  orders: [{
    orderId: 11, permId: 1001, conId: 789123, symbol: "SPX", secType: "OPT",
    action: "SELL", orderType: "STP", status: "Submitted",
    auxPrice: 3.20, parentId: 10, totalQuantity: 1,
  }],
});
describe("SPX broker-backed stop recovery after a crash", () => {
  it("never infers flat from broker unavailability", () => {
    expect(reconcileSPXStop(null, null, "DU123", NOW).status).toBe("BLOCK_AND_ALERT");
    const b = broker(); b.completed = false;
    expect(reconcileSPXStop(null, b, "DU123", NOW).status).toBe("BLOCK_AND_ALERT");
  });
  it("finds truly flat account only when both completed lists are empty", () => {
    const b = broker(); b.positions = []; b.orders = [];
    expect(reconcileSPXStop(null, b, "DU123", NOW).status).toBe("FLAT");
  });
  it("detects a broker position without a saved trade instead of entering again", () => {
    expect(reconcileSPXStop(null, broker(), "DU123", NOW)).toEqual({
      status: "BLOCK_AND_ALERT", reason: "ORPHANED_BROKER_EXPOSURE_NO_SAVED_STOP",
    });
  });
  it("restores the exact order id, quantity and broker-confirmed stop", () => {
    const result = reconcileSPXStop(saved(), broker(), "DU123", NOW);
    expect(result.status).toBe("RESUME_MONITORING");
    if (result.status !== "RESUME_MONITORING") throw new Error("expected matched broker stop");
    expect(result.recovered.activeStopOrderId).toBe(11);
    expect(result.recovered.stopState.confirmedStop).toBe(3.20);
    expect(result.recovered.stopState.pendingStop).toBeNull();
    expect(result.recovered.stopState.lastQuoteTimestampMs).toBeNull();
    expect(result.recovered.stopState.peakBid).toBe(3.50);
  });
  it("refuses missing broker stop, even though position still exists", () => {
    const b = broker(); b.orders = [];
    expect(reconcileSPXStop(saved(), b, "DU123", NOW)).toEqual({
      status: "BLOCK_AND_ALERT", reason: "SAVED_PROTECTIVE_STOP_NOT_VISIBLE_AT_BROKER",
    });
  });
  it("refuses expired, cancelled, wrong contract, wrong qty and wrong parent", () => {
    for (const updates of [
      { status: "Cancelled" }, { conId: 999999 },
      { totalQuantity: 2 }, { parentId: 999 },
      { orderType: "LMT" }, { action: "BUY" }, { permId: 9999 },
    ]) {
      const b = broker(); b.orders = [{ ...b.orders[0], ...updates }];
      expect(reconcileSPXStop(saved(), b, "DU123", NOW).status).toBe("BLOCK_AND_ALERT");
    }
  });
  it("never lowers the stop to a broker price beneath persisted confirmed protection", () => {
    const b = broker(); b.orders = [{ ...b.orders[0], auxPrice: 3.0 }];
    expect(reconcileSPXStop(saved(), b, "DU123", NOW)).toEqual({
      status: "BLOCK_AND_ALERT", reason: "BROKER_STOP_LOWER_THAN_LAST_CONFIRMED",
    });
  });
  it("can adopt a higher confirmed broker stop, never the stale saved one", () => {
    const b = broker(); b.orders = [{ ...b.orders[0], auxPrice: 3.5 }];
    const result = reconcileSPXStop(saved(), b, "DU123", NOW);
    expect(result.status).toBe("RESUME_MONITORING");
    if (result.status === "RESUME_MONITORING")
      expect(result.recovered.stopState.confirmedStop).toBe(3.5);
  });
  it("blocks multiple holdings and unrelated working orders", () => {
    const b = broker(); b.positions = [...b.positions, { accountId: "DU123", conId: 999, symbol: "MU", secType: "OPT", quantity: 2 }];
    expect(reconcileSPXStop(saved(), b, "DU123", NOW).status).toBe("BLOCK_AND_ALERT");
    const b2 = broker(); b2.orders = [...b2.orders, { ...b2.orders[0], orderId: 12 }];
    expect(reconcileSPXStop(saved(), b2, "DU123", NOW).status).toBe("BLOCK_AND_ALERT");
  });
  it("rejects account switching, incomplete reads and stale snapshots", () => {
    expect(reconcileSPXStop(saved(), broker(), "DU456", NOW).status).toBe("BLOCK_AND_ALERT");
    const b = broker(); b.retrievedAtMs = NOW - 10000;
    expect(reconcileSPXStop(saved(), b, "DU123", NOW).status).toBe("BLOCK_AND_ALERT");
  });
  it("proposes a new raise only from a fresh live option bid", () => {
    const r = reconcileSPXStop(saved(), broker(), "DU123", NOW);
    if (r.status !== "RESUME_MONITORING") throw new Error("missing recovered state");
    const result = previewRecoveredSPXStopRaise(r.recovered, {
      bid: 4, ask: 4.05, timestampMs: NOW + 1,
      connected: true, marketDataType: "LIVE",
    }, NOW + 1);
    expect(result.proposedStop).toBe(3.5);
    expect(result.nextState.confirmedStop).toBe(3.2);
  });
  it("journals an initial stop only when the broker confirms it", () => {
    const b = broker();
    const args = {
      accountId: "DU123", conId: 789123, entryPremium: 3,
      quantity: 1, entryOrderId: 10, stopOrderId: 11,
      right: "CALL" as const, expiry: "20261026", strike: 6000,
      tickSize: 0.01, broker: b, nowMs: NOW,
    };
    expect(createVerifiedSPXStopRecord(args).lastConfirmedStop).toBe(3.2);
    const missing = broker(); missing.orders = [];
    expect(() => createVerifiedSPXStopRecord({ ...args, broker: missing })).toThrow();
    const wrong = broker(); wrong.positions = [];
    expect(() => createVerifiedSPXStopRecord({ ...args, broker: wrong })).toThrow();
    const noPerm = broker(); noPerm.orders = [{ ...noPerm.orders[0], permId: 0 }];
    expect(() => createVerifiedSPXStopRecord({ ...args, broker: noPerm })).toThrow();
  });
  it("does not pretend the proposed stop is broker-confirmed", () => {
    const r = reconcileSPXStop(saved(), broker(), "DU123", NOW);
    if (r.status !== "RESUME_MONITORING") throw new Error("missing recovered state");
    const proposal = previewRecoveredSPXStopRaise(r.recovered, {
      bid: 4, ask: 4.05, timestampMs: NOW + 1,
      connected: true, marketDataType: "LIVE",
    }, NOW + 1);
    const inFlight = { ...r.recovered, stopState: proposal.nextState };
    expect(() => commitConfirmedRecoveredSPXStop(inFlight, 3.5, 12)).toThrow();
    const acknowledged = commitConfirmedRecoveredSPXStop(inFlight, 3.5, 11);
    expect(acknowledged.stopState.confirmedStop).toBe(3.5);
    expect(acknowledged.saved.lastConfirmedStop).toBe(3.5);
    expect(acknowledged.stopState.pendingStop).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  createPremiumStopState, previewPremiumStop, recordConfirmedPremiumStop,
  rejectPendingPremiumStop,
} from "./premium-stop-ladder.js";

const T0 = 1793000000000;
function quote(bid: number, sequence = 1) {
  return { bid, ask: Number((bid + 0.05).toFixed(2)), timestampMs: T0 + sequence,
    connected: true, marketDataType: "LIVE" as const };
}

describe("SPX option premium stop ladder — preview only", () => {
  it("entry $3.00 initializes at stop $1.65", () => {
    expect(createPremiumStopState(3).confirmedStop).toBe(1.65);
  });
  it("$3.50 raises stop to $3.20 only as a proposal", () => {
    const initial = createPremiumStopState(3);
    const result = previewPremiumStop(initial, quote(3.5), T0 + 1);
    expect(result.action).toBe("PREVIEW_ONLY");
    expect(result.proposedStop).toBe(3.2);
    expect(initial.confirmedStop).toBe(1.65);
    expect(result.nextState.confirmedStop).toBe(1.65);
  });
  it("$4.00 sets $3.50; strict breakout at $4.01 sets $4.00", () => {
    let state = createPremiumStopState(3);
    for (const [i, bid, stop] of [[1, 3.5, 3.2], [2, 4, 3.5], [3, 4.01, 4]] as const) {
      const result = previewPremiumStop(state, quote(bid, i), T0 + i);
      expect(result.proposedStop).toBe(stop);
      state = recordConfirmedPremiumStop(result.nextState, stop);
    }
    expect(state.confirmedStop).toBe(4);
  });
  it("$4.50 still protects $4.00; $4.51 proposes $4.50 (provisional)", () => {
    let state = createPremiumStopState(3);
    let result = previewPremiumStop(state, quote(4.01, 1), T0 + 1);
    state = recordConfirmedPremiumStop(result.nextState, 4);
    result = previewPremiumStop(state, quote(4.50, 2), T0 + 2);
    expect(result.proposedStop).toBeNull();
    result = previewPremiumStop(result.nextState, quote(4.51, 3), T0 + 3);
    expect(result.proposedStop).toBe(4.5);
  });
  it("never lowers acknowledged stop on pullback", () => {
    let state = createPremiumStopState(3);
    const up = previewPremiumStop(state, quote(4.01), T0 + 1);
    state = recordConfirmedPremiumStop(up.nextState, 4);
    const down = previewPremiumStop(state, quote(3.5, 2), T0 + 2);
    expect(down.reason).toBe("AT_OR_BELOW_EXISTING_STOP");
    expect(down.nextState.confirmedStop).toBe(4);
    expect(down.proposedStop).toBeNull();
  });
  it("no duplicate pending order update", () => {
    const s = createPremiumStopState(3);
    const first = previewPremiumStop(s, quote(3.5, 1), T0 + 1);
    const second = previewPremiumStop(first.nextState, quote(4, 2), T0 + 2);
    expect(second.reason).toBe("PENDING_ACK");
    expect(second.nextState.pendingStop).toBe(3.2);
    expect(second.nextState.peakBid).toBe(4);
  });
  it("reject broker amendment preserves old stop", () => {
    const first = previewPremiumStop(createPremiumStopState(3), quote(3.5), T0 + 1);
    const recovered = rejectPendingPremiumStop(first.nextState);
    expect(recovered.confirmedStop).toBe(1.65);
    expect(recovered.pendingStop).toBeNull();
  });
  it("broker ack must match the proposed stop; no fabricated confirmation", () => {
    const first = previewPremiumStop(createPremiumStopState(3), quote(3.5), T0 + 1);
    expect(() => recordConfirmedPremiumStop(first.nextState, 3)).toThrow();
  });
  it("delayed and disconnected data cannot update a stop", () => {
    const s = createPremiumStopState(3);
    expect(previewPremiumStop(s, { ...quote(4), marketDataType: "DELAYED" }, T0 + 1).reason).toBe("NOT_LIVE_DATA");
    expect(previewPremiumStop(s, { ...quote(4), connected: false }, T0 + 1).reason).toBe("DISCONNECTED");
  });
  it("stale, future, duplicate and invalid quotes are rejected", () => {
    const s = createPremiumStopState(3);
    expect(previewPremiumStop(s, quote(4), T0 + 4000).reason).toBe("STALE_OR_FUTURE_QUOTE");
    expect(previewPremiumStop(s, quote(4, 2), T0 + 1).reason).toBe("STALE_OR_FUTURE_QUOTE");
    const a = previewPremiumStop(s, quote(3.1), T0 + 1);
    expect(previewPremiumStop(a.nextState, quote(4), T0 + 1).reason).toBe("OUT_OF_ORDER_QUOTE");
    expect(previewPremiumStop(s, { ...quote(3), ask: 2 }, T0 + 1).reason).toBe("INVALID_MARKET_QUOTE");
  });
  it("uses qualified tick sizes and refuses off-tick entry premium", () => {
    expect(createPremiumStopState(3, { tickSize: 0.05 }).confirmedStop).toBe(1.65);
    expect(() => createPremiumStopState(3.01, { tickSize: 0.05 })).toThrow("ENTRY_NOT_ON_CONTRACT_TICK");
  });
  it("bad configuration and nonpositive entry fail closed", () => {
    expect(() => createPremiumStopState(0)).toThrow();
    expect(() => createPremiumStopState(3, { continuationStep: 0 })).toThrow();
    expect(() => createPremiumStopState(3, { firstTrigger: 2 })).toThrow();
  });
  it("does not change live broker state: only a preview action is emitted", () => {
    const result = previewPremiumStop(createPremiumStopState(3), quote(4.01), T0 + 1);
    expect(result.action).toBe("PREVIEW_ONLY");
    expect(result.proposedStop).toBe(4);
    expect(result.nextState.confirmedStop).toBe(1.65);
  });
});

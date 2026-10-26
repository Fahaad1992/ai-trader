import { describe, expect, it } from "vitest";
import {
  SPX_INITIAL_STOP_LOSS_FRACTION,
  SPX_INITIAL_STOP_RETAINED_FRACTION,
  getSPXInitialPremiumStopRaw,
} from "./spx-premium-risk.js";
import { createPremiumStopState } from "../server/options/premium-stop-ladder.js";

describe("one SPX premium initial stop policy", () => {
  it("is a 45 percent loss of the option premium, not 40 percent", () => {
    expect(SPX_INITIAL_STOP_LOSS_FRACTION).toBe(0.45);
    expect(SPX_INITIAL_STOP_RETAINED_FRACTION).toBe(0.55);
    expect(getSPXInitialPremiumStopRaw(3)).toBeCloseTo(1.65, 8);
    expect(createPremiumStopState(3).confirmedStop).toBe(1.65);
  });
  it("scales based on option premium and rejects invalid entry", () => {
    expect(getSPXInitialPremiumStopRaw(5)).toBeCloseTo(2.75, 8);
    expect(() => getSPXInitialPremiumStopRaw(0)).toThrow();
    expect(() => getSPXInitialPremiumStopRaw(Number.NaN)).toThrow();
  });
});

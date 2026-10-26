/**
 * Single source of truth for SPX long-option premium initial stop.
 *
 * 45% maximum intended loss of the paid option PREMIUM on the initial stop,
 * not 45% of SPX index or of account equity. Stop orders can fill worse.
 * This pure policy is shared by the legacy SPX preview and new paper engine.
 */
export const SPX_INITIAL_STOP_LOSS_FRACTION = 0.45;
export const SPX_INITIAL_STOP_RETAINED_FRACTION = 1 - SPX_INITIAL_STOP_LOSS_FRACTION;

/** Returns an unrounded theoretical stop; the caller must use the actual
 * broker-confirmed option contract's valid tick size before placing orders. */
export function getSPXInitialPremiumStopRaw(entryPremium: number): number {
  if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
    throw new Error("SPX_ENTRY_PREMIUM_INVALID");
  }
  return entryPremium * SPX_INITIAL_STOP_RETAINED_FRACTION;
}

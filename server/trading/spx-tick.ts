/**
 * SPX/SPXW option tick-size normalization.
 *
 * Full-size SPX single-leg options:
 *   premium < 3.00  →  tick = 0.05
 *   premium >= 3.00 →  tick = 0.10
 */

export type RoundDirection = "up" | "down" | "nearest";

function getTick(price: number): number {
  return price < 3.00 ? 0.05 : 0.10;
}

export function roundSPXOptionPrice(price: number, direction: RoundDirection): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  const tick = getTick(price);
  let result: number;
  switch (direction) {
    case "up":
      result = Math.ceil(price / tick) * tick;
      break;
    case "down":
      result = Math.floor(price / tick) * tick;
      break;
    case "nearest":
      result = Math.round(price / tick) * tick;
      break;
  }
  return Math.max(tick, Math.round(result * 100) / 100);
}

/**
 * Round by purpose:
 *   stop (protecting LONG)  → up   (tighter = triggers sooner = more protective)
 *   target                  → up   (ensures minimum profit)
 *   entry limit             → nearest
 *   breakeven/profit lock   → up   (tighter protection)
 *   trailing stop           → up   (tighter = more protective)
 */
export function roundSPXStop(price: number): number {
  return roundSPXOptionPrice(price, "up");
}

export function roundSPXTarget(price: number): number {
  return roundSPXOptionPrice(price, "up");
}

export function roundSPXEntry(price: number): number {
  return roundSPXOptionPrice(price, "nearest");
}

export function isValidSPXTick(price: number): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  const tick = getTick(price);
  const remainder = Math.round((price % tick) * 100) / 100;
  return remainder === 0 || remainder === tick;
}

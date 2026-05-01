/**
 * BE-stop pure logic, extracted from engine.ts (server/trading/be-stop-logic.ts)
 * Imported by tests AND by engine to guarantee a single source of truth.
 *
 * Constants:
 *   MES_STOP_POINTS    = 6
 *   MES_TARGET_POINTS  = 8
 *   BE_TRIGGER_POINTS  = 6
 *   BE_NEW_STOP_POINTS = 1
 *   MES_DOLLARS_PER_POINT = 5  // PnL = points × 5 × quantity
 */

export const MES_STOP_POINTS = 6;
export const MES_TARGET_POINTS = 8;
export const BE_TRIGGER_POINTS = 6;
export const BE_NEW_STOP_POINTS = 1;
export const MES_DOLLARS_PER_POINT = 5;

export type Side = "LONG" | "SHORT";
export interface BeTradeState {
  side: Side;
  entry: number;
  quantity: number;
  initialStopPrice?: number;
  effectiveStopPrice?: number;
  breakEvenTriggerPrice?: number;
  breakEvenStopMoved?: boolean;
  exitReason?: "FIXED_STOP_LOSS" | "BREAK_EVEN_STOP" | "TAKE_PROFIT" | "TRAILING_STOP" | "MANUAL_EXIT" | "UNKNOWN";
  reEntryAllowed?: boolean;
  pnl?: number;
  pnlPoints?: number;
}
export interface ModifyAck {
  ok: boolean;
  status: string;
  reason?: string;
  permId?: number;
}
export type ModifyFn = (newAuxPrice: number) => Promise<ModifyAck>;

export function initialStops(entry: number, side: Side) {
  return {
    stopPrice: side === "LONG" ? entry - MES_STOP_POINTS : entry + MES_STOP_POINTS,
    targetPrice: side === "LONG" ? entry + MES_TARGET_POINTS : entry - MES_TARGET_POINTS,
    triggerPrice: side === "LONG" ? entry + BE_TRIGGER_POINTS : entry - BE_TRIGGER_POINTS,
    newStopPrice: side === "LONG" ? entry + BE_NEW_STOP_POINTS : entry - BE_NEW_STOP_POINTS,
  };
}

export function pnlDollars(entry: number, exit: number, side: Side, quantity: number): number {
  const pts = (side === "LONG" ? exit - entry : entry - exit);
  return Math.round(pts * MES_DOLLARS_PER_POINT * quantity * 100) / 100;
}

/**
 * Process one tick. Returns updated trade state and an action descriptor.
 * In Live mode: when triggered, calls modifyFn() and only sets breakEvenStopMoved=true on ACK.
 * In DRY_RUN mode: never calls modifyFn(); just updates effectiveStopPrice and logs internally.
 */
export interface TickInputs {
  trade: BeTradeState;
  px: number;
  isDryRun: boolean;
  modify?: ModifyFn;          // required when !isDryRun
  hasStopOrderId: boolean;     // gates Live modify call
}
export interface TickOutput {
  trade: BeTradeState;
  beTriggered: boolean;
  modifyCalled: boolean;
  modifyOk: boolean | null;
  blockedReason?: string;
  exit?: { reason: "FIXED_STOP_LOSS" | "BREAK_EVEN_STOP" | "TAKE_PROFIT"; price: number; pnl: number };
  log?: string; // structured tag
}

export async function processTick(inp: TickInputs): Promise<TickOutput> {
  const t = inp.trade;
  if (!t.initialStopPrice) t.initialStopPrice = initialStops(t.entry, t.side).stopPrice;
  if (!t.effectiveStopPrice) t.effectiveStopPrice = t.initialStopPrice;
  if (!t.breakEvenTriggerPrice) t.breakEvenTriggerPrice = initialStops(t.entry, t.side).triggerPrice;

  const target = t.side === "LONG" ? t.entry + MES_TARGET_POINTS : t.entry - MES_TARGET_POINTS;
  const newStop = t.side === "LONG" ? t.entry + BE_NEW_STOP_POINTS : t.entry - BE_NEW_STOP_POINTS;

  let beTriggered = false;
  let modifyCalled = false;
  let modifyOk: boolean | null = null;
  let blockedReason: string | undefined;
  let log: string | undefined;

  // BE check
  const triggered = t.side === "LONG" ? inp.px >= t.breakEvenTriggerPrice : inp.px <= t.breakEvenTriggerPrice;
  if (triggered && !t.breakEvenStopMoved) {
    beTriggered = true;
    if (inp.isDryRun) {
      t.effectiveStopPrice = newStop;
      t.breakEvenStopMoved = true;
      log = "BE_STOP_DRY_RUN";
    } else {
      if (!inp.hasStopOrderId || !inp.modify) {
        blockedReason = "BE_STOP_NO_STOP_ORDER_ID";
        log = "BE_STOP_BLOCKED_NO_ORDER_ID";
      } else {
        modifyCalled = true;
        const ack = await inp.modify(newStop);
        modifyOk = !!ack.ok;
        if (ack.ok) {
          t.effectiveStopPrice = newStop;
          t.breakEvenStopMoved = true;
          log = "BE_STOP_MOVED_LIVE";
        } else {
          blockedReason = "IBKR_STOP_MODIFY_FAILED";
          log = "BE_STOP_MODIFY_FAILED";
        }
      }
    }
  }

  // Exit check (use effective stop)
  const eff = t.effectiveStopPrice ?? t.initialStopPrice!;
  if (t.side === "LONG") {
    if (inp.px <= eff) {
      const reason = t.breakEvenStopMoved ? "BREAK_EVEN_STOP" : "FIXED_STOP_LOSS";
      const pnl = pnlDollars(t.entry, inp.px, t.side, t.quantity);
      t.exitReason = reason; t.pnl = pnl; t.pnlPoints = inp.px - t.entry;
      t.reEntryAllowed = !(reason === "FIXED_STOP_LOSS" && pnl < 0) && !blockedReason;
      return { trade: t, beTriggered, modifyCalled, modifyOk, blockedReason, exit: { reason, price: inp.px, pnl }, log };
    }
    if (inp.px >= target) {
      const pnl = pnlDollars(t.entry, inp.px, t.side, t.quantity);
      t.exitReason = "TAKE_PROFIT"; t.pnl = pnl; t.pnlPoints = inp.px - t.entry;
      t.reEntryAllowed = true && !blockedReason;
      return { trade: t, beTriggered, modifyCalled, modifyOk, blockedReason, exit: { reason: "TAKE_PROFIT", price: inp.px, pnl }, log };
    }
  } else {
    if (inp.px >= eff) {
      const reason = t.breakEvenStopMoved ? "BREAK_EVEN_STOP" : "FIXED_STOP_LOSS";
      const pnl = pnlDollars(t.entry, inp.px, t.side, t.quantity);
      t.exitReason = reason; t.pnl = pnl; t.pnlPoints = t.entry - inp.px;
      t.reEntryAllowed = !(reason === "FIXED_STOP_LOSS" && pnl < 0) && !blockedReason;
      return { trade: t, beTriggered, modifyCalled, modifyOk, blockedReason, exit: { reason, price: inp.px, pnl }, log };
    }
    if (inp.px <= target) {
      const pnl = pnlDollars(t.entry, inp.px, t.side, t.quantity);
      t.exitReason = "TAKE_PROFIT"; t.pnl = pnl; t.pnlPoints = t.entry - inp.px;
      t.reEntryAllowed = true && !blockedReason;
      return { trade: t, beTriggered, modifyCalled, modifyOk, blockedReason, exit: { reason: "TAKE_PROFIT", price: inp.px, pnl }, log };
    }
  }

  return { trade: t, beTriggered, modifyCalled, modifyOk, blockedReason, log };
}

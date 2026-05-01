import { processTick, BeTradeState, ModifyAck, MES_DOLLARS_PER_POINT } from "../be-stop-logic.js";

let pass = 0, fail = 0;
const cases: any[] = [];

async function expect(name: string, cond: boolean, detail: any) {
  if (cond) { pass++; cases.push({ name, ok: true, detail }); }
  else { fail++; cases.push({ name, ok: false, detail }); }
}

function makeTrade(side: "LONG" | "SHORT", entry = 7250, qty = 1): BeTradeState {
  return { side, entry, quantity: qty };
}

async function run() {
  // ---------- T1 LONG DRY_RUN BE-hit ----------
  {
    const t = makeTrade("LONG");
    let modifyCalls = 0;
    const modify = async (_p: number): Promise<ModifyAck> => { modifyCalls++; return { ok: true, status: "Submitted" }; };
    const seq = [7253, 7256.5, 7252, 7251];
    let last;
    for (const px of seq) last = await processTick({ trade: t, px, isDryRun: true, modify, hasStopOrderId: true });
    await expect("T1_LONG_DRY_BE_HIT_exitReason", t.exitReason === "BREAK_EVEN_STOP", { exitReason: t.exitReason });
    await expect("T1_LONG_DRY_BE_HIT_be_moved", t.breakEvenStopMoved === true, { be: t.breakEvenStopMoved });
    await expect("T1_LONG_DRY_BE_HIT_eff_stop_entry+1", t.effectiveStopPrice === 7251, { eff: t.effectiveStopPrice });
    await expect("T1_LONG_DRY_BE_HIT_modify_NOT_called_in_dry_run", modifyCalls === 0, { modifyCalls });
    await expect("T1_LONG_DRY_BE_HIT_re_entry", t.reEntryAllowed === true, { re: t.reEntryAllowed });
    // PnL = 1 point * 5 * 1 = $5 protected profit
    await expect("T1_LONG_DRY_BE_HIT_pnl_dollars", t.pnl === 5, { pnl: t.pnl });
  }
  // ---------- T2 LONG fixed SL (cooldown) ----------
  {
    const t = makeTrade("LONG");
    const modify = async (): Promise<ModifyAck> => ({ ok: true, status: "Submitted" });
    const seq = [7248, 7244];
    for (const px of seq) await processTick({ trade: t, px, isDryRun: true, modify, hasStopOrderId: true });
    await expect("T2_LONG_FIXED_SL_exitReason", t.exitReason === "FIXED_STOP_LOSS", { exitReason: t.exitReason });
    await expect("T2_LONG_FIXED_SL_be_moved_false", t.breakEvenStopMoved === undefined || t.breakEvenStopMoved === false, { be: t.breakEvenStopMoved });
    await expect("T2_LONG_FIXED_SL_re_entry_blocked", t.reEntryAllowed === false, { re: t.reEntryAllowed });
    // PnL = -6 * 5 = -$30
    await expect("T2_LONG_FIXED_SL_pnl_dollars", t.pnl === -30, { pnl: t.pnl });
  }
  // ---------- T3 SHORT DRY_RUN BE-hit ----------
  {
    const t = makeTrade("SHORT");
    let modifyCalls = 0;
    const modify = async (): Promise<ModifyAck> => { modifyCalls++; return { ok: true, status: "Submitted" }; };
    const seq = [7247, 7244, 7248, 7249];
    for (const px of seq) await processTick({ trade: t, px, isDryRun: true, modify, hasStopOrderId: true });
    await expect("T3_SHORT_DRY_BE_HIT_exitReason", t.exitReason === "BREAK_EVEN_STOP", { exitReason: t.exitReason });
    await expect("T3_SHORT_DRY_BE_HIT_eff_stop_entry-1", t.effectiveStopPrice === 7249, { eff: t.effectiveStopPrice });
    await expect("T3_SHORT_DRY_BE_HIT_modify_NOT_called", modifyCalls === 0, { modifyCalls });
    await expect("T3_SHORT_DRY_BE_HIT_pnl_dollars", t.pnl === 5, { pnl: t.pnl });
  }
  // ---------- T4 LIVE modify FAIL ----------
  {
    const t = makeTrade("LONG");
    let modifyCalls = 0;
    const modify = async (): Promise<ModifyAck> => { modifyCalls++; return { ok: false, status: "Rejected", reason: "modify_rejected" }; };
    const r1 = await processTick({ trade: t, px: 7256.5, isDryRun: false, modify, hasStopOrderId: true });
    const r2 = await processTick({ trade: t, px: 7244, isDryRun: false, modify, hasStopOrderId: true });
    await expect("T4_LIVE_FAIL_modify_called_once", modifyCalls === 1, { modifyCalls });
    await expect("T4_LIVE_FAIL_be_moved_false", t.breakEvenStopMoved !== true, { be: t.breakEvenStopMoved });
    await expect("T4_LIVE_FAIL_blockedReason", r1.blockedReason === "IBKR_STOP_MODIFY_FAILED", { blocked: r1.blockedReason });
    await expect("T4_LIVE_FAIL_exit_fixed_sl", t.exitReason === "FIXED_STOP_LOSS", { exitReason: t.exitReason });
    await expect("T4_LIVE_FAIL_re_entry_false", t.reEntryAllowed === false, { re: t.reEntryAllowed });
  }
  // ---------- T5 LIVE modify OK -> BE-stop set after ACK ----------
  {
    const t = makeTrade("LONG");
    let modifyCalls = 0;
    const modify = async (newPx: number): Promise<ModifyAck> => { modifyCalls++; return { ok: true, status: "Submitted", permId: 4242 }; };
    const r1 = await processTick({ trade: t, px: 7256.5, isDryRun: false, modify, hasStopOrderId: true });
    const r2 = await processTick({ trade: t, px: 7251, isDryRun: false, modify, hasStopOrderId: true });
    await expect("T5_LIVE_OK_modify_called_once", modifyCalls === 1, { modifyCalls });
    await expect("T5_LIVE_OK_be_moved_after_ack", t.breakEvenStopMoved === true, { be: t.breakEvenStopMoved });
    await expect("T5_LIVE_OK_eff_stop_entry+1", t.effectiveStopPrice === 7251, { eff: t.effectiveStopPrice });
    await expect("T5_LIVE_OK_exit_break_even", t.exitReason === "BREAK_EVEN_STOP", { exitReason: t.exitReason });
    await expect("T5_LIVE_OK_re_entry_true", t.reEntryAllowed === true, { re: t.reEntryAllowed });
    await expect("T5_LIVE_OK_pnl_dollars_+5", t.pnl === 5, { pnl: t.pnl });
  }

  for (const c of cases) console.log(JSON.stringify(c));
  console.log(`PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(2); });

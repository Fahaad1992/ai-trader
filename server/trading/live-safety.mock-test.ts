// ============================================================
// LIVE EXECUTION SAFETY PACK — STANDALONE MOCK TESTS
// Does NOT import engine.ts, does NOT import ibkr-client.ts runtime,
// does NOT touch Gateway, does NOT send real orders, does NOT use PM2.
// Runs via:  env -i PATH=... tsx live-safety.mock-test.ts
// ============================================================

import { isProtectionReady, classifySilentFailure, type ProtectionCheckInput } from "./live-safety";

let PASS = 0;
let FAIL = 0;
const FAILURES: string[] = [];

function assert(name: string, cond: boolean, expected: any, actual: any) {
  if (cond) {
    console.log(`PASS  | ${name}`);
    PASS++;
  } else {
    console.log(`FAIL  | ${name}\n       expected=${JSON.stringify(expected)}\n       actual=  ${JSON.stringify(actual)}`);
    FAIL++;
    FAILURES.push(name);
  }
}

function section(title: string) {
  console.log(`\n───── ${title} ─────`);
}

// ==========================================================================
// 1) 3-LEG BRACKET STRUCTURE (synthesized, no network)
// We replicate the field-assignment rules from placeBracketOrder and verify
// transmit flags + parentId linkage.
// ==========================================================================
section("TEST 1: 3-leg bracket STRUCTURE");

function buildBracketLegs(entry: number, stop: number, target: number | undefined, qty: number, parentOrderId: number) {
  const useTarget = typeof target === "number" && isFinite(target) && target > 0;
  const ids = {
    parentOrderId,
    targetOrderId: useTarget ? parentOrderId + 1 : undefined,
    stopOrderId: useTarget ? parentOrderId + 2 : parentOrderId + 1,
  };
  const parent = { action: "BUY", totalQuantity: qty, orderType: "LMT", lmtPrice: entry, tif: "DAY", transmit: false };
  const targetLeg = useTarget ? { action: "SELL", totalQuantity: qty, orderType: "LMT", lmtPrice: target!, tif: "GTC", parentId: ids.parentOrderId, transmit: false } : null;
  const stopLeg  = { action: "SELL", totalQuantity: qty, orderType: "STP", auxPrice: stop, tif: "GTC", parentId: ids.parentOrderId, transmit: true };
  return { ids, parent, targetLeg, stopLeg, useTarget };
}

const three = buildBracketLegs(100, 94, 108, 1, 1000);
assert("1a parent.transmit=false", three.parent.transmit === false, false, three.parent.transmit);
assert("1b target.transmit=false", three.targetLeg!.transmit === false, false, three.targetLeg!.transmit);
assert("1c stop.transmit=true",   three.stopLeg.transmit === true,   true,  three.stopLeg.transmit);
assert("1d target.parentId === parentOrderId", three.targetLeg!.parentId === three.ids.parentOrderId, three.ids.parentOrderId, three.targetLeg!.parentId);
assert("1e stop.parentId === parentOrderId",   three.stopLeg.parentId === three.ids.parentOrderId,   three.ids.parentOrderId, three.stopLeg.parentId);
assert("1f target ids ordered (parent<target<stop)", three.ids.parentOrderId < three.ids.targetOrderId! && three.ids.targetOrderId! < three.ids.stopOrderId, "ordered", three.ids);
assert("1g target lmtPrice=108", three.targetLeg!.lmtPrice === 108, 108, three.targetLeg!.lmtPrice);
assert("1h stop auxPrice=94", three.stopLeg.auxPrice === 94, 94, three.stopLeg.auxPrice);

// 2-leg fallback (target undefined)
const two = buildBracketLegs(100, 94, undefined, 1, 2000);
assert("1i 2-leg has no target", two.targetLeg === null && two.useTarget === false, null, two.targetLeg);
assert("1j 2-leg stop still transmits", two.stopLeg.transmit === true, true, two.stopLeg.transmit);
assert("1k 2-leg stop.parentId", two.stopLeg.parentId === two.ids.parentOrderId, two.ids.parentOrderId, two.stopLeg.parentId);

// ==========================================================================
// 2) isProtectionReady — Task A
// ==========================================================================
section("TEST 2: isProtectionReady (2-leg, no target expected)");

const okTwoLeg: ProtectionCheckInput = {
  orderId: 1, status: "Filled", stopOrderId: 2, parentStatus: "Filled", childStopStatus: "Submitted"
};
let r = isProtectionReady(okTwoLeg, false);
assert("2a 2-leg all good → ok=true, reasons=[]", r.ok === true && r.reasons.length === 0, { ok: true, reasons: [] }, r);

r = isProtectionReady({ ...okTwoLeg, stopOrderId: undefined }, false);
assert("2b missing stopOrderId → ok=false", r.ok === false && r.reasons.includes("NO_STOP_ORDER_ID"), "NO_STOP_ORDER_ID in reasons", r.reasons);

r = isProtectionReady({ ...okTwoLeg, childStopStatus: "Rejected" }, false);
assert("2c stop child rejected → ok=false", r.ok === false, false, r.ok);

r = isProtectionReady({ ...okTwoLeg, status: "Rejected", parentStatus: "Rejected" }, false);
assert("2d parent rejected → ok=false", r.ok === false && r.reasons.some(x => x.startsWith("PARENT_DEAD_STATUS")), "PARENT_DEAD_STATUS", r.reasons);

r = isProtectionReady(null, false);
assert("2e null result → ok=false NO_RESULT_OBJECT", r.ok === false && r.reasons.includes("NO_RESULT_OBJECT"), "NO_RESULT_OBJECT", r.reasons);

r = isProtectionReady({ ...okTwoLeg, errorMessage: "Generic IBKR error" }, false);
assert("2f errorMessage present → ok=false", r.ok === false && r.reasons.some(x => x.startsWith("PARENT_ERROR")), "PARENT_ERROR", r.reasons);

section("TEST 3: isProtectionReady (3-leg, target expected)");

const okThreeLeg: ProtectionCheckInput = {
  orderId: 10, status: "Filled", stopOrderId: 12, targetOrderId: 11,
  parentStatus: "Filled", childStopStatus: "Submitted", childTargetStatus: "Submitted"
};
r = isProtectionReady(okThreeLeg, true);
assert("3a 3-leg all good → ok=true", r.ok === true, true, r);

r = isProtectionReady({ ...okThreeLeg, targetOrderId: undefined }, true);
assert("3b missing targetOrderId → ok=false", r.ok === false && r.reasons.includes("NO_TARGET_ORDER_ID"), "NO_TARGET_ORDER_ID", r.reasons);

r = isProtectionReady({ ...okThreeLeg, childTargetStatus: "Rejected" }, true);
assert("3c target child rejected → ok=false", r.ok === false && r.reasons.some(x => x.startsWith("TARGET_CHILD_BAD_STATUS")), "TARGET_CHILD_BAD_STATUS", r.reasons);

r = isProtectionReady({ ...okThreeLeg, childStopStatus: "Rejected" }, true);
assert("3d stop rejected while target ok → ok=false", r.ok === false, false, r.ok);

r = isProtectionReady({ ...okThreeLeg, parentStatus: "Filled", childStopStatus: undefined as any }, true);
assert("3e parent filled, child stop missing → emergencyFlattenPossiblyNeeded=true",
       r.emergencyFlattenPossiblyNeeded === true, true, r.emergencyFlattenPossiblyNeeded);

// ==========================================================================
// 3) classifySilentFailure — Task D
// ==========================================================================
section("TEST 4: classifySilentFailure");

assert("4a null → NO_RESULT", classifySilentFailure(null, false).class === "NO_RESULT", "NO_RESULT", classifySilentFailure(null, false));
assert("4b rejected parent → PARENT_REJECTED", classifySilentFailure({ status: "Rejected" }, false).class === "PARENT_REJECTED", "PARENT_REJECTED", classifySilentFailure({ status: "Rejected" }, false));
assert("4c stop id missing → STOP_ID_MISSING", classifySilentFailure({ status: "Filled" }, false).class === "STOP_ID_MISSING", "STOP_ID_MISSING", classifySilentFailure({ status: "Filled" }, false));
assert("4d stop state bad → STOP_STATE_BAD", classifySilentFailure({ status: "Filled", stopOrderId: 2, childStopStatus: "Rejected" }, false).class === "STOP_STATE_BAD", "STOP_STATE_BAD", classifySilentFailure({ status: "Filled", stopOrderId: 2, childStopStatus: "Rejected" }, false));
assert("4e target id missing (expectTarget=true) → TARGET_ID_MISSING", classifySilentFailure({ status: "Filled", stopOrderId: 2, childStopStatus: "Submitted" }, true).class === "TARGET_ID_MISSING", "TARGET_ID_MISSING", classifySilentFailure({ status: "Filled", stopOrderId: 2, childStopStatus: "Submitted" }, true));
assert("4f target state bad → TARGET_STATE_BAD", classifySilentFailure({ status: "Filled", stopOrderId: 2, targetOrderId: 3, childStopStatus: "Submitted", childTargetStatus: "Rejected" }, true).class === "TARGET_STATE_BAD", "TARGET_STATE_BAD", classifySilentFailure({ status: "Filled", stopOrderId: 2, targetOrderId: 3, childStopStatus: "Submitted", childTargetStatus: "Rejected" }, true));
assert("4g all good → OK", classifySilentFailure(okThreeLeg, true).class === "OK", "OK", classifySilentFailure(okThreeLeg, true));

// ==========================================================================
// 4) SILENT FAILURE → no openTrade registration
// Simulate the engine-side gate: trade is registered ONLY when isProtectionReady.ok
// ==========================================================================
section("TEST 5: silent-failure abort (no openTrade when any failure)");

function simulateRegistration(r: ProtectionCheckInput, expectTarget: boolean) {
  const check = isProtectionReady(r, expectTarget);
  return { registered: check.ok, reasons: check.reasons };
}

assert("5a rejected result → not registered", !simulateRegistration({ status: "Rejected" }, false).registered, "not registered", simulateRegistration({ status: "Rejected" }, false));
assert("5b missing child status → not registered", !simulateRegistration({ status: "Filled", orderId: 1, stopOrderId: 2 }, false).registered, "not registered", simulateRegistration({ status: "Filled", orderId: 1, stopOrderId: 2 }, false));
assert("5c errorMessage present → not registered", !simulateRegistration({ status: "Filled", orderId: 1, stopOrderId: 2, childStopStatus: "Submitted", errorMessage: "fail" }, false).registered, "not registered", simulateRegistration({ status: "Filled", orderId: 1, stopOrderId: 2, childStopStatus: "Submitted", errorMessage: "fail" }, false));
assert("5d missing targetOrderId when expected → not registered", !simulateRegistration({ status: "Filled", orderId: 1, stopOrderId: 2, childStopStatus: "Submitted" }, true).registered, "not registered", simulateRegistration({ status: "Filled", orderId: 1, stopOrderId: 2, childStopStatus: "Submitted" }, true));
assert("5e full 3-leg ok → registered",       simulateRegistration(okThreeLeg, true).registered,  "registered",  simulateRegistration(okThreeLeg, true));

// ==========================================================================
// 5) modifyStopOrder LOGIC VALIDATION (without runtime IB client)
// We replicate input-validation gates of modifyStopOrder and expect:
//  - bad price → BAD_PRICE
//  - bad id    → BAD_STOP_ID
//  - success simulation returns MODIFY_SUBMITTED
//  - unsupported replace path surfaces PENDING_MODIFY_STOP_REPLACE_AUDIT
// ==========================================================================
section("TEST 6: modifyStopOrder validation (local logic only)");

function mockModify(stopOrderId: any, newStopPrice: any, connected: boolean, throwInside: boolean) {
  if (!connected) return { ok: false, status: "NOT_CONNECTED", detail: "IBKR not connected" };
  if (typeof stopOrderId !== "number" || !isFinite(stopOrderId)) return { ok: false, status: "BAD_STOP_ID", detail: `stopOrderId=${stopOrderId}` };
  if (!isFinite(newStopPrice) || newStopPrice <= 0) return { ok: false, status: "BAD_PRICE", detail: `newStopPrice=${newStopPrice}` };
  try {
    if (throwInside) throw new Error("replace not supported");
    return { ok: true, status: "MODIFY_SUBMITTED", detail: `id=${stopOrderId} price=${newStopPrice}` };
  } catch (e: any) {
    return { ok: false, status: "PENDING_MODIFY_STOP_REPLACE_AUDIT", detail: e?.message || String(e) };
  }
}

let m = mockModify(5, 101, true, false);
assert("6a success path → MODIFY_SUBMITTED", m.status === "MODIFY_SUBMITTED" && m.ok === true, "MODIFY_SUBMITTED", m);

m = mockModify(5, -1, true, false);
assert("6b bad price → BAD_PRICE", m.status === "BAD_PRICE" && m.ok === false, "BAD_PRICE", m);

m = mockModify("bad", 100, true, false);
assert("6c bad id → BAD_STOP_ID", m.status === "BAD_STOP_ID" && m.ok === false, "BAD_STOP_ID", m);

m = mockModify(5, 100, false, false);
assert("6d not connected → NOT_CONNECTED", m.status === "NOT_CONNECTED" && m.ok === false, "NOT_CONNECTED", m);

m = mockModify(5, 100, true, true);
assert("6e replace throws → PENDING_MODIFY_STOP_REPLACE_AUDIT (not fake success)",
       m.status === "PENDING_MODIFY_STOP_REPLACE_AUDIT" && m.ok === false,
       "PENDING_MODIFY_STOP_REPLACE_AUDIT", m);

// ==========================================================================
// SUMMARY
// ==========================================================================
console.log(`\n═══════════════════════════════════════════════════════════════`);
console.log(`SUMMARY: PASS=${PASS}  FAIL=${FAIL}  TOTAL=${PASS + FAIL}`);
if (FAIL > 0) {
  console.log(`FAILURES:`);
  for (const f of FAILURES) console.log(`  - ${f}`);
  process.exit(1);
} else {
  console.log("ALL GREEN");
}

// ============================================================
// LIVE EXECUTION SAFETY PACK — pure helpers, no side effects, no IBKR I/O
// Task A: isProtectionReady()  — gate for live trade registration
// Task D: classifySilentFailure() — explicit failure reasons
// Keep this file free of engine or ibkr-client imports (types only).
// ============================================================

export interface ProtectionCheckInput {
  status?: string;
  orderId?: number;
  stopOrderId?: number;
  targetOrderId?: number;
  parentStatus?: string;
  childStopStatus?: string;
  childTargetStatus?: string;
  errorMessage?: string;
  rejectReason?: string;
  code?: number;
}

export interface ProtectionCheckResult {
  ok: boolean;
  reasons: string[]; // why NOT ok; empty if ok
  emergencyFlattenPossiblyNeeded: boolean;
}

// Accepted order-states for a child that is live and protecting the position.
const ACCEPTED_CHILD_STATES = new Set([
  "PreSubmitted",
  "Submitted",
  "Filled",
  "PendingSubmit",
]);

// Statuses that unequivocally mean the order is dead.
const DEAD_PARENT_STATES = new Set([
  "Rejected",
  "Cancelled",
  "Inactive",
  "ApiCancelled",
]);

/**
 * isProtectionReady — Task A
 * Decides whether a placeBracketOrder() result is safe to register as an
 * open live trade. Returns ok=false with reasons[] listing every failure.
 *
 * @param r               result object from placeBracketOrder
 * @param expectTarget    true when 3-leg bracket (target child expected)
 */
export function isProtectionReady(
  r: ProtectionCheckInput | null | undefined,
  expectTarget: boolean
): ProtectionCheckResult {
  const reasons: string[] = [];
  let emergencyFlattenPossiblyNeeded = false;

  if (!r) {
    reasons.push("NO_RESULT_OBJECT");
    return { ok: false, reasons, emergencyFlattenPossiblyNeeded };
  }

  // Parent-side checks
  if (typeof r.orderId !== "number") {
    reasons.push("NO_PARENT_ORDER_ID");
  }
  const parentStatus = r.parentStatus || r.status || "";
  if (DEAD_PARENT_STATES.has(parentStatus)) {
    reasons.push(`PARENT_DEAD_STATUS:${parentStatus}`);
  }
  if (r.errorMessage && r.errorMessage !== "n/a") {
    reasons.push(`PARENT_ERROR:${r.errorMessage}`);
  }

  // Stop child — mandatory
  if (typeof r.stopOrderId !== "number") {
    reasons.push("NO_STOP_ORDER_ID");
  }
  const stopState = r.childStopStatus || "";
  if (!stopState || !ACCEPTED_CHILD_STATES.has(stopState)) {
    reasons.push(`STOP_CHILD_BAD_STATUS:${stopState || "missing"}`);
  }

  // Target child — only required if caller requested 3-leg bracket
  if (expectTarget) {
    if (typeof r.targetOrderId !== "number") {
      reasons.push("NO_TARGET_ORDER_ID");
    }
    const targetState = r.childTargetStatus || "";
    if (!targetState || !ACCEPTED_CHILD_STATES.has(targetState)) {
      reasons.push(`TARGET_CHILD_BAD_STATUS:${targetState || "missing"}`);
    }
  }

  // If parent looks Filled but we have any failure reason, the position may
  // already be live at the broker without protection → flag for audit (but
  // this module does NOT trigger any emergency flatten. Caller decides, and
  // per policy the caller must use PENDING_EMERGENCY_FLATTEN_AUDIT.)
  const parentLooksFilled = parentStatus === "Filled" || (typeof r.orderId === "number" && reasons.includes("STOP_CHILD_BAD_STATUS:missing"));
  if (parentLooksFilled && reasons.length > 0) {
    emergencyFlattenPossiblyNeeded = true;
  }

  return { ok: reasons.length === 0, reasons, emergencyFlattenPossiblyNeeded };
}

/**
 * classifySilentFailure — Task D
 * Turns ambiguous placeBracketOrder results into a concrete failure class.
 */
export function classifySilentFailure(
  r: ProtectionCheckInput | null | undefined,
  expectTarget: boolean
): { class: string; detail: string } {
  if (!r) return { class: "NO_RESULT", detail: "result was null or undefined" };
  const status = r.parentStatus || r.status || "";
  if (DEAD_PARENT_STATES.has(status)) {
    return { class: "PARENT_REJECTED", detail: `${status} code=${r.code ?? "n/a"} msg=${r.errorMessage ?? r.rejectReason ?? "n/a"}` };
  }
  if (typeof r.stopOrderId !== "number") {
    return { class: "STOP_ID_MISSING", detail: "bracket returned without stopOrderId" };
  }
  const stopState = r.childStopStatus || "";
  if (!ACCEPTED_CHILD_STATES.has(stopState)) {
    return { class: "STOP_STATE_BAD", detail: `childStopStatus=${stopState || "missing"}` };
  }
  if (expectTarget) {
    if (typeof r.targetOrderId !== "number") {
      return { class: "TARGET_ID_MISSING", detail: "3-leg expected but targetOrderId absent" };
    }
    const tState = r.childTargetStatus || "";
    if (!ACCEPTED_CHILD_STATES.has(tState)) {
      return { class: "TARGET_STATE_BAD", detail: `childTargetStatus=${tState || "missing"}` };
    }
  }
  return { class: "OK", detail: "all protection checks pass" };
}

// ============================================================
// END OF MODULE
// ============================================================

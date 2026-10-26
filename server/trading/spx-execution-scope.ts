/**
 * Execution scope: long SPX calls or puts ONLY. Not MES, CME futures, equities,
 * SPY/QQQ options, naked short options or generic BUY/SELL order paths.
 * Pure code-level guard, independent of IBKR connection.
 */
export type RequestedPositionIntent = "BUY_TO_OPEN_LONG_CALL" | "BUY_TO_OPEN_LONG_PUT";
export interface LongSPXContractRequest {
  underlying: string;
  secType: string;
  right: "C" | "P" | string;
  action: string;
  quantity: number;
  multiplier: number;
  exchange: string;
}
export type ScopeResult = { allowed: true; intent: RequestedPositionIntent } |
  { allowed: false; reason: string };
export function checkLongSPXOrderScope(q: LongSPXContractRequest): ScopeResult {
  if (q.underlying !== "SPX") return { allowed:false, reason:"ONLY_SPX_INDEX_ALLOWED" };
  if (q.secType !== "OPT") return { allowed:false, reason:"ONLY_SPX_OPTION_CONTRACTS_ALLOWED" };
  if (q.action !== "BUY") return { allowed:false, reason:"SELL_TO_OPEN_AND_NAKED_SHORT_FORBIDDEN" };
  if (q.right !== "C" && q.right !== "P") return { allowed:false, reason:"ONLY_LONG_CALL_OR_LONG_PUT_ALLOWED" };
  if (!Number.isSafeInteger(q.quantity) || q.quantity !== 1 || q.multiplier !== 100)
    return { allowed:false, reason:"ONLY_ONE_STANDARD_OPTION_CONTRACT" };
  if (q.exchange !== "SMART" && q.exchange !== "CBOE")
    return { allowed:false, reason:"SPX_EXCHANGE_NOT_VERIFIED" };
  return { allowed:true, intent:q.right === "C" ? "BUY_TO_OPEN_LONG_CALL" : "BUY_TO_OPEN_LONG_PUT" };
}
export function enforceSPXOnlyRuntime(mode: string): void {
  if (mode !== "spx_options") throw new Error("SPX_ONLY_MODE_REQUIRED_NON_SPX_AND_FUTURES_DISABLED");
}

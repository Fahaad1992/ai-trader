/**
 * True bid/ask event freshness, not the time at which a snapshot is returned.
 * Pure pre-live market data gate, must fail closed.
 */
export interface SPXOptionTickSample {
  bid: number;
  ask: number;
  bidReceivedAtMs: number | null | undefined;
  askReceivedAtMs: number | null | undefined;
  marketDataMode: "live" | "delayed" | "unknown";
}
export type SPXQuoteVerdict =
  | { ok: true; bid: number; ask: number; timestampMs: number }
  | { ok: false; reason: "NOT_LIVE" | "MISSING_OR_CROSSED_BID_ASK" |
      "MISSING_TICK_TIMESTAMPS" | "STALE_OR_FUTURE_TICKS" | "BID_ASK_TIME_SKEW" };
export function verifySPXOptionTick(
  q: SPXOptionTickSample, nowMs: number, maxAgeMs = 2_000,
): SPXQuoteVerdict {
  const block = (reason: Extract<SPXQuoteVerdict, {ok:false}>["reason"]): SPXQuoteVerdict => ({ ok:false, reason });
  if (q.marketDataMode !== "live") return block("NOT_LIVE");
  if (!Number.isFinite(q.bid) || !Number.isFinite(q.ask) ||
      q.bid <= 0 || q.ask <= 0 || q.ask < q.bid) return block("MISSING_OR_CROSSED_BID_ASK");
  const b = q.bidReceivedAtMs, a = q.askReceivedAtMs;
  if (typeof b !== "number" || typeof a !== "number" || !Number.isFinite(b) || !Number.isFinite(a))
    return block("MISSING_TICK_TIMESTAMPS");
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 ||
      b > nowMs || a > nowMs || nowMs - b > maxAgeMs || nowMs - a > maxAgeMs)
    return block("STALE_OR_FUTURE_TICKS");
  if (Math.abs(b - a) > maxAgeMs) return block("BID_ASK_TIME_SKEW");
  return { ok:true, bid:q.bid, ask:q.ask, timestampMs:Math.min(b,a) };
}

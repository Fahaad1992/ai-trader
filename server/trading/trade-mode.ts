import type { BotConfig, BotLog, BotStatus, Trade } from "../../shared/types.js";

export type RuntimeTradeMode = "options" | "futures";

const RAW_TRADE_MODE = String(process.env.TRADE_MODE || "options").trim().toLowerCase();
export const TRADE_MODE: RuntimeTradeMode = RAW_TRADE_MODE === "futures" ? "futures" : "options";

const OPTION_FIELD_KEYS = new Set([
  "optionTicker",
  "contractType",
  "strike",
  "expiry",
  "delta",
  "gamma",
  "theta",
  "vega",
  "iv",
  "volume",
  "openInterest",
  "optionSide",
  "optionType",
  "optionDataSource",
  "contractDetails",
  "greeks",
]);

function stripOptionFields<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stripOptionFields(item)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (OPTION_FIELD_KEYS.has(key)) continue;
    out[key] = nested && typeof nested === "object" ? stripOptionFields(nested) : nested;
  }
  return out as T;
}

export function getTradeMode(): RuntimeTradeMode {
  return TRADE_MODE;
}

export function isFuturesMode(): boolean {
  return TRADE_MODE === "futures";
}

export function isOptionsMode(): boolean {
  return TRADE_MODE === "options";
}

export function getOptionsRuntimeGuardMessage(scope: string): string {
  return `[TRADE_MODE_GUARD] ${scope} disabled because TRADE_MODE=futures`;
}

export function assertOptionsRuntimeAllowed(scope: string): void {
  if (isFuturesMode()) throw new Error(getOptionsRuntimeGuardMessage(scope));
}

export function sanitizeTradeForMode(trade: Trade): Trade {
  if (!isFuturesMode()) return { ...trade, tradeMode: TRADE_MODE };
  const base = stripOptionFields(trade) as Record<string, unknown>;
  base.tradeMode = TRADE_MODE;
  if (typeof trade.underlying === "string") base.symbol = trade.underlying;
  return base as Trade;
}

export function sanitizeLogForMode(log: BotLog): BotLog {
  if (!isFuturesMode()) return { ...log, tradeMode: TRADE_MODE };
  const base = stripOptionFields(log) as Record<string, unknown>;
  base.tradeMode = TRADE_MODE;
  return base as BotLog;
}

export function sanitizeStatusForMode(status: BotStatus): BotStatus {
  return { ...status, tradeMode: TRADE_MODE };
}

export function sanitizeConfigForMode(config: BotConfig): BotConfig {
  return { ...config, tradeMode: TRADE_MODE };
}

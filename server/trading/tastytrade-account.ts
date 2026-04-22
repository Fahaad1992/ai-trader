import { execFileSync } from "node:child_process";

const API_BASE = process.env.TASTYTRADE_API_BASE || "https://api.tastytrade.com";
const SESSION_TOKEN = process.env.TASTYTRADE_SESSION_TOKEN;
const ACCOUNT_NUMBER = process.env.TASTYTRADE_ACCOUNT_NUMBER;
const DAILY_LOSS_LIMIT_PERCENT = Number(process.env.FUTURES_DAILY_LOSS_LIMIT_PERCENT || "30");

export interface TastytradeAccountSnapshot {
  source: "tastytrade-api";
  accountNumber: string;
  accountTypeName?: string;
  marginOrCash?: string;
  futuresApproved: boolean;
  netLiquidatingValue: number;
  dailyLossLimitPercent: number;
  dailyLossLimitAmount: number;
  updatedAt: number;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function apiGet(path: string) {
  if (!SESSION_TOKEN) {
    throw new Error("Missing TASTYTRADE_SESSION_TOKEN");
  }

  const output = execFileSync("curl", [
    "-sS",
    "-H", `Authorization: ${SESSION_TOKEN}`,
    "-H", "Accept: application/json",
    `${API_BASE}${path}`,
  ], { encoding: "utf8" });

  const payload = output ? JSON.parse(output) : null;
  if (payload?.error) {
    throw new Error(`Tastytrade API ${path} failed: ${JSON.stringify(payload.error)}`);
  }
  return payload;
}

function resolvePrimaryAccount() {
  const payload = apiGet("/customers/me/accounts");
  const items = payload?.data?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("No tastytrade accounts returned");
  }

  if (ACCOUNT_NUMBER) {
    const match = items.find((item: any) => item?.account?.["account-number"] === ACCOUNT_NUMBER || item?.["account-number"] === ACCOUNT_NUMBER);
    if (match) return match;
  }

  return items[0];
}

export function readTastytradeAccountSnapshot(): TastytradeAccountSnapshot {
  const accountItem = resolvePrimaryAccount();
  const account = accountItem?.account ?? accountItem ?? {};
  const accountNumber = String(account["account-number"] || ACCOUNT_NUMBER || "").trim();
  if (!accountNumber) {
    throw new Error("Unable to resolve tastytrade account number");
  }

  const balances = apiGet(`/accounts/${encodeURIComponent(accountNumber)}/balances`)?.data ?? {};
  const netLiquidatingValue = asNumber(balances["net-liquidating-value"]);
  const dailyLossLimitAmount = Math.round(netLiquidatingValue * (DAILY_LOSS_LIMIT_PERCENT / 100) * 100) / 100;
  const updatedAtRaw = balances["updated-at"];
  const updatedAt = updatedAtRaw ? Date.parse(String(updatedAtRaw)) : Date.now();

  return {
    source: "tastytrade-api",
    accountNumber,
    accountTypeName: typeof account["account-type-name"] === "string" ? account["account-type-name"] : undefined,
    marginOrCash: typeof account["margin-or-cash"] === "string" ? account["margin-or-cash"] : undefined,
    futuresApproved: Boolean(account["is-futures-approved"]),
    netLiquidatingValue,
    dailyLossLimitPercent: DAILY_LOSS_LIMIT_PERCENT,
    dailyLossLimitAmount,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

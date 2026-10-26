/**
 * Fail-closed broker reconciliation gate. Pure logic: no network and no orders.
 *
 * On every potential entry, require a fresh COMPLETED broker snapshot even
 * when the bot's local SQLite database appears to have no open trades.
 * A disconnected or partially delivered snapshot must NEVER become "empty".
 */
export interface BrokerExposureSnapshot {
  accountId: string;
  fetchedAtMs: number;
  completed: boolean;
  positions: ReadonlyArray<{
    account: string;
    conId: number;
    symbol: string;
    quantity: number;
    secType?: string;
    right?: string;
    expiry?: string;
    strike?: number;
  }>;
  openOrders: ReadonlyArray<{
    orderId: number;
    conId: number;
    symbol: string;
    status: string;
    permId?: number | null;
    secType?: string;
    action?: string;
    orderType?: string;
    auxPrice?: number | null;
    parentId?: number | null;
    totalQuantity?: number;
  }>;
}
export interface BrokerBuyingPowerSnapshot {
  accountId: string;
  availableFunds: number;
  buyingPower: number;
  netLiquidation: number;
  timestamp: number;
}
export interface BrokerEntryGateInput {
  brokerConnected: boolean;
  configuredAccountId: string;
  connectedAccountId: string;
  snapshot: BrokerExposureSnapshot | null;
  balance: BrokerBuyingPowerSnapshot | null;
  localOpenTradeCount: number;
  entryPremium: number;
  quantity: number;
  multiplier: number;
  nowMs: number;
  maxExposureSnapshotAgeMs?: number;
  maxBalanceSnapshotAgeMs?: number;
  minimumFeesReserveUsd?: number;
}
export interface BrokerEntryGateResult {
  allowed: boolean;
  reasons: string[];
  costUsd: number | null;
  fundsUsd: number | null;
}
const fresh = (time: number | undefined, now: number, maxAge: number): boolean =>
  typeof time === "number" && Number.isFinite(time) && Number.isFinite(now) &&
  time <= now && now - time <= maxAge;
const validNum = (n: number): boolean => typeof n === "number" && Number.isFinite(n);

export function checkBrokerEntrySafety(input: BrokerEntryGateInput): BrokerEntryGateResult {
  const reasons: string[] = [];
  const exposureAge = input.maxExposureSnapshotAgeMs ?? 2000;
  const balanceAge = input.maxBalanceSnapshotAgeMs ?? 5000;
  const feeReserve = input.minimumFeesReserveUsd ?? 5;
  const cost = input.entryPremium * input.quantity * input.multiplier;
  if (!input.brokerConnected) reasons.push("BROKER_DISCONNECTED");
  if (!input.configuredAccountId.trim() || !input.connectedAccountId.trim() ||
      input.connectedAccountId !== input.configuredAccountId)
    reasons.push("BROKER_ACCOUNT_LOCK_MISMATCH");
  if (!Number.isInteger(input.localOpenTradeCount) || input.localOpenTradeCount !== 0)
    reasons.push("LOCAL_POSITION_EXISTS_OR_UNVERIFIED");

  const s = input.snapshot;
  if (!s || !s.completed || !fresh(s.fetchedAtMs, input.nowMs, exposureAge) ||
      s.accountId !== input.connectedAccountId)
    reasons.push("BROKER_EXPOSURE_UNKNOWN_OR_STALE");
  else {
    // Any other instrument is deliberately blocking, including manual holdings
    // and foreign-client orders. Never auto-ignore exposure after restart.
    if (!Array.isArray(s.positions) || !Array.isArray(s.openOrders)) {
      reasons.push("BROKER_EXPOSURE_INVALID");
    } else {
      if (s.positions.length !== 0) reasons.push("BROKER_HAS_OPEN_POSITION");
      if (s.openOrders.length !== 0) reasons.push("BROKER_HAS_OPEN_ORDER");
    }
  }
  const b = input.balance;
  if (!b || b.accountId !== input.connectedAccountId ||
      !fresh(b.timestamp, input.nowMs, balanceAge) ||
      !validNum(b.availableFunds) || !validNum(b.buyingPower) ||
      !validNum(b.netLiquidation) || b.netLiquidation <= 0)
    reasons.push("BROKER_BALANCE_UNKNOWN_OR_STALE");
  if (!validNum(cost) || cost <= 0 || !Number.isInteger(input.quantity) ||
      input.quantity !== 1 || input.multiplier !== 100 || !validNum(input.entryPremium) ||
      input.entryPremium <= 0 || !validNum(feeReserve) || feeReserve < 0 ||
      !validNum(exposureAge) || exposureAge <= 0 || exposureAge > 5000 ||
      !validNum(balanceAge) || balanceAge <= 0 || balanceAge > 10000) {
    reasons.push("POSITION_SIZING_INVALID");
  } else if (b && validNum(b.availableFunds) && validNum(b.buyingPower) &&
             (b.availableFunds < cost + feeReserve || b.buyingPower < cost + feeReserve)) {
    reasons.push("INSUFFICIENT_REAL_BROKER_FUNDS");
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    costUsd: validNum(cost) && cost > 0 ? Number(cost.toFixed(2)) : null,
    fundsUsd: b && validNum(b.availableFunds) ? b.availableFunds : null,
  };
}

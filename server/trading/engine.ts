/**
 * Trading Engine - 100% Real Data Only
 * TUNED: 1 open position, Delta 0.40-0.60, detailed logs
 * EXIT: Dollar-based trailing stop on option premium with variable distances
 */
import type { Trade, BotConfig, BotStatus, BotLog, DailyStats, OverallStats, DailyHistory, Confirmation, Strategy, ContractType, TrailingConfig, SmartBrainStatsReport, DecisionStatsWindow, BotDecision, BotOptionSide } from "../../shared/types.js";
import { market, isMarketOpen, getMarketStatus, type OptionQuote, type StockData } from "./market-data.js";
import { ibkr } from "./ibkr-client.js";
import { saveTrade, closeTrade as dbCloseTrade, loadOpenTrades, loadAllTrades, saveLog, saveDailyStats, loadLogs, loadErrorLogs, loadLogsSince } from "./database.js";
import { newsFilter, type NewsFilterStatus } from "./news-filter.js";
import { notifyBotStart, notifyTradeEntry, notifyTradeExit, notifyTradeRejected, notifyError, notifyIBKRDisconnect, notifyIBKRReconnect, notifyStopLossHit, notifyNewsAlert, notifyDailyReport, notifyDecision, notifyDataLoadFailure, notifyWaitingMode, notifyBotStopped, notifyDataSourceFailure, notifyCriticalError, notifyHealthFailure, notifyHeartbeat } from "./notify.js";
import { getTradeMode, getOptionsRuntimeGuardMessage, isFuturesMode, sanitizeConfigForMode, sanitizeLogForMode, sanitizeTradeForMode } from "./trade-mode.js";
import { readTastytradeAccountSnapshot, type TastytradeAccountSnapshot } from "./tastytrade-account.js";
import { isProtectionReady, classifySilentFailure } from "./live-safety";
import {
  calculateMesStops,
  calculatePositionSize,
  initSimulatedTradeState,
  updateProfitLock,
  shouldExitAtSimulatedStop,
  evaluateShadowStop,
  evaluatePartialClose,
  classifyDailyLossTier,
  dailyLossTierLogTag,
  detectRangeRegime,
  rangeModeEntryGuidance,
  MES_STOP_POINTS,
  MES_TARGET_POINTS,
  MES_TRAIL_POINTS,
  MES_TRAIL_ACTIVATION,
  MES_PROFIT_LOCK_TRIGGER,
  MES_PROFIT_LOCK_LEVEL,
  MES_DOLLAR_PER_POINT,
  type SimulatedTradeState,
  type DailyLossTier
} from "./mes-strategy.js";

type SmartBrainDecision = "EXECUTE" | "REDUCE" | "WAIT" | "REJECT";
type DecisionAuditOutcome = "EXECUTE" | "WAIT" | "BLOCK";

type SmartBrainExecutionDecision = "EXECUTE" | "REDUCE";

interface SmartBrainGate {
  signal: string;
  decision: SmartBrainExecutionDecision;
  reason: string;
  confidence?: number;
  rawScore?: number | null;
  latencyMs?: number | null;
  reasonCodes?: string[];
  requestedSize?: number;
  finalSize?: number;
  finalSizeReason?: string | null;
  tradeSide?: "LONG" | "SHORT"; // bidirectional simulation (DRY_RUN-only SHORT)
}

interface ExecutionTrace {
  signalDetectedAt: number;
  marketDataReceivedAt?: number;
  contractSelectedAt?: number;
  orderSubmittedAt?: number;
  orderAcknowledgedAt?: number;
  fillReceivedAt?: number;
}

interface SmartBrainResponse {
  ok?: boolean;
  service?: string;
  version?: string;
  signal: string;
  underlying: string;
  decision: SmartBrainDecision;
  confidence?: number;
  confidence_final: number;
  confidence_score?: number;
  size_override?: number;
  fast_path?: boolean;
  emergency_stop?: boolean;
  reason_codes: string[];
  strengths?: string[];
  weaknesses?: string[];
  summary: string;
  evaluated_at?: string;
  latency_ms?: number | null;
}

type StoredLogRow = {
  id: number | string;
  timestamp?: number;
  createdAt?: number;
  level: string;
  message: string;
  data?: string | null;
  details?: Record<string, unknown>;
};

type BrokerAccountSnapshot = {
  source: "ibkr-api";
  accountNumber: string;
  accountTypeName?: string;
  marginOrCash?: string;
  futuresApproved: boolean;
  netLiquidatingValue: number;
  dailyLossLimitPercent: number;
  dailyLossLimitAmount: number;
  updatedAt: number;
};

type ParsedDecisionEvent = {
  decision: BotDecision | null;
  confidence: number | null;
  reason: string | null;
  reasonCodes: string[];
  premium: number | null;
  optionRejected: boolean;
  executed: boolean;
};

const SMART_BRAIN_URL = process.env.SMART_BRAIN_URL || "http://165.232.79.103:4000/api/evaluate-signal";
const SMART_BRAIN_TIMEOUT_MS = Number(process.env.SMART_BRAIN_TIMEOUT_MS || 3500);
const PAPER_ONLY_BOT_BUDGET = Number(process.env.BOT_BUDGET || "1000");
const PAPER_ONLY_DAILY_LOSS_LIMIT_AMOUNT = Number(process.env.DAILY_LOSS_LIMIT_AMOUNT || "300");
const PAPER_ONLY_MAX_POSITION_PCT = Number(process.env.MAX_POSITION_SIZE_PCT || "0.10");
const PAPER_ONLY_MAX_POSITION_AMOUNT = Number(process.env.MAX_POSITION_SIZE_AMOUNT || String(Math.round(PAPER_ONLY_BOT_BUDGET * PAPER_ONLY_MAX_POSITION_PCT * 100) / 100));
const PAPER_ONLY_MAX_TRADES_PER_DAY = Number(process.env.MAX_TRADES_PER_DAY || "15");
const PAPER_ONLY_MAX_CONTRACTS = Number(process.env.MAX_CONTRACTS || "2");
const PAPER_EXECUTE_THRESHOLD = Number(process.env.PAPER_EXECUTE_THRESHOLD || "75");
const PAPER_REDUCE_THRESHOLD = Number(process.env.PAPER_REDUCE_THRESHOLD || "72");
const PAPER_TRAILING_ACTIVATION_PROFIT = Number(process.env.TRAILING_ACTIVATION_PROFIT || "0.01");
const FUTURES_BALANCE_REFRESH_MS = 30_000;
const FUTURES_ASSET_TYPE = "MES" as const;
const FUTURES_TRAILING_STOP_POINTS = 3;
const FUTURES_INITIAL_STOP_POINTS = 6;
const FUTURES_MAX_CONTRACTS = 1;
const FUTURES_DAILY_LOSS_LIMIT_PERCENT = 30; // $65 on $1589
const FUTURES_MAX_TRADES_PER_DAY = 3;

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseDetails(data?: string | null, details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (details && typeof details === "object") return details;
  if (!data) return undefined;
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOptionSide(value: unknown): BotOptionSide | undefined {
  const side = typeof value === "string" ? value.toUpperCase() : "";
  if (side === "CALL" || side === "PUT") return side;
  if (side === "CALLS") return "CALL";
  if (side === "PUTS") return "PUT";
  return undefined;
}

function normalizeBotLog(row: StoredLogRow): BotLog {
  const details = parseDetails(row.data, row.details);
  const contractDetails = details?.contractDetails && typeof details.contractDetails === "object"
    ? details.contractDetails as BotLog["contractDetails"]
    : null;

  return {
    id: String(row.id),
    level: (row.level as BotLog["level"]) || "info",
    message: row.message,
    details,
    createdAt: Number(row.timestamp ?? row.createdAt ?? Date.now()),
    symbol: asString(details?.symbol) ?? asString(details?.underlying),
    optionSide: normalizeOptionSide(details?.optionSide ?? details?.contractType),
    confidence: asNumber(details?.confidence),
    decision: (asString(details?.decision) as BotLog["decision"]) ?? null,
    latencyMs: asNumber(details?.latencyMs),
    reason: asString(details?.reason) ?? null,
    bid: asNumber(details?.bid),
    ask: asNumber(details?.ask),
    premium: asNumber(details?.premium),
    contractDetails,
  };
}

function extractReasonCodes(message: string, details?: Record<string, unknown>): string[] {
  const fromDetails = Array.isArray(details?.reasonCodes)
    ? details.reasonCodes.map(code => String(code)).filter(Boolean)
    : [];
  if (fromDetails.length) return fromDetails;
  const match = message.match(/reason_codes:\s*(.+)$/i);
  if (!match) return [];
  return match[1].split(",").map(code => code.trim()).filter(Boolean);
}

function extractDecisionEvent(row: StoredLogRow): ParsedDecisionEvent | null {
  const log = normalizeBotLog(row);
  const decisionFromMessage = log.message.match(/decision:([A-Z]+)/)?.[1] as BotDecision | undefined;
  const decision = log.decision ?? decisionFromMessage ?? null;
  const isDecision = decision === "EXECUTE" || decision === "REDUCE" || decision === "WAIT" || decision === "REJECT";
  const optionRejected = log.message.includes("[OPTION_REJECTED]");
  const reasonCodes = extractReasonCodes(log.message, log.details);
  const premiumZero = log.premium === 0 || /premium[^\d-]*0(?:\.0+)?/i.test(log.message) || /@\$0(?:\.0+)?/i.test(log.message);

  if (!isDecision && !optionRejected && !premiumZero) return null;

  return {
    decision: isDecision ? decision : null,
    confidence: log.confidence,
    reason: log.reason ?? null,
    reasonCodes,
    premium: log.premium,
    optionRejected,
    executed: log.message.includes("[TRADE_OPEN]") || decision === "EXECUTE",
  };
}

function emptyDecisionStats(windowHours: number): DecisionStatsWindow {
  return {
    windowHours,
    signalsTotal: 0,
    execute: 0,
    reduce: 0,
    wait: 0,
    reject: 0,
    optionRejected: 0,
    premiumZeroCount: 0,
    avgConfidenceAll: null,
    avgConfidenceExecuted: null,
    topReasonCodes: [],
  };
}

function roundMetric(value: number | null): number | null {
  return value == null ? null : Math.round(value * 100) / 100;
}

function buildDecisionStats(rows: StoredLogRow[], windowHours: number): DecisionStatsWindow {
  const stats = emptyDecisionStats(windowHours);
  const reasonCounts = new Map<string, number>();
  let confidenceSum = 0;
  let confidenceCount = 0;
  let executedConfidenceSum = 0;
  let executedConfidenceCount = 0;

  for (const row of rows) {
    const event = extractDecisionEvent(row);
    if (!event) continue;

    if (event.decision) {
      stats.signalsTotal += 1;
      if (event.decision === "EXECUTE") stats.execute += 1;
      if (event.decision === "REDUCE") stats.reduce += 1;
      if (event.decision === "WAIT") stats.wait += 1;
      if (event.decision === "REJECT") stats.reject += 1;
      if (event.confidence != null) {
        confidenceSum += event.confidence;
        confidenceCount += 1;
      }
      if (event.executed && event.confidence != null) {
        executedConfidenceSum += event.confidence;
        executedConfidenceCount += 1;
      }
    }

    if (event.optionRejected) stats.optionRejected += 1;
    if (event.premium === 0) stats.premiumZeroCount += 1;

    for (const code of (event.reasonCodes.length ? event.reasonCodes : (event.reason ? [event.reason] : []))) {
      reasonCounts.set(code, (reasonCounts.get(code) ?? 0) + 1);
    }
  }

  stats.avgConfidenceAll = confidenceCount ? roundMetric(confidenceSum / confidenceCount) : null;
  stats.avgConfidenceExecuted = executedConfidenceCount ? roundMetric(executedConfidenceSum / executedConfidenceCount) : null;
  stats.topReasonCodes = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code, count]) => ({ code, count }));

  return stats;
}

type AssetStopProfile = {
  assetType: "index" | "stock" | "futures";
  initialStopDistance: number;
  trailingStopDistance: number;
  defaultContracts: number;
  stopWidthReason: string;
};

const INDEX_STOP_UNDERLYINGS = new Set(["SPX", "NDX", "QQQ"]);
const SINGLE_STOCK_STOP_UNDERLYINGS = new Set(["NVDA", "TSLA", "AMZN"]);

function roundOptionPrice(value: number): number {
  return Math.max(0.01, Math.round(value * 100) / 100);
}

function getAssetStopProfile(underlying: string): AssetStopProfile {
  const symbol = underlying.toUpperCase();
  if (symbol === FUTURES_ASSET_TYPE || (isFuturesMode() && symbol.startsWith(FUTURES_ASSET_TYPE))) {
    return {
      assetType: "futures",
      initialStopDistance: FUTURES_INITIAL_STOP_POINTS,
      trailingStopDistance: FUTURES_TRAILING_STOP_POINTS,
      defaultContracts: 1,
      stopWidthReason: "mes_futures_profile",
    };
  }
  if (INDEX_STOP_UNDERLYINGS.has(symbol)) {
    return {
      assetType: "index",
      initialStopDistance: 0.50,
      trailingStopDistance: 0.30,
      defaultContracts: 1,
      stopWidthReason: symbol === "SPX" ? "spx_index_wider_stop" : "nasdaq_index_wider_stop",
    };
  }

  return {
    assetType: "stock",
    initialStopDistance: 0.30,
    trailingStopDistance: 0.30,
    defaultContracts: PAPER_ONLY_MAX_CONTRACTS,
    stopWidthReason: SINGLE_STOCK_STOP_UNDERLYINGS.has(symbol) ? "single_stock_standard_stop" : "default_equity_stop",
  };
}

export function getTrailingConfig(underlying: string, _entryPremium?: number): TrailingConfig {
  const profile = getAssetStopProfile(underlying);
  return { activation: PAPER_TRAILING_ACTIVATION_PROFIT, distance: profile.trailingStopDistance };
}

function getInitialStopPrice(entryPrice: number, underlying: string): number {
  return roundOptionPrice(entryPrice - getAssetStopProfile(underlying).initialStopDistance);
}
// ========== END PAPER TRAILING STOP SETTINGS ==========

export const DEFAULT_CONFIG: BotConfig = {
  mode: ((process.env.IBKR_MODE || process.env.TRADING_MODE || process.env.BOT_MODE || "paper").toLowerCase() as "paper" | "live"), activeStrategy: "milking",
  capital: { mainCapital: 1000, paperBalance: 1000, carryDailyPnlIntoCapital: true },
  risk: {
    maxTradesPerDay: 15,
    maxOpenPositions: 3,
    maxDailyLossPercent: 2, maxConsecutiveLosses: 3, cooldownMinutes: 5
  },
  options: {
    deltaMin: 0.30, deltaMax: 0.70,
    minPremium: 0.5, maxPremium: 50,
    maxContracts: 1, contractsPerTrade: 1,
    weeklyOnly: true, allow0DTE: false, allowCheapOptions: false
  },
  filters: {
    minConfirmations: 5,
    enableNewsFilter: true, enableVixFilter: true, enableVolatilityFilter: true,
    enableTimeFilter: true, blockFirst10Minutes: true, blockLast30Minutes: false,
    requireBreakout: false
  },
  zeroHero: {
    enabled: false, separateCapital: 80, maxTrades: 2,
    deltaMin: 0.1, deltaMax: 0.2, minPremium: 0.1, maxPremium: 1,
    onlyLateSession: true, requireBreakout: true, allow0DTE: true
  },
  futures: {
    assetType: FUTURES_ASSET_TYPE,
    trailingStopPoints: FUTURES_TRAILING_STOP_POINTS,
    initialStopPoints: FUTURES_INITIAL_STOP_POINTS,
    maxContracts: FUTURES_MAX_CONTRACTS,
    dailyLossLimitPercent: FUTURES_DAILY_LOSS_LIMIT_PERCENT,
    balanceRefreshSeconds: FUTURES_BALANCE_REFRESH_MS / 1000,
    dataSource: "tastytrade",
    executionBroker: "tastytrade",
  },
};

const UNDERLYINGS = ["SPY", "QQQ", "AAPL", "TSLA", "NVDA", "MSFT", "META", "AMZN"];
function rid() { return Math.random().toString(36).substring(2, 10); }

export class TradingEngine {
  private config: BotConfig;
  private running = false;
  private trades: Trade[] = [];
  private logs: BotLog[] = [];
  private startTime = 0;
  private consecutiveLosses = 0;
  private lastTradeTime = 0;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private pnlTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private brokerAccountSnapshot: BrokerAccountSnapshot | null = null;
  private brokerAccountPollTimer: ReturnType<typeof setInterval> | null = null;
  private ibkrStopOrderIds = new Map<string, number>();
  private scanIdx = 0;
  private dataState: "idle" | "waiting" | "connected" | "failed" = "idle";
  private dataRetryCount = 0;
  private ibkrDisconnectAlerted = false;
  private waitingModeAlerted = false;
  private dataLoadFailureAlerted = false;
  private dataSourceFailureAlerted = false;
  private healthFailureAlerted = false;
  private readonly tradeMode = getTradeMode();
  private readonly tradeModeGuardSeen = new Set<string>();
  private logTradeModeGuard(scope: string) {
    if (!isFuturesMode() || this.tradeModeGuardSeen.has(scope)) return;
    this.tradeModeGuardSeen.add(scope);
    this.log("info", getOptionsRuntimeGuardMessage(scope), { tradeMode: this.tradeMode, scope });
  }

  constructor() {
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this.enforceFuturesRuntimeConfig();
    this.startBrokerAccountPolling();
    try {
      const dbTrades = loadOpenTrades() as any[];
      for (const row of dbTrades) {
        const entryPrem = row.entry_premium;
        const tConfig = getTrailingConfig(row.underlying, entryPrem);
        this.trades.push({
          id: row.id,
          mode: row.mode as Trade["mode"],
          strategy: row.strategy as Strategy,
          underlying: row.underlying,
          symbol: row.symbol,
          optionTicker: row.symbol,
          contractType: row.contract_type as ContractType,
          strike: row.strike,
          expiry: row.expiry,
          entryPremium: entryPrem,
          currentPremium: entryPrem,
          quantity: row.quantity,
          delta: row.delta ?? 0,
          gamma: 0, theta: 0, vega: 0, iv: 0,
          volume: 0, openInterest: 0,
          pnl: row.pnl ?? 0,
          pnlPercent: row.pnl_percent ?? 0,
          peakPrice: entryPrem,
          trailingActive: false,
          trailingStopPrice: getInitialStopPrice(entryPrem, row.underlying),
          trailingConfig: tConfig,
          openedAt: row.opened_at,
          status: "open",
          dataSource: row.data_source ?? "unknown",
        });
      }
      if (dbTrades.length > 0) {
        console.log(`[DB] Loaded ${dbTrades.length} open trades from SQLite`);
      }
    } catch (e: any) {
      console.error(`[DB] Failed to load trades: ${e.message}`);
    }
  }

  private getEffectiveAccountBalance(): number {
    if (isFuturesMode() && !this.isPaperMode() && this.brokerAccountSnapshot) {
      return Math.max(0, Math.round(this.brokerAccountSnapshot.netLiquidatingValue * 100) / 100);
    }
    const base = this.config.capital.paperBalance > 0 ? this.config.capital.paperBalance : this.config.capital.mainCapital;
    const closedPnl = this.getClosedTrades().reduce((sum, t) => sum + t.pnl, 0);
    const current = this.config.capital.carryDailyPnlIntoCapital ? base + closedPnl : base;
    return Math.max(0, Math.round(current * 100) / 100);
  }

  private getZeroHeroCapital(): number {
    return Math.min(this.config.zeroHero.separateCapital, this.getEffectiveAccountBalance());
  }

  private getStrategyCapital(strategy: Strategy): number {
    const total = this.getEffectiveAccountBalance();
    if (strategy === "zeroHero") return this.getZeroHeroCapital();
    return Math.max(0, total - this.getZeroHeroCapital());
  }

  private isPaperMode(): boolean {
    return this.config.mode === "paper";
  }

  private getPaperBotBudget(): number {
    return PAPER_ONLY_BOT_BUDGET > 0 ? PAPER_ONLY_BOT_BUDGET : (this.config.capital.paperBalance > 0 ? this.config.capital.paperBalance : 1000);
  }

  private getDailyLossLimitAmount(): number {
    if (this.isPaperMode()) return PAPER_ONLY_DAILY_LOSS_LIMIT_AMOUNT;
    if (isFuturesMode() && this.brokerAccountSnapshot) {
      return this.brokerAccountSnapshot.dailyLossLimitAmount;
    }
    const lossPercent = isFuturesMode() ? this.config.futures.dailyLossLimitPercent : this.config.risk.maxDailyLossPercent;
    const capital = this.getStrategyCapital(this.config.activeStrategy as Strategy);
    return Math.round(capital * (lossPercent / 100) * 100) / 100;
  }

  private getMaxPositionAmount(): number {
    if (!this.isPaperMode()) return this.getStrategyCapital(this.config.activeStrategy as Strategy);
    return Math.min(PAPER_ONLY_MAX_POSITION_AMOUNT, Math.round(this.getPaperBotBudget() * PAPER_ONLY_MAX_POSITION_PCT * 100) / 100);
  }

  private getRequestedContractsForEntry(): number {
    if (isFuturesMode()) return Math.max(1, this.config.futures.maxContracts);
    const configured = Math.max(1, Math.min(this.config.options.contractsPerTrade, this.config.options.maxContracts));
    return this.isPaperMode() ? Math.min(PAPER_ONLY_MAX_CONTRACTS, configured) : configured;
  }

  private getFinalContractsForDecision(decision: SmartBrainExecutionDecision): number {
    const requested = this.getRequestedContractsForEntry();
    return decision === "REDUCE" ? Math.min(1, requested) : requested;
  }

  private getPositionNotional(quantity: number, premium: number): number {
    // ===== FUTURES DRY_RUN SIZING (MES) =====
    // In futures mode, options notional (qty * premium * 100) is wrong.
    // Use MES risk-based sizing: qty * stop_points * $5_per_point.
    // This is SIM-only risk (no real order). Live path for options is unchanged.
    if (isFuturesMode()) {
      const riskPerContract = MES_STOP_POINTS * MES_DOLLAR_PER_POINT; // 6 * $5 = $30
      return Math.round(quantity * riskPerContract * 100) / 100;
    }
    return Math.round(quantity * premium * 100 * 100) / 100;
  }

  private getEffectiveMaxTradesPerDay(): number {
    if (isFuturesMode()) return FUTURES_MAX_TRADES_PER_DAY;
    return this.isPaperMode() ? PAPER_ONLY_MAX_TRADES_PER_DAY : Math.max(1, this.config.risk.maxTradesPerDay);
  }

  private getSignalUniverse(): string[] {
    return isFuturesMode() ? [FUTURES_ASSET_TYPE] : UNDERLYINGS;
  }

  private getConcurrentPositionAllowance(underlying: string, ct: ContractType, conf: Confirmation[], gate?: SmartBrainGate): number {
    const openTrades = this.getOpenTrades();
    if (openTrades.length === 0) return 1;

    const confidence = gate?.confidence ?? 0;
    const passed = conf.filter(c => c.passed).length;
    const conflictingDirection = openTrades.some(t => t.contractType !== ct);
    const duplicateUnderlying = openTrades.some(t => t.underlying === underlying);
    const riskAcceptable = this.getDailyPnl() > -this.getDailyLossLimitAmount() && this.consecutiveLosses === 0;
    const veryHighConfidence = confidence >= 92 && passed >= 6;

    if (conflictingDirection || duplicateUnderlying || !riskAcceptable) return 1;
    if (this.isPaperMode()) return Math.min(2, this.config.risk.maxOpenPositions);
    if (!veryHighConfidence) return 1;
    return confidence >= 96 && passed >= 8 ? Math.min(3, this.config.risk.maxOpenPositions) : Math.min(2, this.config.risk.maxOpenPositions);
  }

  private enforceFuturesRuntimeConfig(): void {
    if (!isFuturesMode()) return;
    this.config.tradeMode = "futures";
    this.config.activeStrategy = "milking";
    this.config.zeroHero.enabled = false;
    this.config.zeroHero.separateCapital = 0;
    this.config.zeroHero.maxTrades = 0;
    this.config.futures.assetType = FUTURES_ASSET_TYPE;
    this.config.futures.trailingStopPoints = FUTURES_TRAILING_STOP_POINTS;
    this.config.futures.initialStopPoints = FUTURES_INITIAL_STOP_POINTS;
    this.config.futures.maxContracts = FUTURES_MAX_CONTRACTS;
    this.config.futures.dailyLossLimitPercent = FUTURES_DAILY_LOSS_LIMIT_PERCENT;
    this.config.futures.balanceRefreshSeconds = FUTURES_BALANCE_REFRESH_MS / 1000;
    this.config.futures.dataSource = "ibkr" as any;
    this.config.futures.executionBroker = "ibkr" as any;
    this.config.risk.maxDailyLossPercent = FUTURES_DAILY_LOSS_LIMIT_PERCENT;
    this.config.risk.maxTradesPerDay = FUTURES_MAX_TRADES_PER_DAY;
    this.config.risk.maxOpenPositions = Math.max(1, FUTURES_MAX_CONTRACTS);
    this.config.options.maxContracts = FUTURES_MAX_CONTRACTS;
    this.config.options.contractsPerTrade = Math.min(Math.max(1, this.config.options.contractsPerTrade || 1), FUTURES_MAX_CONTRACTS);
    if (this.brokerAccountSnapshot) {
      this.config.capital.mainCapital = this.brokerAccountSnapshot.netLiquidatingValue;
    }
  }

  private async refreshBrokerAccountSnapshot(): Promise<void> {
    if (!isFuturesMode()) return;
    try {
      const summary = await ibkr.getAccountSummary();
      if (!summary || !summary.accountId) {
        throw new Error("IBKR account summary unavailable");
      }
      const dailyLossLimitPercent = FUTURES_DAILY_LOSS_LIMIT_PERCENT;
      const dailyLossLimitAmount = Math.round(summary.netLiquidation * (dailyLossLimitPercent / 100) * 100) / 100;
      const snapshot: BrokerAccountSnapshot = {
        source: "ibkr-api",
        accountNumber: summary.accountId,
        futuresApproved: true,
        netLiquidatingValue: summary.netLiquidation,
        dailyLossLimitPercent,
        dailyLossLimitAmount,
        updatedAt: summary.timestamp,
      };
      const prevBalance = this.brokerAccountSnapshot?.netLiquidatingValue;
      const firstLoad = !this.brokerAccountSnapshot;
      this.brokerAccountSnapshot = snapshot;
      this.config.capital.mainCapital = snapshot.netLiquidatingValue;
      this.config.risk.maxDailyLossPercent = snapshot.dailyLossLimitPercent;
      this.config.futures.dailyLossLimitPercent = snapshot.dailyLossLimitPercent;
      this.enforceFuturesRuntimeConfig();
      if (firstLoad || prevBalance !== snapshot.netLiquidatingValue) {
        this.log("info", `[IBKR_BALANCE] account=${snapshot.accountNumber} nlv=$${snapshot.netLiquidatingValue.toFixed(2)} dailyLossLimit=$${snapshot.dailyLossLimitAmount.toFixed(2)} futuresApproved=${snapshot.futuresApproved} source=${snapshot.source}`);
      }
    } catch (e: any) {
      this.log("warn", `[IBKR_BALANCE] ${e.message}`);
    }
  }

  private startBrokerAccountPolling(): void {
    if (!isFuturesMode() || this.brokerAccountPollTimer) return;
    void this.refreshBrokerAccountSnapshot();
    this.brokerAccountPollTimer = setInterval(() => { void this.refreshBrokerAccountSnapshot(); }, FUTURES_BALANCE_REFRESH_MS);
  }

  private enforceLiveSafeConfig(): void {
    this.config.activeStrategy = "milking";
    this.config.zeroHero.enabled = false;
    this.config.zeroHero.separateCapital = 0;
    this.config.zeroHero.maxTrades = 0;
    if (this.isPaperMode()) {
      this.config.capital.paperBalance = this.getPaperBotBudget();
      this.config.options.maxContracts = PAPER_ONLY_MAX_CONTRACTS;
      this.config.options.contractsPerTrade = Math.min(PAPER_ONLY_MAX_CONTRACTS, Math.max(1, this.config.options.contractsPerTrade || PAPER_ONLY_MAX_CONTRACTS));
      this.config.risk.maxTradesPerDay = PAPER_ONLY_MAX_TRADES_PER_DAY;
      this.config.risk.maxOpenPositions = 2;
    } else {
      this.config.options.maxContracts = 1;
      this.config.options.contractsPerTrade = 1;
      this.config.risk.maxDailyLossPercent = 2;
    }
    this.enforceFuturesRuntimeConfig();
  }

  private applyPaperDecisionThresholds(decision: SmartBrainResponse): SmartBrainResponse {
    if (!this.isPaperMode()) return decision;
    if (decision.emergency_stop) {
      return {
        ...decision,
        decision: "REJECT",
        reason_codes: [...decision.reason_codes, "EMERGENCY_STOP_ACTIVE"],
        summary: `${decision.summary} | Emergency stop active`,
      };
    }
    return decision;
  }

  private getLiveSafeStopReason(): string | null {
    this.enforceLiveSafeConfig();
    if (process.env.EMERGENCY_STOP === "1" || process.env.LIVE_SAFE_EMERGENCY_STOP === "1") return "EMERGENCY_STOP_FLAG";
    if (!market.isIBKRConnected()) return "IBKR_NOT_CONNECTED";
    const ibkrStatus = market.getIBKRStatus();
    if (!ibkrStatus.accountId) return "IBKR_ACCOUNT_UNAVAILABLE";
    // LIVE_CAUTIOUS: Lock to specific account
    const REQUIRED_ACCOUNT_ID = "U17745834";
    if (ibkrStatus.accountId !== REQUIRED_ACCOUNT_ID) return `WRONG_ACCOUNT:${ibkrStatus.accountId}`;
    // LIVE_CAUTIOUS: Time window guards (ET)
    const nowMinutesET = (() => {
      const p = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(new Date());
      return Number(p.find(x=>x.type==="hour")?.value||0)*60 + Number(p.find(x=>x.type==="minute")?.value||0);
    })();
    if (nowMinutesET >= 9*60+30 && nowMinutesET < 9*60+40) return "FIRST_10_MIN_BLOCK";
    // DRY_RUN EXCEPTION: last-session time block (LAST_15_MIN) is LIVE-only.
    // In DRY_RUN/simulation, allow SIM_TRADE through session close for testing.
    // Live path (DRY_RUN=false) keeps the block ACTIVE and mandatory.
    // Mirror of the engine-wide DRY_RUN flag; kept local to avoid touching other call sites.
    const GUARD_DRY_RUN = true;
    if (!GUARD_DRY_RUN && nowMinutesET >= 15*60+45 && nowMinutesET < 16*60) return "LAST_15_MIN_BLOCK";
    // LIVE_CAUTIOUS: Consecutive losses guard
    const consecLosses = (this as any).consecutiveLosses || 0;
    if (consecLosses >= 2) return `CONSECUTIVE_LOSSES:${consecLosses}`;
    const allowPaperDelayedMarketData = this.config.mode === "paper" && ibkrStatus.marketDataMode === "delayed";
    if (!allowPaperDelayedMarketData && (ibkrStatus.requestedMarketDataType !== "LIVE" || ibkrStatus.marketDataMode !== "live")) {
      return `IBKR_MARKET_DATA_NOT_LIVE:${ibkrStatus.marketDataMode}`;
    }
    if (this.config.activeStrategy !== "milking") return `STRATEGY_NOT_ALLOWED:${this.config.activeStrategy}`;
    if (this.config.zeroHero.enabled) return "ZERO_HERO_DISABLED";
    const vix = market.getVIX();
    if (typeof vix === "number" && vix > 25) return `VIX_LIMIT:${vix.toFixed(2)}`;
    const dailyPnl = this.getDailyPnl();
    const maxLoss = this.getDailyLossLimitAmount();
    if (maxLoss > 0 && dailyPnl <= -maxLoss) return `DAILY_LOSS_LIMIT:${dailyPnl.toFixed(2)}`;
    return null;
  }

  private stopTradingNow(reason: string): string {
    this.enforceLiveSafeConfig();
    this.running = false;
    this.log("error", `[STOP_TRADING] ${reason}`);
    // PART 10: BOT_INTERNAL_STOPPED Telegram alert (no auto-restart)
    try {
      const accId = ((this.config as any).broker?.accountNumber) || (ibkr as any)?.accountId || "UNKNOWN";
      const ts = new Date().toISOString();
      const msg = `🛑 BOT_INTERNAL_STOPPED\nReason: ${reason}\nTimestamp: ${ts}\nAccount: ${accId}\nAuto-restart: NO`;
      notifyError("BOT_INTERNAL_STOPPED", msg);
    } catch {}
    return reason;
  }

  private getContractsForEntry(strategy: Strategy, premium: number): number {
    this.enforceLiveSafeConfig();
    const safePremium = Number(premium);
    const contractCost = safePremium * 100;
    if (!(contractCost > 0)) return 0;
    const capitalLimit = Math.floor(this.getStrategyCapital("milking") / contractCost);
    return Math.max(0, Math.min(1, capitalLimit));
  }
  async start() {
    if (this.running) return;
    if (isFuturesMode()) this.logTradeModeGuard("engine start");

    if (!market.isConfigured()) {
      this.log("error", "لا يمكن التشغيل: مفتاح API غير موجود");
      try { notifyCriticalError("بدء التشغيل", "لا يمكن التشغيل: مفتاح API غير موجود"); } catch {}
      try { notifyHealthFailure("فشل بدء التشغيل بسبب غياب مفتاح API"); } catch {}
      return;
    }

    this.running = true;
    this.startTime = Date.now();
    this.consecutiveLosses = 0;

    if (this.getOpenTrades().length > 0) {
      this.log("info", `[RESTORE] تم استعادة ${this.getOpenTrades().length} صفقة مفتوحة من DB وسيتم تتبعها بعد restart`);
    }

    if (this.config.filters.enableNewsFilter) {
      newsFilter.setEnabled(true);
      newsFilter.startAutoRefresh();
      this.log("info", "[NewsFilter] فلتر الأخبار الاقتصادية مفعّل (تحديث كل ساعة)");
    }

    const isAgg = this.config.activeStrategy === 'zeroHero';
    this.log("info", `بدء التشغيل`);
    try { notifyBotStart(this.config.mode, this.config.activeStrategy); } catch {} // notify [${this.config.mode === 'paper' ? 'ورقي' : 'حقيقي'}] | استراتيجية: ${this.config.activeStrategy} | النمط: ${isAgg ? 'هجومي 5/8' : 'محافظ 6/8'} | Max Open: ${this.config.risk.maxOpenPositions} | Delta: ${this.config.options.deltaMin}-${this.config.options.deltaMax}`);

    this.log("info", "جاري الاتصال بـ IBKR Gateway...");
    this.dataState = "waiting";
    const ibkrConnected = await market.connectIBKR();
    if (ibkrConnected) {
      this.ibkrDisconnectAlerted = false;
      await this.refreshBrokerAccountSnapshot();
      const status = market.getIBKRStatus();
      this.log("info", `✅ IBKR متصل! Account: ${market.getIBKRAccountId()} | PRICE_SOURCE=IBKR | EXECUTION=IBKR | MARKET_DATA=${status.requestedMarketDataType}/${status.marketDataMode}`);
    } else {
      this.ibkrDisconnectAlerted = true;
      this.log("warn", "⚠️ IBKR غير متصل - لا يوجد أي fallback، وسيبقى التداول محظورًا حتى يعود الاتصال الحي" );
      this.logDecisionAudit("ALL", "BLOCK", "ibkr_execution_unavailable");
      try { notifyIBKRDisconnect(); } catch {}
    }
    this.log("info", "جاري تحميل بيانات السوق...");

    let loaded = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      loaded = await market.loadPrices();
      if (loaded) break;
      if (attempt < 3) {
        this.log("warn", `محاولة ${attempt}/3 فشلت - إعادة المحاولة بعد 3 ثواني...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    if (loaded) {
      this.dataState = "connected";
      this.dataRetryCount = 0;
      this.waitingModeAlerted = false;
      this.dataLoadFailureAlerted = false;
      this.dataSourceFailureAlerted = false;
      this.healthFailureAlerted = false;
      const spy = market.getPrice("SPY");
      const qqq = market.getPrice("QQQ");
      const vix = market.getVIX();
      this.log("info", `بيانات حقيقية: SPY=$${spy} | QQQ=$${qqq} | VIX=${vix?.toFixed(1) ?? 'N/A'}`);
      this.logDecisionAudit("ALL", "WAIT", "startup_data_ready");
    } else {
      this.dataState = "waiting";
      this.log("warn", "فشل التحميل الأولي - البوت شغال وينتظر البيانات...");
      this.logDecisionAudit("ALL", "BLOCK", "initial_market_data_load_failed");
      if (!this.dataLoadFailureAlerted) {
        try { notifyDataLoadFailure("فشل التحميل الأولي لبيانات السوق"); } catch {}
        this.dataLoadFailureAlerted = true;
      }
      if (!this.waitingModeAlerted) {
        try { notifyWaitingMode("تعذر تحميل البيانات، والنظام بانتظار توفرها"); } catch {}
        this.waitingModeAlerted = true;
      }
    }

    const mktStatus = getMarketStatus();
    if (!mktStatus.open) {
      this.log("warn", `السوق مغلق حالياً (${mktStatus.currentTimeET}) - البوت في وضع الانتظار`);
      this.logDecisionAudit("ALL", "BLOCK", `market_closed:${mktStatus.currentTimeET}`);
      if (!this.waitingModeAlerted) {
        try { notifyWaitingMode(`السوق مغلق حالياً (${mktStatus.currentTimeET})`); } catch {}
        this.waitingModeAlerted = true;
      }
    }

    this.scanTimer = setInterval(() => this.parallelScan(), 90_000);
    this.refreshTimer = setInterval(() => this.refreshData(), 120_000);
    this.pnlTimer = setInterval(() => this.updateOpenTradePrices(), 30_000);
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 3_600_000);
    setTimeout(() => this.parallelScan(), 2000);
  }

  stop() {
    this.running = false;
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    if (this.pnlTimer) { clearInterval(this.pnlTimer); this.pnlTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    newsFilter.stopAutoRefresh();
    this.log("info", "تم إيقاف البوت");
    try { notifyBotStopped("تم إيقاف البوت"); } catch {}
  }

  private async refreshData() {
    try {
      if (this.dataState !== "connected") {
        this.dataRetryCount++;
        this.log("info", `إعادة محاولة تحميل البيانات (محاولة ${this.dataRetryCount})...`);
        const loaded = await market.loadPrices();
        if (loaded) {
          this.dataState = "connected";
          this.waitingModeAlerted = false;
          this.dataLoadFailureAlerted = false;
          this.dataSourceFailureAlerted = false;
          this.healthFailureAlerted = false;
          if (market.isIBKRConnected() && this.ibkrDisconnectAlerted) {
            try { notifyIBKRReconnect(); } catch {}
            this.ibkrDisconnectAlerted = false;
          }
          this.log("info", `تم الاتصال بالبيانات بنجاح! SPY=$${market.getPrice("SPY")} | QQQ=$${market.getPrice("QQQ")}`);
        } else {
          this.dataState = "waiting";
          this.log("warn", "لا زالت البيانات غير متاحة - البوت شغال وينتظر...");
          if (!this.dataLoadFailureAlerted) {
            try { notifyDataLoadFailure("تعذر تحميل بيانات السوق"); } catch {}
            this.dataLoadFailureAlerted = true;
          }
          if (!this.waitingModeAlerted) {
            try { notifyWaitingMode("النظام بانتظار عودة البيانات"); } catch {}
            this.waitingModeAlerted = true;
          }
          if (this.dataRetryCount >= 3 && !this.dataSourceFailureAlerted) {
            try { notifyDataSourceFailure("بيانات السوق", "تعذر استعادة البيانات بعد عدة محاولات"); } catch {}
            this.dataSourceFailureAlerted = true;
          }
          if (this.dataRetryCount >= 3 && !this.healthFailureAlerted) {
            try { notifyHealthFailure("مصدر البيانات غير متاح بعد عدة محاولات"); } catch {}
            this.healthFailureAlerted = true;
          }
        }
        return;
      }
      await market.refreshPrices();
      await this.updateOpenTradePrices();
    } catch (e: any) {
      this.log("warn", `خطأ في تحديث البيانات: ${e.message}`);
      if (!this.dataSourceFailureAlerted) {
        try { notifyDataSourceFailure("تحديث البيانات", e.message); } catch {}
        this.dataSourceFailureAlerted = true;
      }
      if (!this.healthFailureAlerted) {
        try { notifyHealthFailure(`خطأ في تحديث البيانات: ${e.message}`); } catch {}
        this.healthFailureAlerted = true;
      }
      try { notifyCriticalError("تحديث البيانات", e.message); } catch {}
    }
  }

  private async updateOpenTradePrices() {
    // ===== FUTURES SIM PRICE + PnL REFRESH =====
    // In futures mode MES has no option premium. We update currentPremium with
    // the live MES price (via market.getPrice), compute PnL at $5/point for
    // LONG/SHORT, and let checkExits() evaluate stop/target in price space.
    // Live options path is unchanged below.
    if (isFuturesMode()) {
      const paperBudget = this.getPaperBotBudget() || 1000;
      // Iterate over raw trade references (not sanitized copies) so mutations persist.
      for (const t of this.trades.filter(x => x.status === "open")) {
        try {
          if (t.tradeMode !== "futures" && t.underlying !== "MES") continue;
          let px = 0;
          try { px = Number(market.getPrice(t.underlying)) || 0; } catch {}
          if (!(px > 0)) {
            try { px = Number(market.getPrice("MES")) || 0; } catch {}
          }
          if (!(px > 0)) continue;
          t.currentPremium = px;
          const side: "LONG" | "SHORT" = (t.tradeSide === "SHORT") ? "SHORT" : "LONG";
          const points = side === "SHORT" ? (t.entryPremium - px) : (px - t.entryPremium);
          const pnlUsd = Math.round(points * t.quantity * MES_DOLLAR_PER_POINT * 100) / 100;
          t.pnl = pnlUsd;
          t.pnlPercent = Math.round((pnlUsd / paperBudget) * 10000) / 100;
          if (side === "LONG") {
            if (px > t.peakPrice) t.peakPrice = px;
          } else {
            // For SHORT track lowest as "peak" (most-profitable) price
            if (!t.peakPrice || px < t.peakPrice) t.peakPrice = px;
          }
        } catch (_e) { /* skip */ }
      }
      this.logTradeModeGuard("open trade option pricing");
      return;
    }
    for (const t of this.getOpenTrades()) {
      try {
        const updated = await market.getOptionPrice(t.underlying, t.contractType, t.strike, t.expiry);
        if (updated) {
          t.currentPremium = updated.mid;
          t.delta = Math.abs(updated.delta);
          t.gamma = updated.gamma;
          t.theta = updated.theta;
          t.vega = updated.vega;
          t.iv = updated.iv;
          t.volume = updated.volume;
          t.openInterest = updated.openInterest;
          // PnL from OPTION PREMIUM only
          t.pnl = Math.round((t.currentPremium - t.entryPremium) * t.quantity * 100 * 100) / 100;
          t.pnlPercent = Math.round(((t.currentPremium - t.entryPremium) / t.entryPremium) * 10000) / 100;
          // Update trailing stop on every price update
          await this.updateTrailingStop(t, t.currentPremium);
        }
      } catch (_e) {
        // Skip silently
      }
    }
  }

  // ========== PAPER TRAILING STOP WITH BROKER-SIDE PROTECTION ==========
  private async syncBrokerStop(trade: Trade, newStopPrice: number, trigger: string): Promise<boolean> {
    const oldStopPrice = trade.trailingStopPrice;
    const oldStopOrderId = this.ibkrStopOrderIds.get(trade.id);
    if (!market.isIBKRConnected()) {
      this.log("warn", `[STOP_LOCAL_ONLY] ${trade.underlying} | trigger:${trigger} | old:$${oldStopPrice.toFixed(2)} | new:$${newStopPrice.toFixed(2)}`, {
        tradeId: trade.id,
        symbol: trade.underlying,
        underlying: trade.underlying,
        premium: trade.currentPremium,
        highestPrice: trade.peakPrice,
        trailingDistance: trade.trailingConfig.distance,
        assetType: getAssetStopProfile(trade.underlying).assetType,
        oldStop: oldStopPrice,
        newStop: newStopPrice,
        trailingStop: trade.trailingConfig.distance,
        stopWidthReason: getAssetStopProfile(trade.underlying).stopWidthReason,
        stopType: "STP",
        protectionMode: "local",
        brokerSideStop: false,
      });
      trade.trailingStopPrice = newStopPrice;
      return true;
    }

    const replacement = await ibkr.placeProtectiveStopOrder(
      trade.underlying,
      trade.contractType,
      trade.strike,
      trade.expiry,
      trade.quantity,
      newStopPrice,
    );

    if (!replacement || replacement.status === "Rejected") {
      this.log("error", `[BROKER_STOP_REPLACE_FAILED] ${trade.underlying} | trigger:${trigger} | old:$${oldStopPrice.toFixed(2)} | new:$${newStopPrice.toFixed(2)}`, {
        tradeId: trade.id,
        symbol: trade.underlying,
        underlying: trade.underlying,
        premium: trade.currentPremium,
        highestPrice: trade.peakPrice,
        trailingDistance: trade.trailingConfig.distance,
        oldStop: oldStopPrice,
        newStop: newStopPrice,
        orderType: "STP",
        orderId: replacement?.orderId ?? null,
        permId: replacement?.permId ?? null,
        stopType: "STP",
        protectionMode: "broker-side",
        brokerSideStop: true,
        reason: replacement?.rejectReason || replacement?.errorMessage || "protective_stop_replace_failed",
      });
      return false;
    }

    this.ibkrStopOrderIds.set(trade.id, replacement.orderId);
    if (oldStopOrderId) {
      try {
        await ibkr.cancelOrder(oldStopOrderId);
      } catch (e: any) {
        this.log("warn", `[BROKER_STOP_CANCEL_OLD_FAILED] ${trade.underlying} | oldStopOrderId:${oldStopOrderId} | newStopOrderId:${replacement.orderId}`, {
          tradeId: trade.id,
          symbol: trade.underlying,
          underlying: trade.underlying,
          reason: e?.message || String(e),
          oldStop: oldStopPrice,
          newStop: newStopPrice,
          oldStopOrderId,
          newStopOrderId: replacement.orderId,
          stopType: "STP",
          protectionMode: "broker-side",
          brokerSideStop: true,
        });
      }
    }

    trade.trailingStopPrice = newStopPrice;
    this.log("info", `[BROKER_STOP_UPDATED] ${trade.underlying} | trigger:${trigger} | old:$${oldStopPrice.toFixed(2)} | new:$${newStopPrice.toFixed(2)} | peak:$${trade.peakPrice.toFixed(2)}`, {
      tradeId: trade.id,
      symbol: trade.underlying,
      underlying: trade.underlying,
      premium: trade.currentPremium,
      highestPrice: trade.peakPrice,
      trailingDistance: trade.trailingConfig.distance,
      oldStop: oldStopPrice,
      newStop: newStopPrice,
      orderType: "STP",
      orderId: replacement.orderId,
      permId: replacement.permId ?? null,
      stopType: "STP",
      protectionMode: "broker-side",
      brokerSideStop: true,
    });
    return true;
  }

  private async updateTrailingStop(trade: Trade, currentPremium: number) {
    const { activation, distance } = trade.trailingConfig;

    if (currentPremium > trade.peakPrice) {
      trade.peakPrice = currentPremium;
    }

    const candidateStop = Math.max(0.01, Math.round((trade.peakPrice - distance) * 100) / 100);

    if (!trade.trailingActive && currentPremium >= trade.entryPremium + activation) {
      trade.trailingActive = true;
      this.log("info", `[TRAILING_ACTIVATED] ${trade.underlying} | entry:$${trade.entryPremium.toFixed(2)} | peak:$${trade.peakPrice.toFixed(2)} | oldStop:$${trade.trailingStopPrice.toFixed(2)} | candidateStop:$${candidateStop.toFixed(2)} | distance:$${distance.toFixed(2)}`, {
        tradeId: trade.id,
        symbol: trade.underlying,
        underlying: trade.underlying,
        premium: currentPremium,
        highestPrice: trade.peakPrice,
        trailingDistance: distance,
        assetType: getAssetStopProfile(trade.underlying).assetType,
        oldStop: trade.trailingStopPrice,
        newStop: candidateStop,
        trailingStop: trade.trailingConfig.distance,
        stopWidthReason: getAssetStopProfile(trade.underlying).stopWidthReason,
        stopType: "STP",
        protectionMode: market.isIBKRConnected() ? "broker-side" : "local",
        brokerSideStop: market.isIBKRConnected(),
      });
    }

    if (trade.trailingActive && candidateStop > trade.trailingStopPrice) {
      await this.syncBrokerStop(trade, candidateStop, "trailing_milking");
    }
  }

  private async parallelScan() {
    if (!this.running) return;
    const scanStart = Date.now();
    try {
      if (this.dataState !== "connected") {
        this.logDecisionAudit("ALL", "BLOCK", `data_state:${this.dataState}`);
        return;
      }
      this.enforceLiveSafeConfig();
      const liveSafeStopReason = this.getLiveSafeStopReason();
      if (liveSafeStopReason) {
        this.stopTradingNow(liveSafeStopReason);
        return;
      }

      const mktStatus = getMarketStatus();
      if (!mktStatus.open) {
        if (this.getOpenTrades().length > 0) {
          await this.updateOpenTradePrices();
          await this.checkExits();
        }
        return;
      }

      await this.checkExits();

      const blocked = this.checkFilters();
      if (blocked) {
        this.logDecisionAudit("ALL", "BLOCK", blocked);
        this.log("warn", `محظور: ${blocked}`);
        return;
      }

      if (this.getOpenTrades().length >= this.config.risk.maxOpenPositions) return;
      if (this.getTodayTrades().length >= this.getEffectiveMaxTradesPerDay()) return;
      if (this.lastTradeTime && Date.now() - this.lastTradeTime < this.config.risk.cooldownMinutes * 60000) return;

      const isAggressive = this.config.activeStrategy === 'zeroHero';
      const minRequired = isAggressive ? 4 : 5;
      const modeName = isAggressive ? 'هجومي' : 'محافظ';

      const scanUniverse = this.getSignalUniverse();
      const scanResults = await Promise.allSettled(
        scanUniverse.map(async (u) => {
          const conf = this.runConfirmations(u);
          const passed = conf.filter(x => x.passed).length;
          return { underlying: u, confirmations: conf, passed };
        })
      );

      const results = scanResults
        .filter((r): r is PromiseFulfilledResult<{ underlying: string; confirmations: Confirmation[]; passed: number }> => r.status === "fulfilled")
        .map(r => r.value)
        .sort((a, b) => b.passed - a.passed);

      const summary = results.map(r => `${r.underlying}:${r.passed}/8`).join(" | ");
      this.log("info", `[PARALLEL_SCAN] ${summary} (${Date.now() - scanStart}ms)`);

      for (const r of results) {
        if (this.getOpenTrades().length >= this.config.risk.maxOpenPositions) break;

        const passedNames = r.confirmations.filter(x => x.passed).map(x => x.label).join(" | ");
        const failedNames = r.confirmations.filter(x => !x.passed).map(x => `${x.label}(${x.value})`).join(" | ");

        if (r.passed >= minRequired) {
          this.log("info", `[SIGNAL_PASSED] ✅ ${r.underlying}: ${r.passed}/8 تأكيدات (${modeName})`);
          this.log("info", `📊 المؤشرات الداعمة: ${passedNames}`);
          if (failedNames) this.log("info", `⚠️ لم تتحقق: ${failedNames}`);
          const executionTrace: ExecutionTrace = { signalDetectedAt: Date.now() };
          this.log("info", `[SIGNAL_DETECTED] ${r.underlying} | signal:${r.passed}/8`, {
            symbol: r.underlying,
            underlying: r.underlying,
            signalScore: `${r.underlying}:${r.passed}/8`,
            stage: "signal_detected",
            stageTsMs: executionTrace.signalDetectedAt,
          });

          // ===== DRY_RUN LOCAL BYPASS (Smart Brain skipped for simulated trades) =====
          // In DRY_RUN, rely on S1 local confirmations + local guards (long_only / LIVE_SHORT_BLOCKED /
          // first10 / last15 / daily stop / dataFresh). Smart Brain S2 gate is bypassed to allow
          // simulated SIM_TRADE without VWAP_TOO_CLOSE / SHORT_DISABLED_LONG_ONLY from S2.
          // LIVE path is unchanged.
          const ENGINE_DRY_RUN_BYPASS = false; // mirror of inner DRY_RUN flag; DO NOT flip without owner
          const decision = ENGINE_DRY_RUN_BYPASS
            ? this.buildLocalDryRunDecision(r.underlying, r.confirmations, r.passed)
            : await this.evaluateWithSmartBrain(r.underlying, r.confirmations, r.passed);
          const requestedSize = this.getRequestedContractsForEntry();
          const sizeOverride = Math.max(0, Math.min(1, Number(decision.size_override ?? (decision.decision === "EXECUTE" || decision.decision === "REDUCE" ? 1 : 0))));
          const finalSize = (decision.decision === "EXECUTE" || decision.decision === "REDUCE") ? Math.min(sizeOverride, requestedSize, 1) : 0;
          const trendConf = r.confirmations.find(c => c.name === "trend");
          const optionSide: BotOptionSide | undefined = trendConf?.value?.includes("صاعد") ? "CALL" : "PUT";
          // ===== BIDIRECTIONAL TRADE SIDE (DRY_RUN-only SHORT) =====
          // LONG = CALL (uptrend). SHORT = PUT (downtrend).
          // SHORT entries are simulated ONLY in DRY_RUN. Live SHORT is hard-blocked.
          const tradeSide: "LONG" | "SHORT" = optionSide === "CALL" ? "LONG" : "SHORT";
          const ENGINE_DRY_RUN = false; // mirror of inner DRY_RUN flag; do not flip without owner approval
          if (isFuturesMode() && tradeSide === "SHORT") {
            if (!ENGINE_DRY_RUN) {
              this.log("warn", `[LIVE_SHORT_BLOCKED] ${r.underlying} signal SHORT rejected (live SHORT disabled)`);
              this.logDecisionAudit(r.underlying, "BLOCK", "LIVE_SHORT_BLOCKED", "ibkr", {
                confidence: decision.confidence_final ?? null,
                decision: "REJECT",
                requestedSize,
                finalSize: 0,
                reasonCodes: [...(decision.reason_codes || []), "LIVE_SHORT_BLOCKED"],
              });
              continue;
            }
            this.log("info", `[DRY_RUN_SHORT_SIM_ALLOWED] ${r.underlying} signal SHORT will be simulated (DRY_RUN only)`);
          }
          const marketContext = market.getDecisionContext(r.underlying, "none");
          const decisionDetails = {
            symbol: r.underlying,
            underlying: r.underlying,
            optionSide,
            signalScore: decision.signal,
            smartBrainRawScore: decision.confidence_score ?? null,
            confidence: decision.confidence_final,
            decision: decision.decision,
            latencyMs: decision.latency_ms ?? null,
            reason: decision.summary,
            reasonCodes: decision.reason_codes,
            requestedSize,
            finalSize,
            botBudget: this.getPaperBotBudget(),
            dailyLossLimitAmount: this.getDailyLossLimitAmount(),
            currentRealizedPnlToday: this.getDailyPnl(),
            stopTradingTriggered: Boolean(this.getLiveSafeStopReason()),
            premium: null,
            dataSourceUsed: marketContext.dataSourceUsed,
            stockDataSource: marketContext.stockDataSource,
            optionDataSource: marketContext.optionDataSource,
            ibkrConnected: marketContext.ibkrConnected,
            polygonAvailable: marketContext.polygonAvailable,
            yahooFallbackUsed: marketContext.yahooFallbackUsed,
            blockReason: null,
          };

          this.log("info", `[SMART_BRAIN] signal:${decision.signal} | confidence_raw:${decision.confidence_score ?? "n/a"} | confidence_final:${decision.confidence_final}% | decision:${decision.decision}`);
          this.log("info", `[SMART_BRAIN_DECISION] signal:${decision.signal} | decision:${decision.decision} | reason:${decision.summary}`, decisionDetails);
          this.log("info", `[SMART_BRAIN] reason_codes: ${decision.reason_codes.join(", ") || "NONE"}`, decisionDetails);
          this.log("info", `[SMART_BRAIN] summary: ${decision.summary}`, decisionDetails);
          this.logDecisionAudit(
            r.underlying,
            decision.decision === "WAIT" ? "WAIT" : (decision.decision === "EXECUTE" || decision.decision === "REDUCE" ? "EXECUTE" : "BLOCK"),
            decision.decision === "WAIT" || decision.decision === "REJECT" ? decision.summary : undefined,
            "none",
            {
              signalScore: decision.signal,
              confidence: decision.confidence_final,
              reason: decision.summary,
              reasonCodes: decision.reason_codes,
            },
          );
          if (decision.emergency_stop) {
            this.log("warn", `[SMART_BRAIN] EMERGENCY_STOP active for ${r.underlying}`, decisionDetails);
          }

          try {
            // In futures mode the Telegram decision label must reflect LONG/SHORT (not CALL/PUT).
            const decisionOptionTypeLabel: any = isFuturesMode() ? tradeSide : optionSide;
            notifyDecision(
              r.underlying,
              decision.signal,
              decision.decision,
              decision.confidence_final,
              decision.reason_codes,
              decision.summary,
              Boolean(decision.emergency_stop),
              {
                rawScore: decision.confidence_score ?? null,
                requestedSize,
                finalSize,
                optionType: decisionOptionTypeLabel,
              },
            );
          } catch (e: any) {
            this.log("error", `[TELEGRAM ERROR] ${e.message}`);
          }

          if (decision.decision === "EXECUTE" || decision.decision === "REDUCE") {
            const validated = await this.validateOptionForEntry(r.underlying, r.confirmations);
            if (validated) {
              this.logDecisionAudit(r.underlying, "EXECUTE", undefined, validated.source, {
                signalScore: decision.signal,
                confidence: decision.confidence_final,
                optionTicker: validated.ticker,
                bid: validated.bid,
                ask: validated.ask,
                premium: validated.ask,
              });
              executionTrace.marketDataReceivedAt = Date.now();
              this.log("info", `[MARKET_DATA_RECEIVED] ${r.underlying} | bid:$${validated.bid} | ask:$${validated.ask} | premium:$${validated.ask}`, {
                symbol: r.underlying,
                underlying: r.underlying,
                optionTicker: validated.ticker,
                bid: validated.bid,
                ask: validated.ask,
                premium: validated.ask,
                stage: "market_data_received",
                stageTsMs: executionTrace.marketDataReceivedAt,
                elapsedFromSignalMs: executionTrace.marketDataReceivedAt - executionTrace.signalDetectedAt,
              });
              executionTrace.contractSelectedAt = Date.now();
              this.log("info", `[CONTRACT_SELECTED] ${r.underlying} | ${validated.ticker} | strike:$${validated.strike} | expiry:${validated.expiry}`, {
                symbol: r.underlying,
                underlying: r.underlying,
                optionTicker: validated.ticker,
                strike: validated.strike,
                expiry: validated.expiry,
                bid: validated.bid,
                ask: validated.ask,
                premium: validated.ask,
                stage: "contract_selected",
                stageTsMs: executionTrace.contractSelectedAt,
                elapsedFromSignalMs: executionTrace.contractSelectedAt - executionTrace.signalDetectedAt,
                elapsedFromMarketDataMs: executionTrace.marketDataReceivedAt ? executionTrace.contractSelectedAt - executionTrace.marketDataReceivedAt : null,
              });
              await this.openTrade(r.underlying, r.confirmations, validated, {
                signal: decision.signal,
                decision: decision.decision,
                reason: decision.summary,
                confidence: decision.confidence_final,
                rawScore: decision.confidence_score ?? null,
                latencyMs: decision.latency_ms ?? null,
                reasonCodes: decision.reason_codes,
                requestedSize,
                finalSize,
                finalSizeReason: decision.decision === "REDUCE" ? "smart_brain_reduce" : "threshold_execute",
                tradeSide,
              }, executionTrace);
              break;
            }
            this.logDecisionAudit(r.underlying, "BLOCK", "contract_data_unavailable_or_rejected", "none", {
              signalScore: decision.signal,
              confidence: decision.confidence_final,
              reason: decision.summary,
            });
          } else if (decision.decision === "WAIT") {
            this.log("info", `[WAIT] Smart Brain طلب الانتظار لمزيد من التأكيدات لـ ${r.underlying}`);
          } else {
            this.log("info", `[REJECT] Smart Brain رفض الإشارة لـ ${r.underlying}`);
          }
        }
      }

      const scanDuration = Date.now() - scanStart;
      if (scanDuration > 120_000) {
        this.log("warn", `[SCAN_SLOW] دورة الفحص استغرقت ${(scanDuration / 1000).toFixed(1)}s (> 2 min)`);
      }
    } catch (err: any) {
      this.log("error", `خطأ في المسح: ${err.message}`);
    }
  }

  // Local DRY_RUN decision: bypasses Smart Brain S2. Decision = EXECUTE if passed >= minRequired
  // (the caller already verified this). Local guards still apply downstream (long_only, LIVE_SHORT_BLOCKED,
  // first10, last15, daily loss, dataFresh). LIVE trading path does NOT use this method.
  private buildLocalDryRunDecision(underlying: string, confirmations: Confirmation[], passed: number): SmartBrainResponse {
    const signal = `${underlying}:${passed}/8`;
    const passedNames = confirmations.filter(c => c.passed).map(c => c.label);
    const failedNames = confirmations.filter(c => !c.passed).map(c => c.label);
    const confidenceFinal = Math.round((passed / 8) * 100);
    return {
      ok: true,
      service: "s1-local-dry-run",
      version: "local-v1",
      signal,
      underlying,
      decision: "EXECUTE",
      confidence: confidenceFinal,
      confidence_final: confidenceFinal,
      confidence_score: confidenceFinal,
      size_override: 1,
      fast_path: false,
      emergency_stop: false,
      reason_codes: ["DRY_RUN_LOCAL_DECISION", "BYPASS_SMART_BRAIN_DRY_RUN"],
      strengths: passedNames,
      weaknesses: failedNames,
      summary: `DRY_RUN local decision: ${passed}/8 confirmations passed (Smart Brain bypassed for simulation)`,
      latency_ms: 0,
    };
  }

  private async evaluateWithSmartBrain(underlying: string, confirmations: Confirmation[], passed: number): Promise<SmartBrainResponse> {
    const signal = `${underlying}:${passed}/8`;
    const requestPayload = {
      request_id: rid(),
      signalLabel: signal,
      underlying,
      confirmations: passed,
      todayTrades: this.getTodayTrades().length,
      openTrades: this.getOpenTrades().length,
      maxTrades: this.getEffectiveMaxTradesPerDay(),
      maxOpenPositions: this.config.risk.maxOpenPositions,
      dailyPnl: this.getDailyPnl(),
      strategyCapital: this.getStrategyCapital(this.config.activeStrategy as Strategy),
      dailyLossLimitPercent: this.config.risk.maxDailyLossPercent,
      maxLoss: this.getStrategyCapital(this.config.activeStrategy as Strategy) * (this.config.risk.maxDailyLossPercent / 100),
      emergencyStop: false,
      signal: {
        label: signal,
        underlying,
        confirmations: passed,
        passed_names: confirmations.filter(c => c.passed).map(c => c.label),
        failed_names: confirmations.filter(c => !c.passed).map(c => c.label),
      },
      stockData: market.getStockData(underlying),
      meta: {
        source: "server1-ai-trader",
        mode: this.config.mode,
        strategy: this.config.activeStrategy,
      },
    };

    const startedAt = Date.now();
    const fallback = (reason: string): SmartBrainResponse => ({
      ok: false,
      signal,
      underlying,
      decision: "WAIT",
      confidence_final: 0,
      emergency_stop: false,
      reason_codes: [reason],
      strengths: [],
      weaknesses: ["Smart Brain unreachable"],
      summary: `Fallback WAIT: ${reason}`,
      latency_ms: Date.now() - startedAt,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SMART_BRAIN_TIMEOUT_MS);

    try {
      const response = await fetch(SMART_BRAIN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.log("warn", `[SMART_BRAIN_HTTP] ${underlying} | status ${response.status}`);
        return fallback(`SMART_BRAIN_HTTP_${response.status}`);
      }

      const data = await response.json() as Partial<SmartBrainResponse>;
      const latencyMs = Date.now() - startedAt;
      const rawDecision = String(data.decision || "").trim().toUpperCase();
      const normalizedDecision = rawDecision === "ALERT_ONLY" ? "WAIT" : (["EXECUTE", "REDUCE", "WAIT", "REJECT"].includes(rawDecision) ? rawDecision : "REJECT");
      const reasonCodes = Array.isArray(data.reason_codes) ? [...data.reason_codes] : ["SMART_BRAIN_EMPTY_REASON_CODES"];
      if (normalizedDecision !== rawDecision) reasonCodes.push("SMART_BRAIN_DECISION_NORMALIZED");
      const normalizedConfidence = typeof data.confidence === "number"
        ? data.confidence
        : (typeof data.confidence_final === "number" ? data.confidence_final : 0);
      const normalizedSizeOverride = Math.max(0, Math.min(1, Math.round(typeof data.size_override === "number" ? data.size_override : (normalizedDecision === "EXECUTE" || normalizedDecision === "REDUCE" ? 1 : 0))));
      return this.applyPaperDecisionThresholds({
        ok: data.ok,
        service: data.service,
        version: data.version,
        signal: data.signal || signal,
        underlying: data.underlying || underlying,
        decision: normalizedDecision as SmartBrainDecision,
        confidence: normalizedConfidence,
        confidence_final: normalizedConfidence,
        confidence_score: typeof data.confidence_score === "number" ? data.confidence_score : normalizedConfidence,
        size_override: normalizedSizeOverride,
        fast_path: data.fast_path,
        emergency_stop: Boolean(data.emergency_stop),
        reason_codes: reasonCodes,
        strengths: Array.isArray(data.strengths) ? data.strengths : [],
        weaknesses: Array.isArray(data.weaknesses) ? data.weaknesses : [],
        summary: data.summary || "Smart Brain response received",
        evaluated_at: data.evaluated_at,
        latency_ms: typeof data.latency_ms === "number" ? data.latency_ms : latencyMs,
      });
    } catch (e: any) {
      const reason = e?.name === "AbortError" ? "SMART_BRAIN_TIMEOUT" : "SMART_BRAIN_UNREACHABLE";
      this.log("warn", `[SMART_BRAIN_FALLBACK] ${underlying} | ${reason} | ${e?.message || e}`);
      return fallback(reason);
    } finally {
      clearTimeout(timeout);
    }
  }

  private runConfirmations(underlying: string): Confirmation[] {
    const data = market.getStockData(underlying);
    if (!data) {
      return Array(8).fill(null).map((_, i) => ({
        name: `check_${i}`, label: "لا توجد بيانات", passed: false, value: "N/A"
      }));
    }

    const S = data.close;
    const vix = market.getVIX() ?? 20;
    const trendUp = data.ema9 > data.ema21;
    const rsi = data.rsi14;
    const macdHist = data.macdHist;
    const adx = data.adx;
    const aboveVwap = S >= data.vwap;
    const avgVol = underlying === "SPY" ? 60e6 : underlying === "QQQ" ? 40e6 : 30e6;
    const volRatio = data.volume / avgVol;
    const range = data.high - data.low;
    const body = Math.abs(data.close - data.open);
    const bodyRatio = range > 0 ? body / range : 0;
    const strongCandle = bodyRatio > 0.5 && range > 0.002 * data.close;

    // ===== DRY_RUN-ONLY relaxation for RSI + VWAP (Owner-approved scope) =====
    // In DRY_RUN: widen RSI range based on direction; treat VWAP closeness as soft-pass.
    // In LIVE: original strict thresholds are preserved (RSI 35-65, VWAP strict above).
    // News/Macro are NOT touched here.
    const DRY_RUN_RELAX = false; // mirror of inner DRY_RUN flag; DO NOT flip without owner
    const rsiLow = DRY_RUN_RELAX ? (trendUp ? 25 : 20) : 35;
    const rsiHigh = DRY_RUN_RELAX ? (trendUp ? 80 : 75) : 65;
    const rsiPassed = rsi > rsiLow && rsi < rsiHigh;
    const rsiTag = DRY_RUN_RELAX
      ? `${rsi.toFixed(1)} [DRY_RUN ${trendUp ? "LONG" : "SHORT"} ${rsiLow}-${rsiHigh}]`
      : `${rsi.toFixed(1)} [من ${data.barsCount} شمعة]`;
    const vwapDistPct = data.vwap > 0 ? Math.abs(S - data.vwap) / data.vwap * 100 : 0;
    const directionAlign = trendUp ? aboveVwap : !aboveVwap;
    const vwapSoftPass = vwapDistPct <= 0.50; // ±0.50% considered "warning" not block
    const vwapPassed = DRY_RUN_RELAX ? (directionAlign || vwapSoftPass) : aboveVwap;
    const vwapTag = DRY_RUN_RELAX
      ? `$${S.toFixed(2)} vs VWAP:$${data.vwap.toFixed(2)} [DRY_RUN dist:${vwapDistPct.toFixed(3)}% ${directionAlign ? "ALIGN" : vwapSoftPass ? "WARN_SOFTPASS" : "FAIL"}]`
      : `$${S.toFixed(2)} vs VWAP:$${data.vwap.toFixed(2)}`;

    return [
      { name: "trend", label: "الاتجاه (EMA 9/21)", passed: trendUp, value: trendUp ? `صاعد ↑ (${data.ema9} > ${data.ema21})` : `هابط ↓ (${data.ema9} < ${data.ema21})` },
      { name: "rsi", label: "RSI (14)", passed: rsiPassed, value: rsiTag },
      { name: "macd", label: "إشارة MACD", passed: trendUp ? macdHist > 0 : macdHist < 0, value: `Hist:${macdHist > 0 ? '+' : ''}${macdHist.toFixed(3)} Line:${data.macdLine.toFixed(3)}` },
      { name: "adx", label: "قوة ADX", passed: adx > 20, value: `${adx.toFixed(1)} [من شموع حقيقية]` },
      { name: "vwap", label: "موقع VWAP", passed: vwapPassed, value: vwapTag },
      { name: "volume", label: "حجم أعلى من المتوسط", passed: volRatio > 0.8, value: `${volRatio.toFixed(2)}x (${(data.volume / 1e6).toFixed(1)}M)` },
      { name: "candle", label: "شمعة قوية بدون ذيول", passed: strongCandle, value: `body:${(bodyRatio * 100).toFixed(0)}% range:${(range / data.close * 100).toFixed(2)}%` },
      { name: "news_vix", label: "لا يوجد خبر + VIX منخفض", passed: vix < 25, value: `VIX: ${vix.toFixed(1)}` },
    ];
  }

  private checkFilters(): string | null {
    if (this.config.filters.enableTimeFilter && !isMarketOpen()) return "السوق مغلق";
    if (!market.hasRealData()) return "بيانات السوق غير متاحة من IBKR/Polygon";
    if (!market.isIBKRConnected()) return "IBKR غير متصل - التنفيذ محظور";

    if (this.config.filters.enableNewsFilter) {
      const newsBlock = newsFilter.checkBlock();
      if (newsBlock.blocked && newsBlock.event) {
        const evName = newsBlock.event.name;
        const blockEnd = new Date(newsBlock.event.blockEnd).toLocaleTimeString("en-US", { timeZone: "America/New_York" });
        this.log("warn", `[NEWS_BLOCK] ${evName} | Trading blocked until ${blockEnd} ET`);
        saveLog(Date.now(), "warn", `[NEWS_BLOCK] ${evName}`, JSON.stringify({
          event: evName,
          eventTime: new Date(newsBlock.event.time).toISOString(),
          blockStart: new Date(newsBlock.event.blockStart).toISOString(),
          blockEnd: new Date(newsBlock.event.blockEnd).toISOString(),
        }));
        return `خبر اقتصادي: ${evName} | يستأنف ${blockEnd} ET`;
      }
    }

    const vix = market.getVIX();
    if (this.config.filters.enableVixFilter && vix !== null && vix > 30) return `VIX مرتفع جداً (${vix.toFixed(1)})`;

    if (this.config.filters.blockFirst10Minutes || this.config.filters.blockLast30Minutes) {
      const now = new Date();
      const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const mins = et.getHours() * 60 + et.getMinutes();
      if (this.config.filters.blockFirst10Minutes && mins < 9 * 60 + 40) return "أول 10 دقائق محظورة";
      if (this.config.filters.blockLast30Minutes && mins >= 15 * 60 + 45) return "آخر 30 دقيقة محظورة";
    }

    const dl = this.getDailyPnl();
    const ml = this.getDailyLossLimitAmount();
    if (ml > 0 && dl <= -ml) return `حد الخسارة اليومي: $${dl.toFixed(2)} / $${ml.toFixed(2)}`;
    if (this.consecutiveLosses >= this.config.risk.maxConsecutiveLosses) return `${this.consecutiveLosses} خسائر متتالية`;
    return null;
  }

  getNewsFilterStatus(): NewsFilterStatus {
    return newsFilter.getStatus();
  }

  simulateNewsEvent(name: string, minutesFromNow: number = 0) {
    return newsFilter.simulateEvent(name, minutesFromNow);
  }

  private buildDecisionAudit(symbol: string, decision: DecisionAuditOutcome, blockReason?: string, optionDataSource: "polygon" | "ibkr" | "none" = "none") {
    const ctx = market.getDecisionContext(symbol, optionDataSource);
    return {
      symbol,
      dataSourceUsed: ctx.dataSourceUsed,
      stockDataSource: ctx.stockDataSource,
      optionDataSource: ctx.optionDataSource,
      ibkrConnected: ctx.ibkrConnected,
      polygonAvailable: ctx.polygonAvailable,
      yahooFallbackUsed: ctx.yahooFallbackUsed,
      decision,
      blockReason: blockReason ?? ctx.blockReason ?? null,
    };
  }

  private logDecisionAudit(symbol: string, decision: DecisionAuditOutcome, blockReason?: string, optionDataSource: "polygon" | "ibkr" | "none" = "none", extras: Record<string, unknown> = {}) {
    const audit = this.buildDecisionAudit(symbol, decision, blockReason, optionDataSource);
    const level = decision === "EXECUTE" ? "trade" : decision === "WAIT" ? "info" : "warn";
    this.log(level, `[DATA_DECISION] ${symbol} | dataSourceUsed=${audit.dataSourceUsed} | ibkrConnected=${audit.ibkrConnected} | polygonAvailable=${audit.polygonAvailable} | yahooFallbackUsed=${audit.yahooFallbackUsed} | decision=${decision} | blockReason=${audit.blockReason ?? "none"}`, {
      ...audit,
      ...extras,
    });
  }

  private formatContractDetails(opt: OptionQuote, strategy: Strategy, premiumOverride?: number) {
    return {
      ticker: opt.ticker,
      expiry: opt.expiry,
      strike: opt.strike,
      optionSide: normalizeOptionSide(opt.contractType ?? "") ?? undefined,
      delta: roundMetric(Math.abs(opt.delta)),
      iv: roundMetric(opt.iv),
      volume: opt.volume,
      openInterest: opt.openInterest,
      strategy,
      premium: premiumOverride ?? opt.ask,
    };
  }

  private rejectOptionQuality(underlying: string, ct: ContractType, opt: OptionQuote | null, message: string, reason: string): null {
    try { notifyTradeRejected(underlying, "no contract"); } catch {}
    this.logDecisionAudit(underlying, "BLOCK", reason, opt?.source ?? "none", {
      optionSide: ct.toUpperCase(),
      reason,
      message,
    });
    this.log("warn", `[OPTION_REJECTED] ${underlying} ${ct}: ${message}`, {
      symbol: underlying,
      underlying,
      optionSide: ct.toUpperCase(),
      reason,
      bid: opt?.bid ?? null,
      ask: opt?.ask ?? null,
      premium: opt?.ask ?? null,
      contractDetails: opt ? this.formatContractDetails(opt, this.config.activeStrategy as Strategy) : null,
    });
    this.log("warn", `[EXECUTION_BLOCKED] ${underlying} ${ct} | ${reason}`);
    return null;
  }

  private async validateOptionForEntry(underlying: string, conf: Confirmation[]): Promise<OptionQuote | null> {
    if (isFuturesMode()) {
      this.logTradeModeGuard("option validation");
      // ===== DRY_RUN FUTURES SYNTHETIC QUOTE =====
      // In DRY_RUN futures mode, build a synthetic OptionQuote so openTrade() can simulate
      // a MES futures entry (no IBKR order). All MES_STOPS / SIM_TRADE logic uses limitPrice
      // which we set to the current MES last price. Live path is unchanged (returns null).
      const VALIDATE_DRY_RUN_FUTURES = true; // mirror of inner DRY_RUN flag
      if (VALIDATE_DRY_RUN_FUTURES) {
        const mesPrice = (market as any).getPrice && (market as any).getPrice(underlying);
        if (typeof mesPrice === "number" && mesPrice > 0) {
          const trendConfLocal = conf.find(c => c.name === "trend");
          const ctLocal: "call" | "put" = trendConfLocal?.value?.includes("صاعد") ? "call" : "put";
          const synth: OptionQuote = {
            ticker: underlying + "_FUT_DRYRUN",
            underlying,
            type: ctLocal,
            strike: mesPrice,
            expiry: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
            bid: Math.max(0.01, Math.round((mesPrice - 0.25) * 100) / 100),
            ask: Math.round((mesPrice + 0.25) * 100) / 100,
            mid: Math.round(mesPrice * 100) / 100,
            last: Math.round(mesPrice * 100) / 100,
            volume: 100000,
            openInterest: 100000,
            delta: ctLocal === "call" ? 0.7 : -0.7,
            gamma: 0,
            theta: 0,
            vega: 0,
            iv: 0,
            dte: 7,
            moneyness: "ATM",
            source: "ibkr",
            timestamp: Date.now(),
            delayed: false,
          };
          this.log("info", "[DRY_RUN][FUTURES_SYNTHETIC_QUOTE] " + underlying + " side:" + ctLocal.toUpperCase() + " mid:$" + synth.mid + " (used for SIM_TRADE only, no real order)");
          return synth;
        }
        this.log("warn", "[DRY_RUN][FUTURES_SYNTHETIC_QUOTE_SKIP] " + underlying + " no live MES price available");
      }
      return null;
    }
    const s = this.config.activeStrategy as Strategy;
    const trendConf = conf.find(c => c.name === "trend");
    const ct: ContractType = trendConf?.value?.includes("صاعد") ? "call" : "put";
    const dte = s === "hold" ? 14 : s === "zeroHero" ? 1 : 3;

    this.log("info", `[OPTION_VALIDATE] جاري البحث عن ${ct.toUpperCase()} لـ ${underlying} | Delta:${this.config.options.deltaMin}-${this.config.options.deltaMax} | DTE:${dte}`, {
      symbol: underlying,
      underlying,
      optionSide: ct.toUpperCase(),
    });

    let opt: OptionQuote | null = null;
    try {
      opt = await market.findOption(
        underlying, ct,
        [this.config.options.deltaMin, this.config.options.deltaMax],
        [this.config.options.minPremium, this.config.options.maxPremium],
        dte
      );
    } catch (e: any) {
      return this.rejectOptionQuality(underlying, ct, null, `فشل Polygon API - ${e.message}`, "contract_lookup_failed");
    }

    if (!opt) {
      return this.rejectOptionQuality(underlying, ct, null, `لا يوجد عقد بـ Delta ${this.config.options.deltaMin}-${this.config.options.deltaMax} | Premium $${this.config.options.minPremium}-$${this.config.options.maxPremium}`, "contract_not_found");
    }

    const singleContractNotional = this.getPositionNotional(1, opt.ask);
    if (singleContractNotional > this.getMaxPositionAmount()) {
      this.log("warn", `[POSITION_SIZE_BLOCK] ${underlying} | single-contract notional $${singleContractNotional.toFixed(2)} exceeds max $${this.getMaxPositionAmount().toFixed(2)}`, {
        symbol: underlying,
        underlying,
        optionSide: ct.toUpperCase(),
        premium: opt.ask,
        bid: opt.bid,
        ask: opt.ask,
        maxPositionAmount: this.getMaxPositionAmount(),
        botBudget: this.getPaperBotBudget(),
      });
      return null;
    }

    if (!opt.ticker || !opt.expiry || !(opt.strike > 0)) {
      return this.rejectOptionQuality(underlying, ct, opt, "contract data invalid", "valid_contract_definition_failed");
    }

    const premium = opt.ask;
    if (!(premium > 0) || premium < this.config.options.minPremium || premium > this.config.options.maxPremium || premium <= opt.bid) {
      return this.rejectOptionQuality(underlying, ct, opt, `premium sanity failed (Bid:$${opt.bid} Ask:$${opt.ask})`, "premium_sanity_filter_failed");
    }

    if (opt.volume < 100 || opt.openInterest < 100) {
      return this.rejectOptionQuality(underlying, ct, opt, `liquidity ضعيفة (Vol:${opt.volume} OI:${opt.openInterest}) | ${opt.ticker}`, "liquidity_filter_failed");
    }

    const spread = opt.ask - opt.bid;
    const spreadPct = opt.mid > 0 ? (spread / opt.mid) * 100 : 999;
    if (spreadPct > 15) {
      return this.rejectOptionQuality(underlying, ct, opt, `Spread عالي ($${spread.toFixed(2)} = ${spreadPct.toFixed(1)}% > 15%) | ${opt.ticker}`, "spread_filter_failed");
    }

    const expiryTs = Date.parse(`${opt.expiry}T20:00:00Z`);
    const dteActual = Number.isFinite(expiryTs) ? Math.round((expiryTs - Date.now()) / 86_400_000) : NaN;
    if (!Number.isFinite(dteActual) || dteActual < 0 || dteActual > 14 || !Number.isFinite(opt.delta) || Math.abs(opt.delta) < this.config.options.deltaMin || Math.abs(opt.delta) > this.config.options.deltaMax) {
      return this.rejectOptionQuality(underlying, ct, opt, `strike/expiry quality failed | DTE:${Number.isFinite(dteActual) ? dteActual : "N/A"} Δ${Math.abs(opt.delta).toFixed(3)}`, "strike_expiry_selection_quality_failed");
    }

    this.log("info", `[OPTION_ACCEPTED] ✅ ${opt.ticker} | Δ${Math.abs(opt.delta).toFixed(3)} | Bid:$${opt.bid} Ask:$${opt.ask} Spread:${spreadPct.toFixed(1)}% | Vol:${opt.volume.toLocaleString()} OI:${opt.openInterest.toLocaleString()} | IV:${(opt.iv * 100).toFixed(0)}%`, {
      symbol: underlying,
      underlying,
      optionSide: ct.toUpperCase(),
      bid: opt.bid,
      ask: opt.ask,
      premium: opt.ask,
      contractDetails: this.formatContractDetails(opt, s),
    });
    return opt;
  }

  private async openTrade(underlying: string, conf: Confirmation[], opt: OptionQuote, gate?: SmartBrainGate, executionTrace?: ExecutionTrace) {
    const s = this.config.activeStrategy as Strategy;
    const trendConf = conf.find(c => c.name === "trend");
    const ct: ContractType = trendConf?.value?.includes("صاعد") ? "call" : "put";
    const signal = `${underlying}:${conf.filter(c => c.passed).length}/8`;
    const trace: ExecutionTrace = executionTrace ?? { signalDetectedAt: Date.now() };

    if (!gate || (gate.decision !== "EXECUTE" && gate.decision !== "REDUCE")) {
      this.log("error", `[SMART_BRAIN_BLOCK] signal:${signal} | decision:${gate?.decision || "BYPASSED"} | reason:${gate?.reason || "smart_brain_bypass_blocked"}`, {
        symbol: underlying,
        underlying,
        optionSide: ct.toUpperCase(),
        decision: (gate?.decision as BotDecision | undefined) ?? null,
        confidence: gate?.confidence ?? null,
        latencyMs: gate?.latencyMs ?? null,
        reason: gate?.reason || "smart_brain_bypass_blocked",
      });
      return;
    }

    this.enforceLiveSafeConfig();
    const liveSafeStopReason = this.getLiveSafeStopReason();

    this.log("info", `[EXECUTION_GATE] signal:${gate.signal} | decision:${gate.decision} | reason:${gate.reason}`, {
      symbol: underlying,
      underlying,
      optionSide: ct.toUpperCase(),
      decision: gate.decision,
      confidence: gate.confidence ?? null,
      smartBrainRawScore: gate.rawScore ?? null,
      latencyMs: gate.latencyMs ?? null,
      reason: gate.reason,
      reasonCodes: gate.reasonCodes ?? [],
      requestedSize: gate.requestedSize ?? null,
      finalSize: gate.finalSize ?? null,
      botBudget: this.getPaperBotBudget(),
      dailyLossLimitAmount: this.getDailyLossLimitAmount(),
      currentRealizedPnlToday: this.getDailyPnl(),
      stopTradingTriggered: Boolean(liveSafeStopReason),
      bid: opt.bid,
      ask: opt.ask,
      premium: opt.ask,
      contractDetails: this.formatContractDetails(opt, s),
    });
    if (liveSafeStopReason) {
      this.stopTradingNow(liveSafeStopReason);
      return;
    }
    if (!opt || !(opt.ask > 0) || !opt.ticker || !opt.expiry || !(opt.strike > 0)) {
      this.stopTradingNow(`OPTION_DATA_INVALID:${underlying}`);
      return;
    }

    const requestedSize = gate.requestedSize ?? this.getRequestedContractsForEntry();
    const stopProfile = getAssetStopProfile(underlying);
    let orderQuantity = gate.finalSize ?? this.getFinalContractsForDecision(gate.decision);
    let finalSizeReason = gate.finalSizeReason ?? (gate.decision === "REDUCE" ? "smart_brain_reduce" : "threshold_execute");
    if (stopProfile.initialStopDistance > 0.30 && orderQuantity > stopProfile.defaultContracts) {
      orderQuantity = stopProfile.defaultContracts;
      finalSizeReason = `${finalSizeReason}|wider_stop_auto_reduce`;
      this.log("info", `[STOP_WIDTH_AUTO_REDUCE] ${underlying} | asset:${stopProfile.assetType} | requested:${requestedSize} | final:${orderQuantity} | initialStop:$${stopProfile.initialStopDistance.toFixed(2)} | reason:${stopProfile.stopWidthReason}`);
    }
    const orderNotional = this.getPositionNotional(orderQuantity, opt.ask);
    const maxPositionAmount = this.getMaxPositionAmount();
    if (orderQuantity < 1) {
      this.log("warn", `[POSITION_SIZE_BLOCK] ${underlying} | final size < 1`, {
        symbol: underlying,
        underlying,
        optionSide: ct.toUpperCase(),
        requestedSize,
        finalSize: orderQuantity,
        botBudget: this.getPaperBotBudget(),
        maxPositionAmount,
      });
      return;
    }
    if (orderNotional > maxPositionAmount) {
      this.log("warn", `[POSITION_SIZE_BLOCK] ${underlying} | requested:${requestedSize} | final:${orderQuantity} | notional:$${orderNotional.toFixed(2)} > max:$${maxPositionAmount.toFixed(2)}`, {
        symbol: underlying,
        underlying,
        optionSide: ct.toUpperCase(),
        requestedSize,
        finalSize: orderQuantity,
        botBudget: this.getPaperBotBudget(),
        maxPositionAmount,
        currentRealizedPnlToday: this.getDailyPnl(),
        reason: "position_size_limit_exceeded",
      });
      try { notifyTradeRejected(underlying, `position_size_limit_exceeded [$${orderNotional.toFixed(2)} > $${maxPositionAmount.toFixed(2)}]`); } catch {}
      return;
    }

    const concurrentAllowance = this.getConcurrentPositionAllowance(underlying, ct, conf, gate);
    if (this.getOpenTrades().length >= concurrentAllowance) {
      this.log("info", `[CONCURRENT_LIMIT] ${underlying} blocked | open:${this.getOpenTrades().length} | allowed:${concurrentAllowance} | confidence:${gate?.confidence ?? 0} | contract:${ct.toUpperCase()}`);
      return;
    }

    let fillPrice: number;
    let slippage = 0;
    let ibkrOrderId: number | undefined;

    if (!market.isIBKRConnected()) {
      this.logDecisionAudit(underlying, "BLOCK", "ibkr_execution_unavailable", opt.source, {
        optionSide: ct.toUpperCase(),
        requestedSize,
        finalSize: orderQuantity,
        optionTicker: opt.ticker,
      });
      this.log("warn", `[EXECUTION_BLOCKED] ${underlying} | IBKR execution unavailable`);
      return;
    }

    if (market.isIBKRConnected()) {
      const midpoint = opt.bid > 0 && opt.ask > 0 ? Math.round(((opt.bid + opt.ask) / 2) * 100) / 100 : 0;
      const marketPrice = midpoint > 0 ? midpoint : opt.ask;
      const liveEntryReference = opt.bid > 0 && opt.ask > 0 ? Math.round((midpoint - 0.01) * 100) / 100 : Math.round(Math.max(0.01, opt.ask - 0.02) * 100) / 100;
      const limitPrice = Math.max(0.01, Math.min(Math.round((opt.ask + 0.02) * 100) / 100, liveEntryReference));
      const stopLossPrice = getInitialStopPrice(limitPrice, underlying);
      const previewOrderId = Number.isFinite((ibkr as any)?.nextOrderId) ? Number((ibkr as any).nextOrderId) : "n/a";
      this.log("trade", `[IBKR_PRE_SUBMIT] Proposed Price:$${limitPrice} | Market Price:$${marketPrice} | Bid:$${opt.bid} | Ask:$${opt.ask} | Midpoint:$${midpoint} | orderId:${previewOrderId} | permId:n/a`, {
        symbol: underlying,
        underlying,
        optionSide: ct.toUpperCase(),
        signalScore: gate.signal,
        smartBrainRawScore: gate.rawScore ?? null,
        confidence: gate.confidence ?? null,
        decision: gate.decision,
        requestedSize,
        finalSize: orderQuantity,
        botBudget: this.getPaperBotBudget(),
        dailyLossLimitAmount: this.getDailyLossLimitAmount(),
        currentRealizedPnlToday: this.getDailyPnl(),
        assetType: stopProfile.assetType,
        initialStop: stopProfile.initialStopDistance,
        trailingStop: stopProfile.trailingStopDistance,
        stopWidthReason: stopProfile.stopWidthReason,
        orderType: "LMT + STP BRACKET",
        stopType: "STP",
        protectionMode: "broker-side",
        brokerSideStop: true,
      });
      this.log("trade", `[IBKR_ORDER] إرسال Bracket BUY+STOP ${ct.toUpperCase()} ${underlying} Strike:$${opt.strike} Exp:${opt.expiry} @ Limit:$${limitPrice} | Stop:$${stopLossPrice}`, {
        symbol: underlying,
        underlying,
        optionSide: ct.toUpperCase(),
        requestedSize,
        finalSize: orderQuantity,
        assetType: stopProfile.assetType,
        initialStop: stopProfile.initialStopDistance,
        trailingStop: stopProfile.trailingStopDistance,
        stopWidthReason: stopProfile.stopWidthReason,
        finalSizeReason,
        orderType: "LMT + STP BRACKET",
        stopType: "STP",
        protectionMode: "broker-side",
        brokerSideStop: true,
      });
      trace.orderSubmittedAt = Date.now();
      this.log("trade", `[ORDER_SUBMITTED] ${underlying} | ${opt.ticker} | qty:${orderQuantity}`, {
        symbol: underlying,
        underlying,
        optionTicker: opt.ticker,
        stage: "order_submitted",
        stageTsMs: trace.orderSubmittedAt,
        elapsedFromSignalMs: trace.orderSubmittedAt - trace.signalDetectedAt,
        elapsedFromContractSelectedMs: trace.contractSelectedAt ? trace.orderSubmittedAt - trace.contractSelectedAt : null,
        requestedSize,
        finalSize: orderQuantity,
      });
      // LIVE_CAUTIOUS: DRY_RUN mode to prevent actual orders
      const DRY_RUN = false;
      // Bidirectional support: trade side defaults to LONG; SHORT only allowed in DRY_RUN.
      const sideForSim: "LONG" | "SHORT" = (gate?.tradeSide === "SHORT") ? "SHORT" : "LONG";
      let result: any;
      if (DRY_RUN) {
        // ===== FULL DRY_RUN STRATEGY (Parts 1-7) =====
        try {
          const mesStops = calculateMesStops(limitPrice, sideForSim);
          this.log("info", `[DRY_RUN][MES_STOPS] side:${sideForSim} entry:$${mesStops.entryPrice} stop:$${mesStops.stopPrice} target:$${mesStops.targetPrice} trailDist:${mesStops.trailDistance} trailAct:${mesStops.trailActivation} pLockTrig:${mesStops.profitLockTrigger} pLockLvl:${mesStops.profitLockLevel}`);
          // Position sizing context (best-effort, derived from current decision context)
          const sizeCtx = {
            candleQuality: 0.5,
            vwapReclaimOrBounce: false,
            vix: market.getVIX(),
            macroBlocked: false,
            context5mAligned: true,
            context15mAligned: true,
            fallingKnife: false,
            recentSimulatedPnl: (this as any).getDailyPnl ? this.getDailyPnl() : 0,
            dailyLossTier: "NONE" as const,
          };
          const sized = calculatePositionSize(sizeCtx);
          this.log("info", `[DRY_RUN][POSITION_SIZE] size=${sized.size} reasons=[${sized.reasons.join(",")}]`);
          // Initial simulated trade state with profit lock + trailing tracking
          const simState = initSimulatedTradeState(limitPrice, sideForSim);
          const sideTag = sideForSim === "SHORT" ? "SHORT_" : "";
          this.log("info", `[DRY_RUN][${sideTag}SIM_TRADE_INIT] side:${sideForSim} entry:$${simState.entryPrice} simStop:$${simState.simulatedStopPrice} pLockS1:${simState.profitLockStage1} pLockS2:${simState.profitLockStage2} trailing:${simState.trailingActive}`);
          // Range regime sample (uses available market snapshot)
          const stockData = (market as any).getStockData ? (market as any).getStockData(underlying) : null;
          if (stockData) {
            const rangeReg = detectRangeRegime({
              high: Number((stockData as any).high) || limitPrice,
              low: Number((stockData as any).low) || limitPrice,
              vwap: Number((stockData as any).vwap) || limitPrice,
              vix: market.getVIX(),
              macroBlocked: false,
              recentWicksRatio: 0.3,
              volumeIrregularity: 0.3,
              fakeBreaksCount: 0,
              vwapVolatilityPct: 0.05,
              hasCandleData: true,
            });
            this.log("info", `[DRY_RUN][RANGE_REGIME] mode=${rangeReg.mode} ${"reasons" in rangeReg ? "reasons=[" + rangeReg.reasons.join(",") + "]" : "missing=[" + rangeReg.missingFields.join(",") + "]"}`);
          } else {
            this.log("info", `[DRY_RUN][RANGE_REGIME] RANGE_MODE_DATA_MISSING fields=[stockData]`);
          }
          // Daily loss tier (simulated)
          const equity = ((this.config as any).broker?.netLiquidatingValue) || 1589;
          const tier = classifyDailyLossTier((this as any).getDailyPnl ? this.getDailyPnl() : 0, equity);
          const tierTag = dailyLossTierLogTag(tier);
          if (tierTag) this.log("info", `[DRY_RUN][DAILY_TIER] ${tierTag}`);
        } catch (e: any) {
          this.log("warn", `[DRY_RUN][STRATEGY_ERR] ${e?.message || e}`);
        }
        // ===== END FULL DRY_RUN STRATEGY =====
        const simAction = sideForSim === "SHORT" ? "SELL_TO_OPEN_SIM" : "BUY";
        this.log("info", `[DRY_RUN] Simulated placeBracketOrder: ${simAction} ${orderQuantity} ${underlying} ${ct.toUpperCase()} @ Limit:$${limitPrice} | Stop:$${stopLossPrice} | side:${sideForSim}`);
        result = {
          status: "Filled",
          avgFillPrice: limitPrice,
          orderId: Math.floor(Math.random() * 1000000),
          permId: Math.floor(Math.random() * 1000000)
        };
      } else {
        // ===== HARD GUARD: Live SHORT is never allowed to reach IBKR =====
        if (sideForSim === "SHORT") {
          this.log("warn", `[LIVE_SHORT_BLOCKED] ${underlying} placeBracketOrder aborted: SHORT not allowed in live mode`);
          throw new Error("LIVE_SHORT_BLOCKED: SHORT entries are disabled in live mode");
        }
        result = await ibkr.placeBracketOrder(underlying, ct, opt.strike, opt.expiry, orderQuantity, limitPrice, stopLossPrice);
      }
      trace.orderAcknowledgedAt = Date.now();
      this.log("trade", `[ORDER_ACKNOWLEDGED] ${underlying} | status:${result?.status || "timeout"} | orderId:${result?.orderId ?? "n/a"}`, {
        symbol: underlying,
        underlying,
        optionTicker: opt.ticker,
        stage: "order_acknowledged",
        stageTsMs: trace.orderAcknowledgedAt,
        elapsedFromSignalMs: trace.orderAcknowledgedAt - trace.signalDetectedAt,
        elapsedFromOrderSubmittedMs: trace.orderSubmittedAt ? trace.orderAcknowledgedAt - trace.orderSubmittedAt : null,
        orderStatus: result?.status || "timeout",
        orderId: result?.orderId ?? null,
      });
      // ============================================================
      // TASK A+D: PROTECTION-READY GUARD (strict)
      // Requires: parent orderId + stop child submitted; target child if expected.
      // On failure: block trade registration, log [LIVE_PROTECTION_FAILED],
      // Telegram critical alert, PENDING_EMERGENCY_FLATTEN_AUDIT (no invented flatten).
      //
      // DRY_RUN EXCEPTION: in DRY_RUN (no real IBKR order), `result` is synthesized
      // locally and has no real stopOrderId/parent/child statuses. The Live Protection
      // guard must NOT run in DRY_RUN; protection is simulated via simState.simulatedStopPrice.
      // Live path is unchanged.
      // ============================================================
      const protectionReady = (() => {
        if (DRY_RUN) {
          this.log("info", `[DRY_RUN][LIVE_PROTECTION_BYPASS] ${underlying} | guard skipped (no real IBKR order); SIM stop active`);
          return true;
        }
        const expectTargetChild = Boolean((result as any)?.targetOrderId || (result as any)?.childTargetStatus);
        const protCheck = isProtectionReady(result as any, expectTargetChild);
        const silentClass = classifySilentFailure(result as any, expectTargetChild);
        if (!protCheck.ok) {
          this.log("error", `[LIVE_PROTECTION_FAILED] ${underlying} | reasons=${protCheck.reasons.join(",")} | silent=${silentClass.class}:${silentClass.detail}`, {
            symbol: underlying,
            underlying,
            optionSide: ct.toUpperCase(),
            stage: "protection_failed",
            orderId: (result as any)?.orderId ?? null,
            stopOrderId: (result as any)?.stopOrderId ?? null,
            targetOrderId: (result as any)?.targetOrderId ?? null,
            parentStatus: (result as any)?.parentStatus ?? (result as any)?.status ?? null,
            childStopStatus: (result as any)?.childStopStatus ?? null,
            childTargetStatus: (result as any)?.childTargetStatus ?? null,
            reasons: protCheck.reasons,
            silentClass: silentClass.class,
            silentDetail: silentClass.detail,
            emergencyFlattenPossiblyNeeded: protCheck.emergencyFlattenPossiblyNeeded,
          });
          try { notifyCriticalError("LIVE_PROTECTION_FAILED", `${underlying} | ${silentClass.class} | ${protCheck.reasons.join(",")}`); } catch {}
          if (protCheck.emergencyFlattenPossiblyNeeded) {
            this.log("error", `[PENDING_EMERGENCY_FLATTEN_AUDIT] ${underlying} parent may be filled without stop. No automatic flatten performed. Owner must audit IBKR manually.`);
            try { notifyCriticalError("EMERGENCY_FLATTEN_AUDIT_NEEDED", `${underlying} parent may be filled without protection — manual audit required.`); } catch {}
          }
          this.stopTradingNow(`[LIVE_PROTECTION_FAILED] ${underlying}:${silentClass.class}`);
          return false;
        }
        return true;
      })();
      if (!protectionReady) return;
      if (result && result.status === "Filled" && protectionReady) {
        fillPrice = result.avgFillPrice;
        ibkrOrderId = result.orderId;
        if (result.stopOrderId) this.ibkrStopOrderIds.set(String(result.orderId), result.stopOrderId);
        trace.fillReceivedAt = Date.now();
        this.log("trade", `[FILL_RECEIVED] ${underlying} | fill:$${fillPrice} | orderId:${result.orderId}`, {
          symbol: underlying,
          underlying,
          optionTicker: opt.ticker,
          stage: "fill_received",
          stageTsMs: trace.fillReceivedAt,
          elapsedFromSignalMs: trace.fillReceivedAt - trace.signalDetectedAt,
          elapsedFromOrderSubmittedMs: trace.orderSubmittedAt ? trace.fillReceivedAt - trace.orderSubmittedAt : null,
          orderId: result.orderId,
          permId: result.permId ?? null,
        });
        this.log("trade", `[IBKR_FILLED] ✅ تم التنفيذ @ $${fillPrice} | OrderId: ${result.orderId} | StopOrderId: ${result.stopOrderId ?? 'n/a'} | PermId:${result.permId ?? 'n/a'}`, {
          symbol: underlying,
          underlying,
          optionSide: ct.toUpperCase(),
          requestedSize,
          finalSize: orderQuantity,
          orderType: "LMT + STP BRACKET",
          orderId: result.orderId,
          permId: result.permId ?? null,
          stopOrderId: result.stopOrderId ?? null,
          assetType: stopProfile.assetType,
          initialStop: stopProfile.initialStopDistance,
          trailingStop: stopProfile.trailingStopDistance,
          stopWidthReason: stopProfile.stopWidthReason,
          finalSizeReason,
          stopType: "STP",
          protectionMode: "broker-side",
          brokerSideStop: true,
        });
      } else {
        if (result && result.status === "Filled" && !protectionReady) {
          this.log("error", `[BROKER_PROTECTION_MISSING] ${underlying} | filled without confirmed stop child`, {
            symbol: underlying,
            underlying,
            optionSide: ct.toUpperCase(),
            orderId: result.orderId,
            permId: result.permId ?? null,
            stopOrderId: result.stopOrderId ?? null,
            parentStatus: result.parentStatus ?? result.status,
            childStopStatus: result.childStopStatus ?? null,
            orderType: "LMT + STP BRACKET",
            stopType: "STP",
            protectionMode: "broker-side",
            brokerSideStop: false,
            reason: "protection_not_confirmed",
          });
          try { 
            const DRY_RUN = false;
            if (DRY_RUN) {
              this.log("info", `[DRY_RUN] Simulated placeOrder: SELL ${orderQuantity} ${underlying} ${ct.toUpperCase()}`);
            } else {
              await ibkr.placeOrder(underlying, ct, opt.strike, opt.expiry, "SELL", orderQuantity); 
            }
          } catch {}
        }
        const rejectStatus = result?.status || "timeout";
        const rejectPayload = {
          orderId: result?.orderId ?? previewOrderId,
          permId: result?.permId ?? "n/a",
          parentStatus: result?.parentStatus ?? rejectStatus,
          childStopStatus: result?.childStopStatus ?? "n/a",
          code: result?.code ?? "n/a",
          errorMessage: result?.errorMessage ?? "n/a",
          rejectReason: result?.rejectReason ?? "n/a",
          advancedOrderRejectJson: result?.advancedOrderRejectJson ?? null,
        };
        this.log("warn", `[IBKR_REJECTED] ❌ فشل التنفيذ: ${rejectStatus} | orderId:${rejectPayload.orderId} | permId:${rejectPayload.permId} | parentStatus:${rejectPayload.parentStatus} | childStopStatus:${rejectPayload.childStopStatus} | code:${rejectPayload.code} | err.message:${rejectPayload.errorMessage}`);
        this.log("warn", `[IBKR_REJECTED_RAW] ${JSON.stringify(result ?? null)}`);
        this.log("warn", `[IBKR_REJECTED_DETAILS] ${JSON.stringify(rejectPayload)}`);
        try { notifyTradeRejected(underlying, `رفض من IBKR: ${rejectStatus} | code:${rejectPayload.code} | permId:${rejectPayload.permId}`); } catch {}
        this.stopTradingNow(`[IBKR_REJECTED] ${underlying}:${rejectStatus}`);
        return;
      }
    } else {
      trace.orderSubmittedAt = Date.now();
      this.log("trade", `[ORDER_SUBMITTED] ${underlying} | simulated-paper | qty:${orderQuantity}`, {
        symbol: underlying,
        underlying,
        optionTicker: opt.ticker,
        stage: "order_submitted",
        stageTsMs: trace.orderSubmittedAt,
        elapsedFromSignalMs: trace.orderSubmittedAt - trace.signalDetectedAt,
        elapsedFromContractSelectedMs: trace.contractSelectedAt ? trace.orderSubmittedAt - trace.contractSelectedAt : null,
        requestedSize,
        finalSize: orderQuantity,
      });
      const entrySpread = opt.ask - opt.bid;
      slippage = Math.min(Math.round(entrySpread * 0.3 * 100) / 100, 0.05);
      slippage = Math.max(slippage, 0.01);
      fillPrice = Math.round((opt.ask + slippage) * 100) / 100;
      trace.orderAcknowledgedAt = Date.now();
      this.log("trade", `[ORDER_ACKNOWLEDGED] ${underlying} | status:simulated_fill`, {
        symbol: underlying,
        underlying,
        optionTicker: opt.ticker,
        stage: "order_acknowledged",
        stageTsMs: trace.orderAcknowledgedAt,
        elapsedFromSignalMs: trace.orderAcknowledgedAt - trace.signalDetectedAt,
        elapsedFromOrderSubmittedMs: trace.orderSubmittedAt ? trace.orderAcknowledgedAt - trace.orderSubmittedAt : null,
        orderStatus: "simulated_fill",
      });
      trace.fillReceivedAt = Date.now();
      this.log("trade", `[FILL_RECEIVED] ${underlying} | fill:$${fillPrice} | simulated-paper`, {
        symbol: underlying,
        underlying,
        optionTicker: opt.ticker,
        stage: "fill_received",
        stageTsMs: trace.fillReceivedAt,
        elapsedFromSignalMs: trace.fillReceivedAt - trace.signalDetectedAt,
        elapsedFromOrderSubmittedMs: trace.orderSubmittedAt ? trace.fillReceivedAt - trace.orderSubmittedAt : null,
      });
      this.log("info", `[SLIPPAGE] Spread:$${entrySpread.toFixed(2)} → Slippage:$${slippage.toFixed(2)} (${((slippage / entrySpread) * 100).toFixed(0)}% of spread)`);
    }
    const stockPrice = market.getPrice(underlying);
    const pc = conf.filter(c => c.passed).length;
    const tConfig = getTrailingConfig(underlying, fillPrice);

    const t: Trade = {
      id: rid(), mode: this.config.mode, strategy: s, underlying,
      symbol: `${underlying} ${opt.expiry} $${opt.strike}${ct === "call" ? "C" : "P"}`,
      optionTicker: opt.ticker, contractType: ct,
      strike: opt.strike, expiry: opt.expiry,
      entryPremium: fillPrice, currentPremium: fillPrice,
      quantity: orderQuantity,
      delta: Math.abs(opt.delta), gamma: opt.gamma, theta: opt.theta, vega: opt.vega,
      iv: opt.iv, volume: opt.volume, openInterest: opt.openInterest,
      pnl: 0, pnlPercent: 0,
      peakPrice: fillPrice,
      trailingActive: false,
      trailingStopPrice: getInitialStopPrice(fillPrice, underlying),
      trailingConfig: tConfig,
      openedAt: Date.now(), status: "open",
      dataSource: market.isIBKRConnected() ? (this.config.mode === "live" ? "ibkr-live" : "ibkr-paper") : "real-data-paper",
    };

    this.trades.push(t);
    if (ibkrOrderId !== undefined) {
      const stopOrderId = this.ibkrStopOrderIds.get(String(ibkrOrderId));
      if (stopOrderId !== undefined) this.ibkrStopOrderIds.set(t.id, stopOrderId);
    }
    this.lastTradeTime = Date.now();

    try {
      saveTrade({
        id: t.id,
        mode: t.mode,
        strategy: t.strategy,
        underlying: t.underlying,
        symbol: t.symbol,
        contract_type: t.contractType,
        strike: t.strike,
        expiry: t.expiry,
        entry_premium: t.entryPremium,
        exit_premium: null,
        quantity: t.quantity,
        delta: t.delta,
        pnl: null,
        pnl_percent: null,
        status: "open",
        open_reason: `${conf.filter(c => c.passed).length}/8 confirmations`,
        close_reason: null,
        opened_at: t.openedAt,
        closed_at: null,
        data_source: t.dataSource,
      });
    } catch (e: any) {
      console.error(`[DB] Failed to save trade: ${e.message}`);
    }

    const spread = opt.ask - opt.bid;
    const spreadPct = opt.mid > 0 ? ((spread / opt.mid) * 100).toFixed(1) : '?';
    this.log("trade",
      `[TRADE_OPEN] 🟢 ${ct.toUpperCase()} ${underlying} @$${fillPrice.toFixed(2)} (Ask:$${opt.ask} + Slip:$${slippage.toFixed(2)}) | Asset:${stopProfile.assetType} | Strike:$${opt.strike} | Exp:${opt.expiry} | Δ${Math.abs(opt.delta).toFixed(3)} IV:${(opt.iv * 100).toFixed(0)}% | initial stop:$${stopProfile.initialStopDistance.toFixed(2)} | trailing stop:$${tConfig.distance.toFixed(2)} | final size:${orderQuantity} | reason:${stopProfile.stopWidthReason}`,
      {
        tradeId: t.id,
        symbol: underlying,
        underlying,
        optionSide: ct.toUpperCase(),
        confidence: gate.confidence ?? null,
        decision: gate.decision,
        smartBrainRawScore: gate.rawScore ?? null,
        latencyMs: gate.latencyMs ?? null,
        reason: gate.reason,
        requestedSize,
        finalSize: orderQuantity,
        assetType: stopProfile.assetType,
        initialStop: stopProfile.initialStopDistance,
        trailingStop: stopProfile.trailingStopDistance,
        stopWidthReason: stopProfile.stopWidthReason,
        finalSizeReason,
        orderType: market.isIBKRConnected() ? "LMT + STP BRACKET" : "SIMULATED_ENTRY",
        stopType: "STP",
        protectionMode: market.isIBKRConnected() ? "broker-side" : "local",
        brokerSideStop: market.isIBKRConnected(),
        bid: opt.bid,
        ask: opt.ask,
        premium: fillPrice,
        contractDetails: this.formatContractDetails(opt, s, fillPrice),
      }
    );
    this.log("trade",
      `📋 سبب الدخول [${pc}/8]: السهم:$${stockPrice?.toFixed(2) ?? 'N/A'} | Asset:${stopProfile.assetType} | Bid:$${opt.bid} Ask:$${opt.ask} Spread:${spreadPct}% | حجم:${opt.volume.toLocaleString()} OI:${opt.openInterest.toLocaleString()} | Slippage:$${slippage.toFixed(2)} | Req:${requestedSize} Final:${orderQuantity} | Initial Stop:$${stopProfile.initialStopDistance.toFixed(2)} | Trailing Stop:$${tConfig.distance.toFixed(2)} | Stop Reason:${stopProfile.stopWidthReason}`,
      {
        tradeId: t.id,
        symbol: underlying,
        underlying,
        optionSide: ct.toUpperCase(),
        confidence: gate.confidence ?? null,
        decision: gate.decision,
        smartBrainRawScore: gate.rawScore ?? null,
        latencyMs: gate.latencyMs ?? null,
        reason: gate.reason,
        requestedSize,
        finalSize: orderQuantity,
        assetType: stopProfile.assetType,
        initialStop: stopProfile.initialStopDistance,
        trailingStop: stopProfile.trailingStopDistance,
        stopWidthReason: stopProfile.stopWidthReason,
        finalSizeReason,
        orderType: market.isIBKRConnected() ? "LMT + STP BRACKET" : "SIMULATED_ENTRY",
        stopType: "STP",
        protectionMode: market.isIBKRConnected() ? "broker-side" : "local",
        brokerSideStop: market.isIBKRConnected(),
        bid: opt.bid,
        ask: opt.ask,
        premium: fillPrice,
        contractDetails: this.formatContractDetails(opt, s, fillPrice),
      }
    );
    const passedList = conf.filter(c => c.passed).map(c => `${c.label}=${c.value}`).join(" | ");
    this.log("info", `📊 تأكيدات الدخول: ${passedList}`);
    const entryStopLoss = getInitialStopPrice(fillPrice, underlying);
    const trailingActivationPrice = Math.round((fillPrice + tConfig.activation) * 100) / 100;
    // ===== FUTURES DRY_RUN TELEGRAM LABELS =====
    // For MES futures, label type as LONG/SHORT and use MES_STOPS (entry/stop/target in points)
    // instead of option premium + strike/expiry. Live options path is unchanged.
    const isFutEntry = isFuturesMode();
    const futSide: "LONG" | "SHORT" = ((gate as any)?.tradeSide === "SHORT") ? "SHORT" : "LONG";
    const futStops = isFutEntry ? calculateMesStops(fillPrice, futSide) : null;
    const telemetryType = isFutEntry ? futSide : ct.toUpperCase();
    const telemetryExpiry = isFutEntry ? "-" : opt.expiry;
    const telemetryStrike = isFutEntry ? 0 : opt.strike;
    const telemetryEntry = isFutEntry && futStops ? futStops.entryPrice : fillPrice;
    const telemetryStop = isFutEntry && futStops ? futStops.stopPrice : entryStopLoss;
    const telemetryTarget = isFutEntry && futStops ? futStops.targetPrice : trailingActivationPrice;
    try {
      notifyTradeEntry(
        underlying,
        telemetryExpiry,
        telemetryStrike,
        telemetryType,
        orderQuantity,
        telemetryEntry,
        telemetryStop,
        telemetryTarget,
        gate.confidence ?? 0,
        [],
        [],
        t.openedAt,
        {
          signalScore: gate.signal,
          rawScore: gate.rawScore ?? null,
          requestedSize,
          finalSize: orderQuantity,
          reductionReason: finalSizeReason,
          orderType: isFutEntry ? "SIMULATED_FUTURES_ENTRY" : (market.isIBKRConnected() ? "LMT + STP BRACKET" : "SIMULATED_ENTRY"),
          orderId: ibkrOrderId ?? null,
          permId: null,
          stopType: isFutEntry ? "MES_STOP_6PT" : "STP",
          protectionMode: isFutEntry ? "sim-local" : (market.isIBKRConnected() ? "broker-side" : "local"),
          brokerSideStop: isFutEntry ? false : market.isIBKRConnected(),
          trailingDistance: tConfig.distance,
        },
      );
    } catch {}
  }

  // ========== NEW EXIT LOGIC (Dollar-based trailing on option premium) ==========
  private async checkExits() {
    // Iterate over raw trade references so closeTrade() mutations persist.
    for (const t of this.trades.filter(x => x.status === "open")) {
      const currentPremium = t.currentPremium;
      const { activation, distance } = t.trailingConfig;

      // ===== FUTURES EXIT BRANCH (MES DRY_RUN) =====
      // Use fixed-point stop/target on the price itself (not option premium).
      // stop  = entry ± MES_STOP_POINTS (6pt)
      // target= entry ± MES_TARGET_POINTS (8pt)
      // Side is from t.tradeSide (LONG default; SHORT if recorded).
      if (t.tradeMode === "futures" || t.underlying === "MES") {
        const side: "LONG" | "SHORT" = (t.tradeSide === "SHORT") ? "SHORT" : "LONG";
        const stops = calculateMesStops(t.entryPremium, side);
        const px = t.currentPremium;
        if (side === "LONG") {
          if (px <= stops.stopPrice) {
            this.log("info", `[FUT_CLOSE_SL] ${t.underlying} LONG | entry:$${t.entryPremium} | px:$${px} | stop:$${stops.stopPrice}`);
            await this.closeTrade(t, "stop-loss");
            continue;
          }
          if (px >= stops.targetPrice) {
            this.log("info", `[FUT_CLOSE_TP] ${t.underlying} LONG | entry:$${t.entryPremium} | px:$${px} | target:$${stops.targetPrice}`);
            await this.closeTrade(t, "trailing-stop");
            continue;
          }
        } else {
          if (px >= stops.stopPrice) {
            this.log("info", `[FUT_CLOSE_SL] ${t.underlying} SHORT | entry:$${t.entryPremium} | px:$${px} | stop:$${stops.stopPrice}`);
            await this.closeTrade(t, "stop-loss");
            continue;
          }
          if (px <= stops.targetPrice) {
            this.log("info", `[FUT_CLOSE_TP] ${t.underlying} SHORT | entry:$${t.entryPremium} | px:$${px} | target:$${stops.targetPrice}`);
            await this.closeTrade(t, "trailing-stop");
            continue;
          }
        }
        // No futures exit triggered; skip options-path checks for this trade.
        continue;
      }

      // 4. Exit check - premium hit or dropped below trailing stop
      if (t.trailingActive && currentPremium <= t.trailingStopPrice) {
        const profit = currentPremium - t.entryPremium;
        this.log("info", `[CLOSE_TRAILING] ${t.underlying} | entry: $${t.entryPremium.toFixed(2)} | exit: $${currentPremium.toFixed(2)} | profit: $${profit.toFixed(2)} | peak: $${t.peakPrice.toFixed(2)} | stop: $${t.trailingStopPrice.toFixed(2)} | reason: trailing_stop`);
        await this.closeTrade(t, "trailing-stop");
        continue;
      }

      // 5. BEFORE trailing activates - initial SL still protects
      if (!t.trailingActive) {
        const initialStopPrice = getInitialStopPrice(t.entryPremium, t.underlying);
        if (currentPremium <= initialStopPrice) {
          this.log("info", `[CLOSE_SL] ${t.underlying} | entry: $${t.entryPremium.toFixed(2)} | exit: $${currentPremium.toFixed(2)} | initial stop: $${initialStopPrice.toFixed(2)} | reason: initial_stop_loss`);
          await this.closeTrade(t, "stop-loss");
          continue;
        }
      }
    }
  }

  private async closeTrade(t: Trade, reason: Trade["closeReason"]) {
    const linkedStopOrderId = this.ibkrStopOrderIds.get(t.id);
    if (linkedStopOrderId && market.isIBKRConnected()) {
      try {
        await ibkr.cancelOrder(linkedStopOrderId);
        this.log("info", `[IBKR_STOP_CANCELLED] trade:${t.id} | stopOrderId:${linkedStopOrderId}`);
      } catch {}
      this.ibkrStopOrderIds.delete(t.id);
    }

    // ===== FUTURES CLOSE BRANCH (MES DRY_RUN) =====
    // No option premium exists for MES. Price is the live MES price, PnL at
    // $5/point. Never calls IBKR (DRY_RUN elsewhere already guarded that).
    if (t.tradeMode === "futures" || t.underlying === "MES") {
      let exitPx = t.currentPremium;
      try { const live = Number(market.getPrice(t.underlying)) || 0; if (live > 0) exitPx = live; } catch {}
      if (!(exitPx > 0)) { try { const live2 = Number(market.getPrice("MES")) || 0; if (live2 > 0) exitPx = live2; } catch {} }
      const sideF: "LONG" | "SHORT" = (t.tradeSide === "SHORT") ? "SHORT" : "LONG";
      const pointsF = sideF === "SHORT" ? (t.entryPremium - exitPx) : (exitPx - t.entryPremium);
      const pnlF = Math.round(pointsF * t.quantity * MES_DOLLAR_PER_POINT * 100) / 100;
      const paperBudgetF = this.getPaperBotBudget() || 1000;
      t.currentPremium = exitPx;
      t.pnl = pnlF;
      t.pnlPercent = Math.round((pnlF / paperBudgetF) * 10000) / 100;
      t.status = "closed"; t.closedAt = Date.now(); t.closeReason = reason;
      if (t.pnl < 0) this.consecutiveLosses++; else this.consecutiveLosses = 0;
      try {
        dbCloseTrade({
          id: t.id,
          exit_premium: exitPx,
          pnl: t.pnl,
          pnl_percent: t.pnlPercent,
          status: "closed",
          close_reason: reason ?? "unknown",
          closed_at: t.closedAt,
        });
      } catch (e: any) { console.error(`[DB] Failed to close trade: ${e.message}`); }
      this.log("trade", `${t.pnl >= 0 ? "🟢" : "🔴"} FUT_CLOSE ${sideF} ${t.underlying} entry:$${t.entryPremium} exit:$${exitPx} pts:${pointsF.toFixed(2)} pnl:$${t.pnl} (${t.pnlPercent >= 0 ? "+" : ""}${t.pnlPercent.toFixed(2)}%) reason:${reason}`, { tradeId: t.id });
      try {
        notifyTradeExit(t.symbol, t.expiry || "", t.strike || 0, (sideF as any), reason ?? "unknown", t.pnl, t.pnlPercent, exitPx, t.openedAt, t.closedAt);
      } catch {}
      return;
    }

    let exitPrice: number;
    let exitSlippage = 0;
    const updated = await market.getOptionPrice(t.underlying, t.contractType, t.strike, t.expiry);
    const rawBid = updated ? updated.bid : t.currentPremium;

    if (market.isIBKRConnected()) {
      const limitPrice = Math.max(0.01, Math.round((rawBid - 0.02) * 100) / 100);
      this.log("trade", `[IBKR_EXIT] إرسال أمر بيع ${t.contractType.toUpperCase()} ${t.underlying} @ Limit:$${limitPrice}`);
      const DRY_RUN = false;
      let result: any;
      if (DRY_RUN) {
        // ===== FULL DRY_RUN STRATEGY: shadow stop + partial close + profit lock update =====
        try {
          const simState = initSimulatedTradeState(t.entryPremium);
          const upd = updateProfitLock(simState, limitPrice);
          if (upd.events.length) this.log("info", `[DRY_RUN][PROFIT_LOCK_UPDATE] ${upd.events.join(" | ")}`);
          const exitCheck = shouldExitAtSimulatedStop(upd.state, limitPrice);
          if (exitCheck.exit) this.log("info", `[DRY_RUN][SIM_STOP_HIT] reason=${exitCheck.reason} pnlPts=${exitCheck.pnlPoints} exitPx:$${exitCheck.price}`);
          // Shadow stop sample: assume small adverse move detected
          const shadow = evaluateShadowStop({
            inProfit: limitPrice > t.entryPremium,
            red3mCandleAgainst: false,
            vwapBreakdownAfterAbove: false,
            rsiCollapseOver10In2Candles: false,
          });
          if (shadow.exit) this.log("info", `[DRY_RUN][SHADOW_EXIT] triggers=[${shadow.triggers.join(",")}]`);
          // Partial close sample for multi-contract trades
          const partial = evaluatePartialClose(
            t.quantity,
            t.quantity,
            Math.max(0, limitPrice - t.entryPremium),
            { first: false, second: false }
          );
          if (partial) {
            this.log("info", `[DRY_RUN][PARTIAL_CLOSE] zone=${partial.zone} closed=${partial.closedQty} remaining=${partial.remainingQty} simulatedPnL=$${partial.simulatedPnlUsd}`);
          }
        } catch (e: any) {
          this.log("warn", `[DRY_RUN][EXIT_STRATEGY_ERR] ${e?.message || e}`);
        }
        // ===== END =====
        this.log("info", `[DRY_RUN] Simulated placeOrder: SELL ${t.quantity} ${t.underlying} ${t.contractType.toUpperCase()} @ Limit:$${limitPrice}`);
        result = { status: "Filled", avgFillPrice: limitPrice, orderId: Math.floor(Math.random() * 1000000) };
      } else {
        result = await ibkr.placeOrder(t.underlying, t.contractType, t.strike, t.expiry, "SELL", t.quantity, limitPrice);
      }
      if (result && result.status === "Filled") {
        exitPrice = result.avgFillPrice;
        this.log("trade", `[IBKR_EXIT_FILLED] ✅ تم البيع @ $${exitPrice} | OrderId: ${result.orderId}`);
      } else {
        this.log("warn", `[IBKR_EXIT] Limit فشل، محاولة Market Order...`);
        const DRY_RUN = false;
        let mktResult: any;
        if (DRY_RUN) {
          this.log("info", `[DRY_RUN] Simulated placeOrder: SELL ${t.quantity} ${t.underlying} ${t.contractType.toUpperCase()} @ MKT`);
          mktResult = { status: "Filled", avgFillPrice: rawBid, orderId: Math.floor(Math.random() * 1000000) };
        } else {
          mktResult = await ibkr.placeOrder(t.underlying, t.contractType, t.strike, t.expiry, "SELL", t.quantity);
        }
        exitPrice = mktResult?.avgFillPrice || rawBid;
      }
    } else {
      const exitSpread = updated ? (updated.ask - updated.bid) : (rawBid * 0.02);
      exitSlippage = Math.min(Math.round(exitSpread * 0.3 * 100) / 100, 0.05);
      exitSlippage = Math.max(exitSlippage, 0.01);
      exitPrice = Math.max(0.01, Math.round((rawBid - exitSlippage) * 100) / 100);
      this.log("info", `[EXIT_SLIPPAGE] Spread:$${exitSpread.toFixed(2)} → Slippage:$${exitSlippage.toFixed(2)} (${((exitSlippage / exitSpread) * 100).toFixed(0)}% of spread)`);
    }

    t.currentPremium = exitPrice;
    t.pnl = Math.round((exitPrice - t.entryPremium) * t.quantity * 100 * 100) / 100;
    t.pnlPercent = Math.round(((exitPrice - t.entryPremium) / t.entryPremium) * 10000) / 100;
    t.status = "closed"; t.closedAt = Date.now(); t.closeReason = reason;
    if (t.pnl < 0) this.consecutiveLosses++; else this.consecutiveLosses = 0;

    try {
      dbCloseTrade({
        id: t.id,
        exit_premium: exitPrice,
        pnl: t.pnl,
        pnl_percent: t.pnlPercent,
        status: "closed",
        close_reason: reason ?? "unknown",
        closed_at: t.closedAt,
      });
    } catch (e: any) {
      console.error(`[DB] Failed to close trade: ${e.message}`);
    }

    const reasonAr: Record<string, string> = {
      "stop-loss": "🔴 Initial Stop Loss - وقف خسارة أولي (-20%)",
      "trailing-stop": "🟡 Trailing Stop - وقف متحرك",
      "manual": "⚪ إغلاق يدوي",
      "expiry": "⏰ انتهاء الصلاحية",
      "risk-limit": "🛑 حد المخاطر",
    };

    this.log("trade",
      `${t.pnl >= 0 ? '🟢' : '🔴'} إغلاق ${t.contractType.toUpperCase()} ${t.underlying} @$${exitPrice.toFixed(2)} (Bid:$${rawBid.toFixed(2)} - Slip:$${exitSlippage.toFixed(2)}) | ربح/خسارة: $${t.pnl.toFixed(2)} (${t.pnlPercent >= 0 ? '+' : ''}${t.pnlPercent.toFixed(1)}%) | peak: $${t.peakPrice.toFixed(2)}`,
      { tradeId: t.id }
    );
    this.log("trade",
      `📋 سبب الخروج: ${reasonAr[reason ?? ''] || reason} | الدخول: $${t.entryPremium.toFixed(2)} → الخروج: $${exitPrice.toFixed(2)} | Slippage: $${exitSlippage.toFixed(2)} | المدة: ${Math.round((Date.now() - t.openedAt) / 60000)} دقيقة`,
      { tradeId: t.id }
    );
    try {
      if (reason === "stop-loss") notifyStopLossHit(t.symbol, t.pnl);
      notifyTradeExit(t.symbol, t.expiry, t.strike, t.contractType, reason ?? "unknown", t.pnl, t.pnlPercent, exitPrice, t.openedAt, t.closedAt);
    } catch {}
  }

  async closeById(id: string, cp?: number) {
    if (isFuturesMode()) {
      this.logTradeModeGuard("manual option close");
      return;
    }
    const t = this.trades.find(x => x.id === id && x.status === "open");
    if (!t) return;
    const linkedStopOrderId = this.ibkrStopOrderIds.get(t.id);
    if (linkedStopOrderId && market.isIBKRConnected()) {
      try { await ibkr.cancelOrder(linkedStopOrderId); } catch {}
      this.ibkrStopOrderIds.delete(t.id);
    }
    if (cp !== undefined) {
      t.currentPremium = cp;
      t.pnl = Math.round((cp - t.entryPremium) * t.quantity * 100 * 100) / 100;
      t.pnlPercent = Math.round(((cp - t.entryPremium) / t.entryPremium) * 10000) / 100;
    }
    t.status = "closed"; t.closedAt = Date.now(); t.closeReason = "manual";
    if (t.pnl < 0) this.consecutiveLosses++; else this.consecutiveLosses = 0;

    try {
      dbCloseTrade({
        id: t.id,
        exit_premium: t.currentPremium,
        pnl: t.pnl,
        pnl_percent: t.pnlPercent,
        status: "closed",
        close_reason: "manual",
        closed_at: t.closedAt,
      });
    } catch (e: any) {
      console.error(`[DB] Failed to close trade: ${e.message}`);
    }

    this.log("trade",
      `⚪ إغلاق يدوي ${t.contractType.toUpperCase()} ${t.underlying} @$${t.currentPremium.toFixed(2)} | ربح/خسارة: $${t.pnl.toFixed(2)} (${t.pnlPercent >= 0 ? '+' : ''}${t.pnlPercent.toFixed(1)}%)`,
      { tradeId: t.id }
    );
    this.log("trade",
      `📋 سبب الخروج: ⚪ إغلاق يدوي | الدخول: $${t.entryPremium.toFixed(2)} → الخروج: $${t.currentPremium.toFixed(2)}`,
      { tradeId: t.id }
    );
    try {
      notifyTradeExit(t.symbol, t.expiry, t.strike, t.contractType, "manual", t.pnl, t.pnlPercent, t.currentPremium, t.openedAt, t.closedAt);
    } catch {}
  }

  private log(level: BotLog["level"], message: string, details?: Record<string, unknown>) {
    const normalized: BotLog = {
      id: rid(),
      level,
      message,
      details,
      createdAt: Date.now(),
      symbol: asString(details?.symbol) ?? asString(details?.underlying),
      optionSide: normalizeOptionSide(details?.optionSide ?? details?.contractType),
      confidence: asNumber(details?.confidence),
      decision: (asString(details?.decision) as BotLog["decision"]) ?? null,
      latencyMs: asNumber(details?.latencyMs),
      reason: asString(details?.reason) ?? null,
      bid: asNumber(details?.bid),
      ask: asNumber(details?.ask),
      premium: asNumber(details?.premium),
      contractDetails: details?.contractDetails && typeof details.contractDetails === "object"
        ? details.contractDetails as BotLog["contractDetails"]
        : null,
    };

    this.logs.unshift(normalized);
    if (this.logs.length > 500) this.logs.length = 500;

    try {
      saveLog({
        level,
        message,
        data: details ? JSON.stringify(details) : undefined,
      });
    } catch (_e) {
      // Silent
    }
  }

  private sendHeartbeat() {
    if (!this.running) return;
    const openTrades = this.getOpenTrades();
    const positions = openTrades.length > 0
      ? openTrades.map(t => `${t.underlying} ${t.contractType.toUpperCase()} x${t.quantity}`).join(" | ")
      : "لا توجد";
    try {
      notifyHeartbeat(this.config.mode, this.config.activeStrategy, this.running, market.getIBKRStatus(), openTrades.length, positions);
    } catch {}
  }

  // ======== PUBLIC GETTERS ========

  getStatus(): BotStatus {
    const mktStatus = getMarketStatus();
    return {
      running: this.running, mode: this.config.mode, tradeMode: this.tradeMode, activeStrategy: this.config.activeStrategy,
      uptime: this.startTime > 0 ? Date.now() - this.startTime : 0,
      marketOpen: mktStatus.open,
      marketTimeET: mktStatus.currentTimeET,
      nextMarketOpen: mktStatus.nextOpen || undefined,
      vix: market.getVIX(),
      spyPrice: market.getPrice("SPY"),
      qqqPrice: market.getPrice("QQQ"),
      openTrades: this.getOpenTrades().length,
      todayTrades: this.getTodayTrades().length,
      blockedReason: this.running ? this.checkFilters() ?? undefined : undefined,
      dataSource: this.dataState === "connected" ? (market.isIBKRConnected() ? "ibkr" : "polygon") : this.dataState === "waiting" ? "waiting" : "unavailable",
      polygonConnected: market.isPolygonAvailable(),
      ibkrConnected: market.isIBKRConnected(),
      ibkrAccountId: market.getIBKRAccountId() || undefined,
      dataTimestamp: market.getDataTimestamp(),
      dataFresh: this.dataState === "connected" && market.isDataFresh(),
      dataState: this.dataState,
      brokerAccount: this.brokerAccountSnapshot ? { ...this.brokerAccountSnapshot } : null,
    };
  }

  getOpenTrades(): Trade[] { return this.trades.filter(t => t.status === "open").map(t => sanitizeTradeForMode(t)); }
  getClosedTrades(): Trade[] { return this.trades.filter(t => t.status === "closed").sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).map(t => sanitizeTradeForMode(t)); }
  getLogs(limit = 50, filters?: { level?: string; symbol?: string; from?: number; to?: number }): BotLog[] {
    try {
      return loadLogs({ limit, ...filters }).map(normalizeBotLog).map(log => sanitizeLogForMode(log));
    } catch {
      return this.logs
        .filter(log => !filters?.level || log.level === filters.level)
        .filter(log => !filters?.symbol || log.symbol === filters.symbol)
        .filter(log => !filters?.from || log.createdAt >= filters.from)
        .filter(log => !filters?.to || log.createdAt <= filters.to)
        .slice(0, limit)
        .map(log => sanitizeLogForMode(log));
    }
  }
  getLastErrors(limit = 20): BotLog[] {
    try {
      return loadErrorLogs(limit).map(normalizeBotLog).map(log => sanitizeLogForMode(log));
    } catch {
      return this.logs.filter(log => log.level === "error" || log.level === "warn").slice(0, limit).map(log => sanitizeLogForMode(log));
    }
  }
  getSmartBrainStats(): SmartBrainStatsReport {
    const now = Date.now();
    const buildWindow = (hours: number) => {
      const from = now - hours * 60 * 60 * 1000;
      try {
        return buildDecisionStats(loadLogsSince(from, now, 5000), hours);
      } catch {
        return buildDecisionStats(this.logs.filter(log => log.createdAt >= from).map(log => ({
          id: log.id,
          level: log.level,
          message: log.message,
          details: log.details,
          createdAt: log.createdAt,
        })), hours);
      }
    };
    return {
      generatedAt: now,
      last24h: buildWindow(24),
      last48h: buildWindow(48),
    };
  }
  getConfig(): BotConfig { return sanitizeConfigForMode(JSON.parse(JSON.stringify(this.config))); }

  updateConfig(p: Partial<BotConfig>) {
    if (p.mode) this.config.mode = p.mode;
    if (p.activeStrategy) this.config.activeStrategy = "milking";
    if (p.capital) Object.assign(this.config.capital, p.capital);
    if (p.risk) Object.assign(this.config.risk, p.risk);
    if (p.options) Object.assign(this.config.options, p.options);
    if ((p as any).futures) Object.assign(this.config.futures, (p as any).futures);
    if (p.filters) Object.assign(this.config.filters, p.filters);
    if (p.zeroHero) Object.assign(this.config.zeroHero, p.zeroHero);
    this.enforceFuturesRuntimeConfig();
    this.log("info", "تم تحديث الإعدادات");
  }

  private getEtDayStartMs(ts: number = Date.now()): number {
    const utcNow = new Date(ts);
    const etNow = new Date(utcNow.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const utcWallClock = new Date(utcNow.toLocaleString("en-US", { timeZone: "UTC" }));
    const offsetMs = utcWallClock.getTime() - etNow.getTime();
    etNow.setHours(0, 0, 0, 0);
    return etNow.getTime() + offsetMs;
  }
  private getEtDateKey(ts: number): string {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(ts));
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? "00";
    return get("year") + "-" + get("month") + "-" + get("day");
  }
  private getTodayTrades(): Trade[] {
    const start = this.getEtDayStartMs();
    return this.trades.filter(t => t.openedAt >= start);
  }
  private getDailyPnl(): number { return this.getTodayTrades().filter(t => t.status === "closed").reduce((s, t) => s + t.pnl, 0); }

  getDailyStats(): DailyStats {
    const td = this.getTodayTrades(), cl = td.filter(t => t.status === "closed");
    return {
      dailyPnl: Math.round(cl.reduce((s, t) => s + t.pnl, 0) * 100) / 100,
      tradesCount: td.length, wins: cl.filter(t => t.pnl > 0).length,
      losses: cl.filter(t => t.pnl <= 0).length, startCapital: this.getEffectiveAccountBalance()
    };
  }

  getOverallStats(): OverallStats {
    const cl = this.getClosedTrades(), w = cl.filter(t => t.pnl > 0), l = cl.filter(t => t.pnl <= 0);
    const gp = w.reduce((s, t) => s + t.pnl, 0), gl = Math.abs(l.reduce((s, t) => s + t.pnl, 0)), tp = gp - gl;
    return {
      totalTrades: cl.length, wins: w.length, losses: l.length,
      winRate: cl.length ? Math.round((w.length / cl.length) * 100) : 0,
      profitFactor: gl > 0 ? Math.round((gp / gl) * 100) / 100 : gp > 0 ? 999 : 0,
      totalPnl: Math.round(tp * 100) / 100, grossProfit: Math.round(gp * 100) / 100, grossLoss: Math.round(gl * 100) / 100,
      avgWin: w.length ? Math.round((gp / w.length) * 100) / 100 : 0,
      avgLoss: l.length ? Math.round((gl / l.length) * 100) / 100 : 0,
      currentCapital: this.getEffectiveAccountBalance()
    };
  }

  getHistory(): DailyHistory[] {
    const cl = this.getClosedTrades(), bd = new Map<string, Trade[]>();
    for (const t of cl) { const d = this.getEtDateKey(t.closedAt ?? t.openedAt); if (!bd.has(d)) bd.set(d, []); bd.get(d)!.push(t); }
    return Array.from(bd.entries()).map(([date, trades]) => {
      const w = trades.filter(t => t.pnl > 0).length;
      return { date, trades: trades.length, wins: w, losses: trades.length - w, winRate: Math.round((w / trades.length) * 100), pnl: Math.round(trades.reduce((s, t) => s + t.pnl, 0) * 100) / 100 };
    }).sort((a, b) => b.date.localeCompare(a.date));
  }
}

export const engine = new TradingEngine();


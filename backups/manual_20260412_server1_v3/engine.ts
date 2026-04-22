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
import { notifyBotStart, notifyTradeEntry, notifyTradeExit, notifyTradeRejected, notifyError, notifyIBKRDisconnect, notifyIBKRReconnect, notifyStopLossHit, notifyNewsAlert, notifyDailyReport, notifyDecision, notifyDataLoadFailure, notifyWaitingMode, notifyBotStopped, notifyDataSourceFailure, notifyCriticalError, notifyHealthFailure } from "./notify.js";

type SmartBrainDecision = "EXECUTE" | "REDUCE" | "WAIT" | "REJECT";

type SmartBrainExecutionDecision = "EXECUTE" | "REDUCE";

interface SmartBrainGate {
  signal: string;
  decision: SmartBrainExecutionDecision;
  reason: string;
  confidence?: number;
  latencyMs?: number | null;
  reasonCodes?: string[];
}

interface SmartBrainResponse {
  ok?: boolean;
  service?: string;
  version?: string;
  signal: string;
  underlying: string;
  decision: SmartBrainDecision;
  confidence_final: number;
  confidence_score?: number;
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

// ========== NEW TRAILING STOP SETTINGS ==========
// Variable distances based on option premium at entry
export function getTrailingConfig(entryPremium: number): TrailingConfig {
  if (entryPremium < 2.00) {
    return { activation: 0.10, distance: 0.10 };  // cheap options ($0.50-$1.99)
  } else if (entryPremium < 4.00) {
    return { activation: 0.15, distance: 0.15 };  // mid-range ($2.00-$3.99)
  } else {
    return { activation: 0.20, distance: 0.20 };  // expensive ($4.00+)
  }
}

const INITIAL_STOP_LOSS_PCT = 0.30;  // 30% stop loss BEFORE trailing activates
// ========== END TRAILING STOP SETTINGS ==========

export const DEFAULT_CONFIG: BotConfig = {
  mode: "paper", activeStrategy: "milking",
  capital: { mainCapital: 605, paperBalance: 605, carryDailyPnlIntoCapital: true },
  risk: {
    maxTradesPerDay: 5,
    maxOpenPositions: 1,
    maxDailyLossPercent: 2, maxConsecutiveLosses: 3, cooldownMinutes: 5
  },
  options: {
    deltaMin: 0.40, deltaMax: 0.60,
    minPremium: 0.5, maxPremium: 10,
    maxContracts: 1, contractsPerTrade: 1,
    weeklyOnly: true, allow0DTE: false, allowCheapOptions: false
  },
  filters: {
    minConfirmations: 6,
    enableNewsFilter: true, enableVixFilter: true, enableVolatilityFilter: true,
    enableTimeFilter: true, blockFirst10Minutes: true, blockLast30Minutes: true,
    requireBreakout: false
  },
  zeroHero: {
    enabled: false, separateCapital: 80, maxTrades: 2,
    deltaMin: 0.1, deltaMax: 0.2, minPremium: 0.1, maxPremium: 1,
    onlyLateSession: true, requireBreakout: true, allow0DTE: true
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
  private scanIdx = 0;
  private dataState: "idle" | "waiting" | "connected" | "failed" = "idle";
  private dataRetryCount = 0;
  private ibkrDisconnectAlerted = false;
  private waitingModeAlerted = false;
  private dataLoadFailureAlerted = false;
  private dataSourceFailureAlerted = false;
  private healthFailureAlerted = false;

  constructor() {
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    try {
      const dbTrades = loadOpenTrades() as any[];
      for (const row of dbTrades) {
        const entryPrem = row.entry_premium;
        const tConfig = getTrailingConfig(entryPrem);
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
          trailingStopPrice: 0,
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

  private enforceLiveSafeConfig(): void {
    this.config.activeStrategy = "milking";
    this.config.zeroHero.enabled = false;
    this.config.zeroHero.separateCapital = 0;
    this.config.zeroHero.maxTrades = 0;
    this.config.options.maxContracts = 1;
    this.config.options.contractsPerTrade = 1;
    this.config.risk.maxDailyLossPercent = 2;
  }

  private getLiveSafeStopReason(): string | null {
    this.enforceLiveSafeConfig();
    if (process.env.EMERGENCY_STOP === "1" || process.env.LIVE_SAFE_EMERGENCY_STOP === "1") return "EMERGENCY_STOP_FLAG";
    if (this.config.activeStrategy !== "milking") return `STRATEGY_NOT_ALLOWED:${this.config.activeStrategy}`;
    if (this.config.zeroHero.enabled) return "ZERO_HERO_DISABLED";
    const vix = market.getVIX();
    if (typeof vix === "number" && vix > 25) return `VIX_LIMIT:${vix.toFixed(2)}`;
    const dailyPnl = this.getDailyPnl();
    const maxLoss = this.getStrategyCapital("milking") * 0.02;
    if (dailyPnl <= -maxLoss) return `DAILY_LOSS_LIMIT:${dailyPnl.toFixed(2)}`;
    return null;
  }

  private stopTradingNow(reason: string): string {
    this.enforceLiveSafeConfig();
    this.running = false;
    this.log("error", `[STOP_TRADING] ${reason}`);
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

    if (!market.isConfigured()) {
      this.log("error", "لا يمكن التشغيل: مفتاح API غير موجود");
      try { notifyCriticalError("بدء التشغيل", "لا يمكن التشغيل: مفتاح API غير موجود"); } catch {}
      try { notifyHealthFailure("فشل بدء التشغيل بسبب غياب مفتاح API"); } catch {}
      return;
    }

    this.running = true;
    this.startTime = Date.now();
    this.consecutiveLosses = 0;

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
      this.log("info", `✅ IBKR متصل! Account: ${market.getIBKRAccountId()} | PRICE_SOURCE=IBKR | EXECUTION=IBKR`);
    } else {
      this.ibkrDisconnectAlerted = true;
      this.log("warn", "⚠️ IBKR غير متصل - استخدام Yahoo Finance كمصدر بديل");
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
    } else {
      this.dataState = "waiting";
      this.log("warn", "فشل التحميل الأولي - البوت شغال وينتظر البيانات...");
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
      if (!this.waitingModeAlerted) {
        try { notifyWaitingMode(`السوق مغلق حالياً (${mktStatus.currentTimeET})`); } catch {}
        this.waitingModeAlerted = true;
      }
    }

    this.scanTimer = setInterval(() => this.parallelScan(), 90_000);
    this.refreshTimer = setInterval(() => this.refreshData(), 120_000);
    this.pnlTimer = setInterval(() => this.updateOpenTradePrices(), 30_000);
    setTimeout(() => this.parallelScan(), 2000);
  }

  stop() {
    this.running = false;
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    if (this.pnlTimer) { clearInterval(this.pnlTimer); this.pnlTimer = null; }
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
          this.updateTrailingStop(t, t.currentPremium);
        }
      } catch (_e) {
        // Skip silently
      }
    }
  }

  // ========== DOLLAR-BASED TRAILING STOP ==========
  private updateTrailingStop(trade: Trade, currentPremium: number) {
    const { activation, distance } = trade.trailingConfig;

    // 1. Update peak price
    if (currentPremium > trade.peakPrice) {
      trade.peakPrice = currentPremium;
    }

    // 2. Check activation (first time premium goes above entry + activation threshold)
    if (!trade.trailingActive && currentPremium >= trade.entryPremium + activation) {
      trade.trailingActive = true;
      trade.trailingStopPrice = trade.entryPremium; // breakeven
      this.log("info", `[TRAILING_ACTIVATED] ${trade.underlying} | entry: $${trade.entryPremium.toFixed(2)} | peak: $${trade.peakPrice.toFixed(2)} | protection at $${trade.trailingStopPrice.toFixed(2)} (breakeven) | config: +$${activation}/$${distance}`);
    }

    // 3. If trailing is active - move stop UP only, never down
    if (trade.trailingActive) {
      const newStop = Math.round((trade.peakPrice - distance) * 100) / 100;
      if (newStop > trade.trailingStopPrice) {
        trade.trailingStopPrice = newStop;
        this.log("info", `[TRAILING_MOVED] ${trade.underlying} | stop: $${trade.trailingStopPrice.toFixed(2)} | peak: $${trade.peakPrice.toFixed(2)} | current: $${currentPremium.toFixed(2)}`);
      }
    }
  }

  private async parallelScan() {
    if (!this.running) return;
    const scanStart = Date.now();
    try {
      if (this.dataState !== "connected") return;
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
        this.log("warn", `محظور: ${blocked}`);
        return;
      }

      if (this.getOpenTrades().length >= this.config.risk.maxOpenPositions) return;
      if (this.getTodayTrades().length >= this.config.risk.maxTradesPerDay) return;
      if (this.lastTradeTime && Date.now() - this.lastTradeTime < this.config.risk.cooldownMinutes * 60000) return;

      const isAggressive = this.config.activeStrategy === 'zeroHero';
      const minRequired = isAggressive ? 5 : 6;
      const modeName = isAggressive ? 'هجومي' : 'محافظ';

      const scanResults = await Promise.allSettled(
        UNDERLYINGS.map(async (u) => {
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

          const decision = await this.evaluateWithSmartBrain(r.underlying, r.confirmations, r.passed);
          const trendConf = r.confirmations.find(c => c.name === "trend");
          const optionSide: BotOptionSide | undefined = trendConf?.value?.includes("صاعد") ? "CALL" : "PUT";
          const decisionDetails = {
            symbol: r.underlying,
            underlying: r.underlying,
            optionSide,
            confidence: decision.confidence_final,
            decision: decision.decision,
            latencyMs: decision.latency_ms ?? null,
            reason: decision.summary,
            reasonCodes: decision.reason_codes,
            premium: null,
          };

          this.log("info", `[SMART_BRAIN] signal:${decision.signal} | confidence_final:${decision.confidence_final}% | decision:${decision.decision}`);
          this.log("info", `[SMART_BRAIN_DECISION] signal:${decision.signal} | decision:${decision.decision} | reason:${decision.summary}`, decisionDetails);
          this.log("info", `[SMART_BRAIN] reason_codes: ${decision.reason_codes.join(", ") || "NONE"}`, decisionDetails);
          this.log("info", `[SMART_BRAIN] summary: ${decision.summary}`, decisionDetails);
          if (decision.emergency_stop) {
            this.log("warn", `[SMART_BRAIN] EMERGENCY_STOP active for ${r.underlying}`, decisionDetails);
          }

          try {
            notifyDecision(
              r.underlying,
              decision.signal,
              decision.decision,
              decision.confidence_final,
              decision.reason_codes,
              decision.summary,
              Boolean(decision.emergency_stop)
            );
          } catch (e: any) {
            this.log("error", `[TELEGRAM ERROR] ${e.message}`);
          }

          if (decision.decision === "EXECUTE" || decision.decision === "REDUCE") {
            const validated = await this.validateOptionForEntry(r.underlying, r.confirmations);
            if (validated) {
              if (decision.decision === "REDUCE") {
                const originalContracts = this.config.options.contractsPerTrade;
                const reducedContracts = Math.max(1, Math.floor(originalContracts / 2));
                this.log("warn", `[SMART_BRAIN_REDUCE] ${r.underlying} | contracts ${originalContracts} -> ${reducedContracts}`);
                this.config.options.contractsPerTrade = reducedContracts;
                try {
                  await this.openTrade(r.underlying, r.confirmations, validated, { signal: decision.signal, decision: decision.decision, reason: decision.summary, confidence: decision.confidence_final, latencyMs: decision.latency_ms ?? null, reasonCodes: decision.reason_codes });
                  break;
                } finally {
                  this.config.options.contractsPerTrade = originalContracts;
                }
              } else {
                await this.openTrade(r.underlying, r.confirmations, validated, { signal: decision.signal, decision: decision.decision, reason: decision.summary, confidence: decision.confidence_final, latencyMs: decision.latency_ms ?? null, reasonCodes: decision.reason_codes });
                break;
              }
            }
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

  private async evaluateWithSmartBrain(underlying: string, confirmations: Confirmation[], passed: number): Promise<SmartBrainResponse> {
    const signal = `${underlying}:${passed}/8`;
    const requestPayload = {
      request_id: rid(),
      signalLabel: signal,
      underlying,
      confirmations: passed,
      todayTrades: this.getTodayTrades().length,
      openTrades: this.getOpenTrades().length,
      maxTrades: this.config.risk.maxTradesPerDay,
      maxOpenPositions: this.config.risk.maxOpenPositions,
      dailyPnl: this.getDailyPnl(),
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
      return {
        ok: data.ok,
        service: data.service,
        version: data.version,
        signal: data.signal || signal,
        underlying: data.underlying || underlying,
        decision: normalizedDecision as SmartBrainDecision,
        confidence_final: typeof data.confidence_final === "number" ? data.confidence_final : 0,
        confidence_score: data.confidence_score,
        fast_path: data.fast_path,
        emergency_stop: Boolean(data.emergency_stop),
        reason_codes: reasonCodes,
        strengths: Array.isArray(data.strengths) ? data.strengths : [],
        weaknesses: Array.isArray(data.weaknesses) ? data.weaknesses : [],
        summary: data.summary || "Smart Brain response received",
        evaluated_at: data.evaluated_at,
        latency_ms: typeof data.latency_ms === "number" ? data.latency_ms : latencyMs,
      };
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

    return [
      { name: "trend", label: "الاتجاه (EMA 9/21)", passed: trendUp, value: trendUp ? `صاعد ↑ (${data.ema9} > ${data.ema21})` : `هابط ↓ (${data.ema9} < ${data.ema21})` },
      { name: "rsi", label: "RSI (14)", passed: rsi > 35 && rsi < 65, value: `${rsi.toFixed(1)} [من ${data.barsCount} شمعة]` },
      { name: "macd", label: "إشارة MACD", passed: trendUp ? macdHist > 0 : macdHist < 0, value: `Hist:${macdHist > 0 ? '+' : ''}${macdHist.toFixed(3)} Line:${data.macdLine.toFixed(3)}` },
      { name: "adx", label: "قوة ADX", passed: adx > 20, value: `${adx.toFixed(1)} [من شموع حقيقية]` },
      { name: "vwap", label: "موقع VWAP", passed: aboveVwap, value: `$${S.toFixed(2)} vs VWAP:$${data.vwap.toFixed(2)}` },
      { name: "volume", label: "حجم أعلى من المتوسط", passed: volRatio > 0.8, value: `${volRatio.toFixed(2)}x (${(data.volume / 1e6).toFixed(1)}M)` },
      { name: "candle", label: "شمعة قوية بدون ذيول", passed: strongCandle, value: `body:${(bodyRatio * 100).toFixed(0)}% range:${(range / data.close * 100).toFixed(2)}%` },
      { name: "news_vix", label: "لا يوجد خبر + VIX منخفض", passed: vix < 25, value: `VIX: ${vix.toFixed(1)}` },
    ];
  }

  private checkFilters(): string | null {
    if (this.config.filters.enableTimeFilter && !isMarketOpen()) return "السوق مغلق";
    if (!market.hasRealData()) return "انتظار بيانات";

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
      if (this.config.filters.blockLast30Minutes && mins >= 15 * 60 + 30) return "آخر 30 دقيقة محظورة";
    }

    const dl = this.getDailyPnl();
    const ml = this.getStrategyCapital(this.config.activeStrategy as Strategy) * (this.config.risk.maxDailyLossPercent / 100);
    if (dl <= -ml) return `حد الخسارة اليومي: $${dl.toFixed(2)}`;
    if (this.consecutiveLosses >= this.config.risk.maxConsecutiveLosses) return `${this.consecutiveLosses} خسائر متتالية`;
    return null;
  }

  getNewsFilterStatus(): NewsFilterStatus {
    return newsFilter.getStatus();
  }

  simulateNewsEvent(name: string, minutesFromNow: number = 0) {
    return newsFilter.simulateEvent(name, minutesFromNow);
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
    this.stopTradingNow(`[LIVE_SAFE_OPTION_BLOCK] ${underlying}`);
    return null;
  }

  private async validateOptionForEntry(underlying: string, conf: Confirmation[]): Promise<OptionQuote | null> {
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

    const orderQuantity = this.getContractsForEntry(s, opt.ask);
    if (orderQuantity < 1) {
      this.log("warn", `[RISK_LIMIT] رأس المال الفعلي $${this.getStrategyCapital(s).toFixed(2)} لا يكفي لعقد واحد @ $${opt.ask.toFixed(2)} لـ ${underlying}`, {
        symbol: underlying,
        underlying,
        optionSide: ct.toUpperCase(),
        premium: opt.ask,
        bid: opt.bid,
        ask: opt.ask,
      });
      this.stopTradingNow(`[LIVE_SAFE_OPTION_BLOCK] ${underlying}`);
      return null;
    }

    if (!opt.ticker || !opt.expiry || !(opt.strike > 0)) {
      this.stopTradingNow(`OPTION_DATA_INVALID:${underlying}`);
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

  private async openTrade(underlying: string, conf: Confirmation[], opt: OptionQuote, gate?: SmartBrainGate) {
    const s = this.config.activeStrategy as Strategy;
    const trendConf = conf.find(c => c.name === "trend");
    const ct: ContractType = trendConf?.value?.includes("صاعد") ? "call" : "put";
    const signal = `${underlying}:${conf.filter(c => c.passed).length}/8`;

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

    this.log("info", `[EXECUTION_GATE] signal:${gate.signal} | decision:${gate.decision} | reason:${gate.reason}`, {
      symbol: underlying,
      underlying,
      optionSide: ct.toUpperCase(),
      decision: gate.decision,
      confidence: gate.confidence ?? null,
      latencyMs: gate.latencyMs ?? null,
      reason: gate.reason,
      reasonCodes: gate.reasonCodes ?? [],
      bid: opt.bid,
      ask: opt.ask,
      premium: opt.ask,
      contractDetails: this.formatContractDetails(opt, s),
    });

    this.enforceLiveSafeConfig();
    const liveSafeStopReason = this.getLiveSafeStopReason();
    if (liveSafeStopReason) {
      this.stopTradingNow(liveSafeStopReason);
      return;
    }
    if (!opt || !(opt.ask > 0) || !opt.ticker || !opt.expiry || !(opt.strike > 0)) {
      this.stopTradingNow(`OPTION_DATA_INVALID:${underlying}`);
      return;
    }

    const orderQuantity = this.getContractsForEntry(s, opt.ask);
    if (orderQuantity < 1) {
      this.log("warn", `[RISK_LIMIT] رأس المال الفعلي $${this.getStrategyCapital(s).toFixed(2)} لا يكفي لعقد واحد @ $${opt.ask.toFixed(2)} لـ ${underlying}`);
      return;
    }

    let fillPrice: number;
    let slippage = 0;
    let ibkrOrderId: number | undefined;

    if (market.isIBKRConnected() && this.config.mode === "live") {
      const limitPrice = Math.round((opt.ask + 0.02) * 100) / 100;
      this.log("trade", `[IBKR_ORDER] إرسال أمر شراء ${ct.toUpperCase()} ${underlying} Strike:$${opt.strike} Exp:${opt.expiry} @ Limit:$${limitPrice}`);
      const result = await ibkr.placeOrder(underlying, ct, opt.strike, opt.expiry, "BUY", orderQuantity, limitPrice);
      if (result && result.status === "Filled") {
        fillPrice = result.avgFillPrice;
        ibkrOrderId = result.orderId;
        this.log("trade", `[IBKR_FILLED] ✅ تم التنفيذ @ $${fillPrice} | OrderId: ${result.orderId}`);
      } else {
        this.log("warn", `[IBKR_REJECTED] ❌ فشل التنفيذ: ${result?.status || 'timeout'}`);
        return;
      }
    } else {
      const entrySpread = opt.ask - opt.bid;
      slippage = Math.min(Math.round(entrySpread * 0.3 * 100) / 100, 0.05);
      slippage = Math.max(slippage, 0.01);
      fillPrice = Math.round((opt.ask + slippage) * 100) / 100;
      this.log("info", `[SLIPPAGE] Spread:$${entrySpread.toFixed(2)} → Slippage:$${slippage.toFixed(2)} (${((slippage / entrySpread) * 100).toFixed(0)}% of spread)`);
    }
    const stockPrice = market.getPrice(underlying);
    const pc = conf.filter(c => c.passed).length;
    const tConfig = getTrailingConfig(fillPrice);

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
      trailingStopPrice: 0,
      trailingConfig: tConfig,
      openedAt: Date.now(), status: "open",
      dataSource: market.isIBKRConnected() ? (this.config.mode === "live" ? "ibkr-live" : "ibkr-paper") : "real-data-paper",
    };

    this.trades.push(t);
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
      `[TRADE_OPEN] 🟢 ${ct.toUpperCase()} ${underlying} @$${fillPrice.toFixed(2)} (Ask:$${opt.ask} + Slip:$${slippage.toFixed(2)}) | Strike:$${opt.strike} | Exp:${opt.expiry} | Δ${Math.abs(opt.delta).toFixed(3)} IV:${(opt.iv * 100).toFixed(0)}% | trailing config: activation +$${tConfig.activation}, distance $${tConfig.distance}`,
      {
        tradeId: t.id,
        symbol: underlying,
        underlying,
        optionSide: ct.toUpperCase(),
        confidence: gate.confidence ?? null,
        decision: gate.decision,
        latencyMs: gate.latencyMs ?? null,
        reason: gate.reason,
        bid: opt.bid,
        ask: opt.ask,
        premium: fillPrice,
        contractDetails: this.formatContractDetails(opt, s, fillPrice),
      }
    );
    this.log("trade",
      `📋 سبب الدخول [${pc}/8]: السهم:$${stockPrice?.toFixed(2) ?? 'N/A'} | Bid:$${opt.bid} Ask:$${opt.ask} Spread:${spreadPct}% | حجم:${opt.volume.toLocaleString()} OI:${opt.openInterest.toLocaleString()} | Slippage:$${slippage.toFixed(2)} | SL:-30% until trailing activates`,
      {
        tradeId: t.id,
        symbol: underlying,
        underlying,
        optionSide: ct.toUpperCase(),
        confidence: gate.confidence ?? null,
        decision: gate.decision,
        latencyMs: gate.latencyMs ?? null,
        reason: gate.reason,
        bid: opt.bid,
        ask: opt.ask,
        premium: fillPrice,
        contractDetails: this.formatContractDetails(opt, s, fillPrice),
      }
    );
    const passedList = conf.filter(c => c.passed).map(c => `${c.label}=${c.value}`).join(" | ");
    this.log("info", `📊 تأكيدات الدخول: ${passedList}`);
  }

  // ========== NEW EXIT LOGIC (Dollar-based trailing on option premium) ==========
  private async checkExits() {
    for (const t of this.getOpenTrades()) {
      const currentPremium = t.currentPremium;
      const { activation, distance } = t.trailingConfig;

      // 4. Exit check - premium hit or dropped below trailing stop
      if (t.trailingActive && currentPremium <= t.trailingStopPrice) {
        const profit = currentPremium - t.entryPremium;
        this.log("info", `[CLOSE_TRAILING] ${t.underlying} | entry: $${t.entryPremium.toFixed(2)} | exit: $${currentPremium.toFixed(2)} | profit: $${profit.toFixed(2)} | peak: $${t.peakPrice.toFixed(2)} | stop: $${t.trailingStopPrice.toFixed(2)} | reason: trailing_stop`);
        try { notifyTradeExit(t.symbol, t.expiry, t.strike, t.contractType, "trailing-stop", pnl, ((pnl / t.entryPremium) * 100), t.currentPremium); } catch {} // notify
        await this.closeTrade(t, "trailing-stop");
        continue;
      }

      // 5. BEFORE trailing activates - initial SL still protects
      if (!t.trailingActive) {
        const lossPct = (t.entryPremium - currentPremium) / t.entryPremium;
        if (lossPct >= INITIAL_STOP_LOSS_PCT) {
          this.log("info", `[CLOSE_SL] ${t.underlying} | entry: $${t.entryPremium.toFixed(2)} | exit: $${currentPremium.toFixed(2)} | loss: -${(lossPct * 100).toFixed(1)}% | reason: initial_stop_loss`);
          try { notifyStopLossHit(t.symbol, pnl); } catch {} 
        try { notifyTradeExit(t.symbol, t.expiry, t.strike, t.contractType, "stop-loss", pnl, ((pnl / t.entryPremium) * 100), t.currentPremium); } catch {} // notify
        await this.closeTrade(t, "stop-loss");
          continue;
        }
      }
    }
  }

  private async closeTrade(t: Trade, reason: Trade["closeReason"]) {
    let exitPrice: number;
    let exitSlippage = 0;
    const updated = await market.getOptionPrice(t.underlying, t.contractType, t.strike, t.expiry);
    const rawBid = updated ? updated.bid : t.currentPremium;

    if (market.isIBKRConnected() && this.config.mode === "live") {
      const limitPrice = Math.max(0.01, Math.round((rawBid - 0.02) * 100) / 100);
      this.log("trade", `[IBKR_EXIT] إرسال أمر بيع ${t.contractType.toUpperCase()} ${t.underlying} @ Limit:$${limitPrice}`);
      const result = await ibkr.placeOrder(t.underlying, t.contractType, t.strike, t.expiry, "SELL", t.quantity, limitPrice);
      if (result && result.status === "Filled") {
        exitPrice = result.avgFillPrice;
        this.log("trade", `[IBKR_EXIT_FILLED] ✅ تم البيع @ $${exitPrice} | OrderId: ${result.orderId}`);
      } else {
        this.log("warn", `[IBKR_EXIT] Limit فشل، محاولة Market Order...`);
        const mktResult = await ibkr.placeOrder(t.underlying, t.contractType, t.strike, t.expiry, "SELL", t.quantity);
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
      "stop-loss": "🔴 Initial Stop Loss - وقف خسارة أولي (-30%)",
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
  }

  async closeById(id: string, cp?: number) {
    const t = this.trades.find(x => x.id === id && x.status === "open");
    if (!t) return;
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

  // ======== PUBLIC GETTERS ========

  getStatus(): BotStatus {
    const mktStatus = getMarketStatus();
    return {
      running: this.running, mode: this.config.mode, activeStrategy: this.config.activeStrategy,
      marketOpen: mktStatus.open,
      marketTimeET: mktStatus.currentTimeET,
      nextMarketOpen: mktStatus.nextOpen || undefined,
      vix: market.getVIX(),
      spyPrice: market.getPrice("SPY"),
      qqqPrice: market.getPrice("QQQ"),
      openTrades: this.getOpenTrades().length,
      todayTrades: this.getTodayTrades().length,
      blockedReason: this.running ? this.checkFilters() ?? undefined : undefined,
      uptime: this.running ? Date.now() - this.startTime : 0,
      dataSource: this.dataState === "connected" ? (market.isIBKRConnected() ? "ibkr" : "yahoo-intraday") : this.dataState === "waiting" ? "waiting" : "unavailable",
      polygonConnected: this.dataState === "connected",
      ibkrConnected: market.isIBKRConnected(),
      ibkrAccountId: market.getIBKRAccountId() || undefined,
      dataTimestamp: market.getDataTimestamp(),
      dataFresh: this.dataState === "connected" && market.isDataFresh(),
      dataState: this.dataState,
    };
  }

  getOpenTrades(): Trade[] { return this.trades.filter(t => t.status === "open"); }
  getClosedTrades(): Trade[] { return this.trades.filter(t => t.status === "closed").sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)); }
  getLogs(limit = 50, filters?: { level?: string; symbol?: string; from?: number; to?: number }): BotLog[] {
    try {
      return loadLogs({ limit, ...filters }).map(normalizeBotLog);
    } catch {
      return this.logs
        .filter(log => !filters?.level || log.level === filters.level)
        .filter(log => !filters?.symbol || log.symbol === filters.symbol)
        .filter(log => !filters?.from || log.createdAt >= filters.from)
        .filter(log => !filters?.to || log.createdAt <= filters.to)
        .slice(0, limit);
    }
  }
  getLastErrors(limit = 20): BotLog[] {
    try {
      return loadErrorLogs(limit).map(normalizeBotLog);
    } catch {
      return this.logs.filter(log => log.level === "error" || log.level === "warn").slice(0, limit);
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
  getConfig(): BotConfig { return JSON.parse(JSON.stringify(this.config)); }

  updateConfig(p: Partial<BotConfig>) {
    if (p.mode) this.config.mode = p.mode;
    if (p.activeStrategy) this.config.activeStrategy = "milking";
    if (p.capital) Object.assign(this.config.capital, p.capital);
    if (p.risk) Object.assign(this.config.risk, p.risk);
    if (p.options) Object.assign(this.config.options, p.options);
    if (p.filters) Object.assign(this.config.filters, p.filters);
    if (p.zeroHero) Object.assign(this.config.zeroHero, p.zeroHero);
    this.log("info", "تم تحديث الإعدادات");
  }

  private getTodayTrades(): Trade[] { const s = new Date(); s.setUTCHours(0, 0, 0, 0); return this.trades.filter(t => t.openedAt >= s.getTime()); }
  private getDailyPnl(): number { return this.getTodayTrades().filter(t => t.status === "closed").reduce((s, t) => s + t.pnl, 0); }

  getDailyStats(): DailyStats {
    const td = this.getTodayTrades(), cl = td.filter(t => t.status === "closed");
    return {
      dailyPnl: Math.round(cl.reduce((s, t) => s + t.pnl, 0) * 100) / 100,
      tradesCount: td.length, wins: cl.filter(t => t.pnl > 0).length,
      losses: cl.filter(t => t.pnl <= 0).length, startCapital: this.config.capital.mainCapital
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
    for (const t of cl) { const d = new Date(t.closedAt ?? t.openedAt).toISOString().split("T")[0]; if (!bd.has(d)) bd.set(d, []); bd.get(d)!.push(t); }
    return Array.from(bd.entries()).map(([date, trades]) => {
      const w = trades.filter(t => t.pnl > 0).length;
      return { date, trades: trades.length, wins: w, losses: trades.length - w, winRate: Math.round((w / trades.length) * 100), pnl: Math.round(trades.reduce((s, t) => s + t.pnl, 0) * 100) / 100 };
    }).sort((a, b) => b.date.localeCompare(a.date));
  }
}

export const engine = new TradingEngine();


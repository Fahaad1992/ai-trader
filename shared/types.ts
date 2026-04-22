export type TradingMode = "paper" | "live";
export type TradeRuntimeMode = "options" | "futures";
export type Strategy = "milking" | "hold" | "zeroHero";
export type ContractType = "call" | "put";
export type CloseReason = "trailing-stop" | "stop-loss" | "manual" | "expiry" | "risk-limit";
export type LogLevel = "info" | "warn" | "error" | "trade";
export type BotDecision = "EXECUTE" | "REDUCE" | "WAIT" | "REJECT";
export type BotOptionSide = "CALL" | "PUT";

export interface TrailingConfig {
  activation: number;
  distance: number;
}

export interface BrokerAccountSnapshot {
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

export interface FuturesSettings {
  assetType: "MES";
  trailingStopPoints: number;
  initialStopPoints: number;
  maxContracts: number;
  dailyLossLimitPercent: number;
  balanceRefreshSeconds: number;
  dataSource: "tastytrade";
  executionBroker: "tastytrade";
}

export interface Trade {
  id: string;
  mode: TradingMode;
  strategy: Strategy;
  underlying: string;
  symbol: string;
  tradeMode?: TradeRuntimeMode;
  optionTicker?: string;
  contractType?: ContractType;
  strike?: number;
  expiry?: string;
  entryPremium: number;
  currentPremium: number;
  quantity: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  iv?: number;
  volume?: number;
  openInterest?: number;
  pnl: number;
  pnlPercent: number;
  peakPrice: number;
  trailingActive: boolean;
  trailingStopPrice: number;
  trailingConfig: TrailingConfig;
  openedAt: number;
  closedAt?: number;
  closeReason?: CloseReason;
  status: "open" | "closed";
  dataSource: "real-data-paper" | "polygon" | "ibkr-live" | "ibkr-paper";
}

export interface BotStatus {
  running: boolean;
  mode: TradingMode;
  tradeMode?: TradeRuntimeMode;
  activeStrategy: Strategy;
  marketOpen: boolean;
  marketTimeET?: string;
  nextMarketOpen?: string;
  vix: number | null;
  spyPrice?: number | null;
  qqqPrice?: number | null;
  openTrades: number;
  todayTrades: number;
  blockedReason?: string;
  uptime: number;
  dataSource: "yahoo-intraday" | "ibkr" | "waiting" | "unavailable";
  polygonConnected: boolean;
  ibkrConnected?: boolean;
  ibkrAccountId?: string;
  dataTimestamp?: number;
  dataFresh?: boolean;
  dataState?: "idle" | "waiting" | "connected" | "failed";
  brokerAccount?: BrokerAccountSnapshot | null;
}

export interface ContractDetails {
  ticker?: string;
  strike?: number;
  expiry?: string;
  contractType?: ContractType | BotOptionSide;
  delta?: number;
  iv?: number;
  volume?: number;
  openInterest?: number;
  mid?: number;
  requestedDte?: number;
  actualDte?: number | null;
  strikeDistancePct?: number | null;
}

export interface BotLog {
  id: string;
  level: LogLevel;
  tradeMode?: TradeRuntimeMode;
  message: string;
  details?: Record<string, unknown>;
  createdAt: number;
  symbol?: string;
  optionSide?: BotOptionSide;
  confidence?: number | null;
  rawScore?: number | null;
  decision?: BotDecision | null;
  latencyMs?: number | null;
  reason?: string | null;
  bid?: number | null;
  ask?: number | null;
  premium?: number | null;
  contractDetails?: ContractDetails | null;
}

export interface ReasonCodeCount {
  code: string;
  count: number;
}

export interface DecisionStatsWindow {
  windowHours: number;
  signalsTotal: number;
  execute: number;
  reduce: number;
  wait: number;
  reject: number;
  optionRejected: number;
  premiumZeroCount: number;
  avgConfidenceAll: number | null;
  avgConfidenceExecuted: number | null;
  topReasonCodes: ReasonCodeCount[];
}

export interface SmartBrainStatsReport {
  last24h: DecisionStatsWindow;
  last48h: DecisionStatsWindow;
}

export interface DailyStats {
  dailyPnl: number;
  tradesCount: number;
  wins: number;
  losses: number;
  startCapital: number;
}

export interface OverallStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  totalPnl: number;
  grossProfit: number;
  grossLoss: number;
  avgWin: number;
  avgLoss: number;
  currentCapital: number;
}

export interface DailyHistory {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnl: number;
}

export interface BotConfig {
  mode: TradingMode;
  tradeMode?: TradeRuntimeMode;
  activeStrategy: Strategy;
  capital: {
    mainCapital: number;
    paperBalance: number;
    carryDailyPnlIntoCapital: boolean;
  };
  risk: {
    maxTradesPerDay: number;
    maxOpenPositions: number;
    maxDailyLossPercent: number;
    maxConsecutiveLosses: number;
    cooldownMinutes: number;
    stopLossPercent?: number;
    takeProfitPercent?: number;
    trailingStartPercent?: number;
  };
  options: {
    deltaMin: number;
    deltaMax: number;
    minPremium: number;
    maxPremium: number;
    maxContracts: number;
    contractsPerTrade: number;
    weeklyOnly: boolean;
    allow0DTE: boolean;
    allowCheapOptions: boolean;
  };
  futures: FuturesSettings;
  filters: {
    minConfirmations: number;
    enableNewsFilter: boolean;
    enableVixFilter: boolean;
    enableVolatilityFilter: boolean;
    enableTimeFilter: boolean;
    blockFirst10Minutes: boolean;
    blockLast30Minutes: boolean;
    requireBreakout: boolean;
  };
  zeroHero: {
    enabled: boolean;
    separateCapital: number;
    maxTrades: number;
    deltaMin: number;
    deltaMax: number;
    minPremium: number;
    maxPremium: number;
    onlyLateSession: boolean;
    requireBreakout: boolean;
    allow0DTE: boolean;
  };
}

export interface Confirmation {
  name: string;
  label: string;
  passed: boolean;
  value?: string;
}

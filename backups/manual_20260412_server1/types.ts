export type TradingMode = "paper" | "live";
export type Strategy = "milking" | "hold" | "zeroHero";
export type ContractType = "call" | "put";
export type CloseReason = "trailing-stop" | "stop-loss" | "manual" | "expiry" | "risk-limit";
export type LogLevel = "info" | "warn" | "error" | "trade";

export interface TrailingConfig {
  activation: number;  // dollar amount above entry to activate trailing
  distance: number;    // dollar distance from peak to set stop
}

export interface Trade {
  id: string;
  mode: TradingMode;
  strategy: Strategy;
  underlying: string;
  symbol: string;
  optionTicker?: string;
  contractType: ContractType;
  strike: number;
  expiry: string;
  entryPremium: number;
  currentPremium: number;
  quantity: number;
  delta: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  iv?: number;
  volume?: number;
  openInterest?: number;
  pnl: number;
  pnlPercent: number;
  // New trailing stop fields
  peakPrice: number;              // highest premium since entry
  trailingActive: boolean;        // is trailing protection active?
  trailingStopPrice: number;      // current sell trigger price ($)
  trailingConfig: TrailingConfig;  // set at entry based on premium
  openedAt: number;
  closedAt?: number;
  closeReason?: CloseReason;
  status: "open" | "closed";
  dataSource: "real-data-paper" | "polygon" | "ibkr-live" | "ibkr-paper";
}

export interface BotStatus {
  running: boolean;
  mode: TradingMode;
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
}

export interface BotLog {
  id: string;
  level: LogLevel;
  message: string;
  details?: Record<string, unknown>;
  createdAt: number;
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

// server/trading/database.ts

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'trades.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  mode TEXT,
  strategy TEXT,
  underlying TEXT,
  symbol TEXT,
  contract_type TEXT,
  strike REAL,
  expiry TEXT,
  entry_premium REAL,
  exit_premium REAL,
  quantity INTEGER,
  delta REAL,
  pnl REAL,
  pnl_percent REAL,
  status TEXT,
  open_reason TEXT,
  close_reason TEXT,
  opened_at INTEGER,
  closed_at INTEGER,
  data_source TEXT
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER,
  level TEXT,
  message TEXT,
  data TEXT
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT PRIMARY KEY,
  trades_count INTEGER,
  wins INTEGER,
  losses INTEGER,
  pnl REAL,
  capital REAL
);
`);

db.exec(`
CREATE INDEX IF NOT EXISTS idx_trades_opened_at ON trades(opened_at);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
`);

// ===== Prepared Statements =====

const insertTrade = db.prepare(`
  INSERT INTO trades (id, mode, strategy, underlying, symbol, contract_type, strike, expiry,
    entry_premium, exit_premium, quantity, delta, pnl, pnl_percent, status,
    open_reason, close_reason, opened_at, closed_at, data_source)
  VALUES (@id, @mode, @strategy, @underlying, @symbol, @contract_type, @strike, @expiry,
    @entry_premium, @exit_premium, @quantity, @delta, @pnl, @pnl_percent, @status,
    @open_reason, @close_reason, @opened_at, @closed_at, @data_source)
`);

const updateTradeClose = db.prepare(`
  UPDATE trades SET
    exit_premium = @exit_premium,
    pnl = @pnl,
    pnl_percent = @pnl_percent,
    status = @status,
    close_reason = @close_reason,
    closed_at = @closed_at
  WHERE id = @id
`);

const getOpenTrades = db.prepare(`
  SELECT * FROM trades WHERE status = 'open' ORDER BY opened_at DESC
`);

const getAllTrades = db.prepare(`
  SELECT * FROM trades ORDER BY opened_at DESC
`);

const getTradesByStatus = db.prepare(`
  SELECT * FROM trades WHERE status = ? ORDER BY opened_at DESC
`);

const getTradeById = db.prepare(`
  SELECT * FROM trades WHERE id = ?
`);

const insertLog = db.prepare(`
  INSERT INTO logs (timestamp, level, message, data)
  VALUES (@timestamp, @level, @message, @data)
`);

const getRecentLogs = db.prepare(`
  SELECT * FROM logs ORDER BY id DESC LIMIT ?
`);

const getLogsByLevel = db.prepare(`
  SELECT * FROM logs WHERE level = ? ORDER BY id DESC LIMIT ?
`);

const upsertDailyStats = db.prepare(`
  INSERT INTO daily_stats (date, trades_count, wins, losses, pnl, capital)
  VALUES (@date, @trades_count, @wins, @losses, @pnl, @capital)
  ON CONFLICT(date) DO UPDATE SET
    trades_count = @trades_count,
    wins = @wins,
    losses = @losses,
    pnl = @pnl,
    capital = @capital
`);

const getDailyStats = db.prepare(`
  SELECT * FROM daily_stats ORDER BY date DESC LIMIT ?
`);

// ===== Export Helper Functions =====

export function saveTrade(trade: {
  id: string;
  mode: string;
  strategy: string;
  underlying: string;
  symbol: string;
  contract_type: string;
  strike: number;
  expiry: string;
  entry_premium: number;
  exit_premium: number | null;
  quantity: number;
  delta: number;
  pnl: number | null;
  pnl_percent: number | null;
  status: string;
  open_reason: string;
  close_reason: string | null;
  opened_at: number;
  closed_at: number | null;
  data_source: string;
}) {
  return insertTrade.run({
    ...trade,
    exit_premium: trade.exit_premium ?? null,
    pnl: trade.pnl ?? null,
    pnl_percent: trade.pnl_percent ?? null,
    close_reason: trade.close_reason ?? null,
    closed_at: trade.closed_at ?? null,
  });
}

export function closeTrade(update: {
  id: string;
  exit_premium: number;
  pnl: number;
  pnl_percent: number;
  status: string;
  close_reason: string;
  closed_at: number;
}) {
  return updateTradeClose.run(update);
}

export function loadOpenTrades() {
  return getOpenTrades.all();
}

export function loadAllTrades() {
  return getAllTrades.all();
}

export function loadTradesByStatus(status: string) {
  return getTradesByStatus.all(status);
}

export function loadTradeById(id: string) {
  return getTradeById.get(id);
}

export function saveLog(entry: {
  level: string;
  message: string;
  data?: string;
}) {
  return insertLog.run({
    timestamp: Date.now(),
    level: entry.level,
    message: entry.message,
    data: entry.data ?? null,
  });
}

export function loadRecentLogs(limit: number = 100) {
  return getRecentLogs.all(limit);
}

export function loadLogsByLevel(level: string, limit: number = 100) {
  return getLogsByLevel.all(level, limit);
}

export function saveDailyStats(stats: {
  date: string;
  trades_count: number;
  wins: number;
  losses: number;
  pnl: number;
  capital: number;
}) {
  return upsertDailyStats.run(stats);
}

export function loadDailyStats(limit: number = 30) {
  return getDailyStats.all(limit);
}

export function getTradesCount() {
  const row = db.prepare('SELECT COUNT(*) as count FROM trades').get() as { count: number };
  return row.count;
}

export function getTradesCountByStatus(status: string) {
  const row = db.prepare('SELECT COUNT(*) as count FROM trades WHERE status = ?').get(status) as { count: number };
  return row.count;
}

export default db;

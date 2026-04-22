import Database from 'better-sqlite3';
const db = new Database('/opt/ai-trader/data/trades.db', { readonly: true });
const rows = db.prepare(`
  SELECT id, datetime(timestamp/1000, 'unixepoch') AS ts_utc, level, message
  FROM logs
  WHERE message LIKE '%[IBKR]%' OR message LIKE '%[IBKR Hist]%' OR message LIKE '%[DATA_BLOCK]%' OR message LIKE '%[Market] SPY:%' OR message LIKE '%[Market] QQQ:%'
  ORDER BY id DESC
  LIMIT 120
`).all();
console.log(JSON.stringify(rows, null, 2));

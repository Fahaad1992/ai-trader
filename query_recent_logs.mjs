import Database from 'better-sqlite3';

const db = new Database('/opt/ai-trader/data/trades.db', { readonly: true });
const patterns = [
  '%DATA_DECISION%',
  '%IBKR_FILLED%',
  '%IBKR_ORDER%',
  '%IBKR_PRE_SUBMIT%',
  '%BROKER_PROTECTION_MISSING%',
  '%EXECUTION_BLOCKED%',
  '%OPTION_REJECTED%',
  '%Yahoo fallback disabled%'
];
const rows = db.prepare(`
  SELECT id, datetime(timestamp/1000, 'unixepoch') AS ts_utc, level, message, data
  FROM logs
  WHERE ${patterns.map((_, i) => `(message LIKE ?)` ).join(' OR ')}
  ORDER BY id DESC
  LIMIT 80
`).all(...patterns);
console.log(JSON.stringify(rows, null, 2));

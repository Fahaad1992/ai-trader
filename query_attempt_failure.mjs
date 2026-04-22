import Database from 'better-sqlite3';

const db = new Database('/opt/ai-trader/data/trades.db', { readonly: true });
const row = db.prepare(`
  SELECT id, datetime(timestamp/1000, 'unixepoch') AS ts_utc, level, message, data
  FROM logs
  WHERE message LIKE '%محاولة 1/3 فشلت%' OR message LIKE '%Attempt 1/3 failed%'
  ORDER BY id DESC
  LIMIT 1
`).get();

if (!row) {
  console.log(JSON.stringify({ found: false }, null, 2));
  process.exit(0);
}

const context = db.prepare(`
  SELECT id, datetime(timestamp/1000, 'unixepoch') AS ts_utc, level, message, data
  FROM logs
  WHERE id <= ?
  ORDER BY id DESC
  LIMIT 12
`).all(row.id);

console.log(JSON.stringify({ found: true, row, context }, null, 2));

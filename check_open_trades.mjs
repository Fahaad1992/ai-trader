import Database from 'better-sqlite3';

const db = new Database('/opt/ai-trader/data/trades.db', { readonly: true });
const rows = db.prepare("SELECT id, underlying, symbol, contract_type, strike, expiry, quantity, entry_premium, status, opened_at FROM trades WHERE status = 'open' ORDER BY opened_at DESC").all();
console.log(JSON.stringify({ open_count: rows.length, rows }, null, 2));

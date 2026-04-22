import sqlite3
import json
import os
import sys
from datetime import datetime

DB_PATH = sys.argv[1] if len(sys.argv) > 1 else "/opt/ai-trader/data/trades.db"
if not os.path.exists(DB_PATH):
    raise SystemExit(f"DB not found: {DB_PATH}")

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row
cur = conn.cursor()


def scalar(q, params=()):
    row = cur.execute(q, params).fetchone()
    return None if row is None else list(row)[0]

before = {
    "open_trades": scalar("select count(*) from trades where status='open'"),
    "closed_trades": scalar("select count(*) from trades where status='closed'"),
    "all_trades": scalar("select count(*) from trades"),
    "daily_stats_rows": scalar("select count(*) from daily_stats"),
    "latest_open_ids": [r[0] for r in cur.execute("select id from trades where status='open' order by opened_at desc limit 20").fetchall()],
}

cur.execute("delete from trades")
cur.execute("delete from daily_stats")
conn.commit()

try:
    cur.execute("vacuum")
except Exception:
    pass

after = {
    "open_trades": scalar("select count(*) from trades where status='open'"),
    "closed_trades": scalar("select count(*) from trades where status='closed'"),
    "all_trades": scalar("select count(*) from trades"),
    "daily_stats_rows": scalar("select count(*) from daily_stats"),
}

print(json.dumps({
    "db_path": DB_PATH,
    "cleaned_at": datetime.utcnow().isoformat() + "Z",
    "before": before,
    "after": after,
}, ensure_ascii=False))

conn.close()

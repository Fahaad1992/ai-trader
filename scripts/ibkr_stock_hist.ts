import "dotenv/config";
process.env.IBKR_CLIENT_ID = "4";
const { ibkr } = await import("../server/trading/ibkr-client.ts");

const result: any = {
  env: { host: process.env.IBKR_HOST, port: process.env.IBKR_PORT, clientId: process.env.IBKR_CLIENT_ID },
  source: "IBKR"
};

try {
  result.connected = await ibkr.connect();
  if (result.connected) {
    const bars = await ibkr.getHistoricalBars("AAPL", "5 mins", "1 D", "TRADES");
    result.bars_count = bars.length;
    result.last_bar = bars.length ? bars[bars.length - 1] : null;
  }
} catch (e: any) {
  result.error = String(e?.message || e);
} finally {
  try { ibkr.disconnect(); } catch {}
}

console.log(JSON.stringify(result));

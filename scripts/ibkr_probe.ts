import "dotenv/config";
process.env.IBKR_CLIENT_ID = "2";
const { ibkr } = await import("../server/trading/ibkr-client.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dashDate = (v: string) => /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v;

const result: any = {
  env: { host: process.env.IBKR_HOST, port: process.env.IBKR_PORT, clientId: process.env.IBKR_CLIENT_ID },
  source_guard: "ibkr_only_test"
};

result.connected = await ibkr.connect();
if (!result.connected) {
  console.log(JSON.stringify(result));
  process.exit(0);
}

await ibkr.subscribeStock("AAPL");
await sleep(10000);
result.stock = ibkr.getStockPrice("AAPL");

const chainRaw: any[] = await ibkr.getOptionChain("AAPL", "call", 0, 0, new Date().toISOString().slice(0, 10));
result.chain_group_count = chainRaw.length;
const candidate = chainRaw.find((x: any) => Array.isArray(x?.expirations) && x.expirations.length && Array.isArray(x?.strikes) && x.strikes.length);
result.chain_sample = candidate ? {
  exchange: candidate.exchange,
  tradingClass: candidate.tradingClass,
  expirations: candidate.expirations.slice(0, 5),
  strikes: candidate.strikes.slice(0, 10)
} : null;

let expiry: string | null = null;
let strike: number | null = null;
if (candidate) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const expirations = candidate.expirations.filter((e: string) => e >= today).sort();
  const price = result.stock?.last || result.stock?.close || 0;
  const strikes = candidate.strikes
    .filter((s: number) => typeof s === "number" && s > 0)
    .sort((a: number, b: number) => Math.abs(a - price) - Math.abs(b - price));
  expiry = expirations[0] || candidate.expirations[0] || null;
  strike = strikes[0] || candidate.strikes[0] || null;
}

result.selected = { expiry, strike, expiry_dash: expiry ? dashDate(expiry) : null };
if (expiry && strike) {
  result.option_snapshot = await ibkr.getOptionSnapshot("AAPL", "call", Number(strike), dashDate(expiry));
}

console.log(JSON.stringify(result));
ibkr.disconnect();

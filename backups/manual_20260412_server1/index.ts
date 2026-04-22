import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { engine } from "./trading/engine.js";
import { getMarketStatus, isMarketOpen, market } from "./trading/market-data.js";
import { ibkr } from "./trading/ibkr-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

// API routes
app.get("/api/bot/status", (_req, res) => res.json(engine.getStatus()));
app.post("/api/bot/start", async (_req, res) => { await engine.start(); res.json({ ok: true }); });
app.post("/api/bot/stop", (_req, res) => { engine.stop(); res.json({ ok: true }); });
app.get("/api/bot/logs", (req, res) => res.json(engine.getLogs(Number(req.query.limit) || 50)));

app.get("/api/trades/open", (_req, res) => res.json(engine.getOpenTrades()));
app.get("/api/trades/closed", (_req, res) => res.json(engine.getClosedTrades()));
app.post("/api/trades/close", async (req, res) => { await engine.closeById(req.body.tradeId, req.body.currentPremium); res.json({ ok: true }); });

app.get("/api/stats/daily", (_req, res) => res.json(engine.getDailyStats()));
app.get("/api/stats/overall", (_req, res) => res.json(engine.getOverallStats()));
app.get("/api/stats/history", (_req, res) => res.json(engine.getHistory()));

app.get("/api/config", (_req, res) => res.json(engine.getConfig()));
app.put("/api/config", (req, res) => { engine.updateConfig(req.body); res.json({ ok: true }); });

// Market status endpoint
app.get("/api/market/status", (_req, res) => {
  const status = getMarketStatus();
  res.json({
    ...status,
    polygonConnected: market.isConfigured() && market.hasRealData(),
    ibkrConnected: market.isIBKRConnected(),
    ibkrAccountId: market.getIBKRAccountId(),
    ibkrStatus: market.getIBKRStatus(),
    dataFresh: market.isDataFresh(),
    stocks: market.getAllStockData(),
  });
});

// IBKR specific endpoints
app.get("/api/ibkr/status", (_req, res) => {
  res.json({
    connected: ibkr.isConnected(),
    accountId: ibkr.getAccountId(),
    status: ibkr.getStatus(),
  });
});

app.post("/api/ibkr/connect", async (_req, res) => {
  const connected = await market.connectIBKR();
  res.json({ connected, accountId: market.getIBKRAccountId() });
});

app.get("/api/ibkr/spx", async (_req, res) => {
  const price = await ibkr.getSPXPrice();
  res.json({ price, connected: ibkr.isConnected() });
});

// In production, serve static files
const distPath = path.join(process.cwd(), "dist", "public");
app.use(express.static(distPath));
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

const PORT = parseInt(process.env.PORT || "3000");
app.listen(PORT, "0.0.0.0", () => console.log(`AI Trader running on port ${PORT}`));

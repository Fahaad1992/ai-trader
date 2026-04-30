import "dotenv/config";
import express, { type Request } from "express";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { engine } from "./trading/engine.js";
import { getMarketStatus, market } from "./trading/market-data.js";
import { ibkr } from "./trading/ibkr-client.js";
import { createTradingViewWebhookEvent, finalizeTradingViewWebhookEvent, loadTradingViewWebhookEvent, saveLog } from "./trading/database.js";
import { isFuturesMode } from "./trading/trade-mode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());

const TV_WEBHOOK_SECRET = process.env.TV_WEBHOOK_SECRET || "";
const TV_ALLOWED_SYMBOL = "MES";
const TV_ALLOWED_ACTIONS = new Set(["BUY", "SELL"]);
const TV_WEBHOOK_RATE_LIMIT_WINDOW_MS = 60_000;
const TV_WEBHOOK_RATE_LIMIT_MAX_REQUESTS = 20;
const TV_WEBHOOK_BRAIN_TIMEOUT_MS = 2500;
const TV_WEBHOOK_BRAIN_URL = process.env.SMART_BRAIN_URL || "http://165.232.79.103:4000/api/evaluate-signal";
const tvWebhookRateLimits = new Map<string, number[]>();

function secureSecretEquals(a: string, b: string) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function consumeWebhookRateLimit(secret: string) {
  const now = Date.now();
  const windowStart = now - TV_WEBHOOK_RATE_LIMIT_WINDOW_MS;
  const current = (tvWebhookRateLimits.get(secret) || []).filter((ts) => ts >= windowStart);
  if (current.length >= TV_WEBHOOK_RATE_LIMIT_MAX_REQUESTS) {
    tvWebhookRateLimits.set(secret, current);
    return false;
  }
  current.push(now);
  tvWebhookRateLimits.set(secret, current);
  return true;
}

function asTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toSafeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "SERIALIZE_FAILED" });
  }
}

function getValidationError(body: Record<string, unknown>) {
  const secret = asTrimmedString(body.secret);
  const symbol = asTrimmedString(body.symbol).toUpperCase();
  const action = asTrimmedString(body.action).toUpperCase();
  const strategyId = asTrimmedString(body.strategy_id);
  const alertId = asTrimmedString(body.alert_id);
  const timestamp = asTrimmedString(body.timestamp);
  const parsedTimestamp = Date.parse(timestamp);
  const price = typeof body.price === "number" ? body.price : Number(body.price);

  if (!secret) return "MISSING_SECRET";
  if (!symbol) return "MISSING_SYMBOL";
  if (!action) return "MISSING_ACTION";
  if (!Number.isFinite(price) || price <= 0) return "INVALID_PRICE";
  if (!timestamp || Number.isNaN(parsedTimestamp)) return "INVALID_TIMESTAMP";
  if (Math.abs(Date.now() - parsedTimestamp) > 120000) return "TIMESTAMP_OUT_OF_RANGE";
  if (!strategyId) return "MISSING_STRATEGY_ID";
  if (!alertId) return "MISSING_ALERT_ID";
  if (symbol !== TV_ALLOWED_SYMBOL) return "UNSUPPORTED_SYMBOL";
  if (!TV_ALLOWED_ACTIONS.has(action)) return "UNSUPPORTED_ACTION";

  return null;
}

type TVBrainDecision = "EXECUTE" | "REDUCE" | "WAIT" | "REJECT";
type TVExecutionDecision = "REJECT" | "NO_ORDER" | "EXECUTE_READY_DRY_RUN";
type TVGuardFailure = "MARKET_CLOSED" | "IBKR_UNAVAILABLE" | "DATA_STALE" | "INVALID_ACCOUNT_STATE" | "NO_OPEN_POSITION" | "UNSUPPORTED_SYMBOL";

type TVDryRunTestOverrides = {
  enabled: boolean;
  brainDecision: TVBrainDecision | null;
  guardFailure: TVGuardFailure | null;
  forceAllGuardsPass: boolean;
};

function normalizeBrainDecision(raw: string): TVBrainDecision {
  return ["EXECUTE", "REDUCE", "WAIT", "REJECT"].includes(raw)
    ? raw as TVBrainDecision
    : "REJECT";
}

function isLocalDryRunRequest(req: Request) {
  const ip = `${req.ip || req.socket.remoteAddress || ""}`;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function getDryRunTestOverrides(req: Request): TVDryRunTestOverrides {
  const enabled = req.header("x-tv-dry-run-test") === "1" && isLocalDryRunRequest(req);
  if (!enabled) {
    return { enabled: false, brainDecision: null, guardFailure: null, forceAllGuardsPass: false };
  }

  const rawDecision = asTrimmedString(req.header("x-tv-test-brain-decision")).toUpperCase();
  const rawGuardFailure = asTrimmedString(req.header("x-tv-test-guard-failure")).toUpperCase();
  const guardFailure = (["MARKET_CLOSED", "IBKR_UNAVAILABLE", "DATA_STALE", "INVALID_ACCOUNT_STATE", "NO_OPEN_POSITION", "UNSUPPORTED_SYMBOL"].includes(rawGuardFailure)
    ? rawGuardFailure
    : null) as TVGuardFailure | null;

  return {
    enabled: true,
    brainDecision: rawDecision ? normalizeBrainDecision(rawDecision) : null,
    guardFailure,
    forceAllGuardsPass: req.header("x-tv-test-force-all-guards-pass") === "1",
  };
}

function hasValidAccountState(summary: any) {
  if (!summary || typeof summary !== "object") return false;
  const netLiquidation = Number(summary.netLiquidation ?? 0);
  const totalCashValue = Number(summary.totalCashValue ?? 0);
  const availableFunds = Number(summary.availableFunds ?? 0);
  const buyingPower = Number(summary.buyingPower ?? 0);
  return [netLiquidation, totalCashValue, availableFunds, buyingPower].every((value) => Number.isFinite(value) && value > 0);
}

function getOpenMesTradeCount() {
  return engine.getOpenTrades().filter((trade: any) => {
    const underlying = asTrimmedString(trade?.underlying).toUpperCase();
    const symbol = asTrimmedString(trade?.symbol).toUpperCase();
    return underlying === TV_ALLOWED_SYMBOL || symbol.includes(TV_ALLOWED_SYMBOL);
  }).length;
}

function getExecutionGuardFailure(symbol: string, overrides: TVDryRunTestOverrides): TVGuardFailure | null {
  if (symbol !== TV_ALLOWED_SYMBOL) return "UNSUPPORTED_SYMBOL";
  if (overrides.forceAllGuardsPass) return null;
  if (overrides.guardFailure) return overrides.guardFailure;

  const marketStatus = getMarketStatus();
  if (!marketStatus.open) return "MARKET_CLOSED";

  const botStatus = engine.getStatus();
  if (!botStatus.ibkrConnected) return "IBKR_UNAVAILABLE";
  if (!botStatus.dataFresh) return "DATA_STALE";

  const accountSummary = ibkr.getStatus().lastAccountSummary || botStatus.brokerAccount;
  if (!hasValidAccountState(accountSummary)) return "INVALID_ACCOUNT_STATE";

  return null;
}

function evaluateExecutionBridge(input: {
  symbol: string;
  brainDecision: TVBrainDecision;
  brainReason: string;
  overrides: TVDryRunTestOverrides;
}) {
  if (input.brainDecision === "WAIT") {
    return {
      status: "brain_wait",
      executionDecision: "NO_ORDER" as TVExecutionDecision,
      finalResult: "no_order_wait",
      responseReason: input.brainReason,
      guardFailure: null as TVGuardFailure | null,
      lastError: null as string | null,
    };
  }

  if (input.brainDecision === "REJECT") {
    return {
      status: "brain_reject",
      executionDecision: "REJECT" as TVExecutionDecision,
      finalResult: "no_order_reject",
      responseReason: input.brainReason,
      guardFailure: null as TVGuardFailure | null,
      lastError: input.brainReason,
    };
  }

  if (input.brainDecision === "REDUCE") {
    const openMesTradeCount = input.overrides.forceAllGuardsPass ? 1 : getOpenMesTradeCount();
    if (openMesTradeCount < 1) {
      return {
        status: "reduce_no_order",
        executionDecision: "NO_ORDER" as TVExecutionDecision,
        finalResult: "no_order_reduce_no_open_position",
        responseReason: "NO_OPEN_POSITION_TO_REDUCE",
        guardFailure: "NO_OPEN_POSITION" as TVGuardFailure,
        lastError: "NO_OPEN_POSITION_TO_REDUCE",
      };
    }

    return {
      status: "reduce_ready_dry_run",
      executionDecision: "EXECUTE_READY_DRY_RUN" as TVExecutionDecision,
      finalResult: "reduce_ready_dry_run",
      responseReason: "REDUCE_READY_DRY_RUN",
      guardFailure: null as TVGuardFailure | null,
      lastError: null as string | null,
    };
  }

  const guardFailure = getExecutionGuardFailure(input.symbol, input.overrides);
  if (guardFailure) {
    return {
      status: "exec_guard_reject",
      executionDecision: "REJECT" as TVExecutionDecision,
      finalResult: `no_order_guard_reject:${guardFailure}`,
      responseReason: guardFailure,
      guardFailure,
      lastError: guardFailure,
    };
  }

  return {
    status: "exec_ready_dry_run",
    executionDecision: "EXECUTE_READY_DRY_RUN" as TVExecutionDecision,
    finalResult: "execute_ready_dry_run",
    responseReason: "ALL_GUARDS_PASSED_DRY_RUN",
    guardFailure: null as TVGuardFailure | null,
    lastError: null as string | null,
  };
}

// API routes
app.get("/api/bot/status", (_req, res) => res.json(engine.getStatus()));
app.post("/api/bot/start", async (_req, res) => { await engine.start(); res.json({ ok: true }); });
app.post("/api/bot/stop", (_req, res) => { engine.stop(); res.json({ ok: true }); });
app.get("/api/bot/logs", (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const level = typeof req.query.level === "string" ? req.query.level : undefined;
  const symbol = typeof req.query.symbol === "string" ? req.query.symbol : undefined;
  const from = typeof req.query.from === "string" ? Number(req.query.from) : undefined;
  const to = typeof req.query.to === "string" ? Number(req.query.to) : undefined;
  res.json(engine.getLogs(limit, { level, symbol, from, to }));
});
app.get("/api/bot/last-errors", (req, res) => res.json(engine.getLastErrors(Number(req.query.limit) || 20)));
app.get("/api/trades/open", (_req, res) => res.json(engine.getOpenTrades()));
app.get("/api/trades/closed", (_req, res) => res.json(engine.getClosedTrades()));
app.post("/api/trades/close", async (req, res) => { await engine.closeById(req.body.tradeId, req.body.currentPremium); res.json({ ok: true }); });
app.get("/api/stats/daily", (_req, res) => res.json(engine.getDailyStats()));
app.get("/api/stats/overall", (_req, res) => res.json(engine.getOverallStats()));
app.get("/api/stats/history", (_req, res) => res.json(engine.getHistory()));
app.get("/api/stats/smart-brain", (_req, res) => res.json(engine.getSmartBrainStats()));
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
app.get("/api/ibkr/spy-chain", async (_req, res) => {
  if (isFuturesMode()) {
    res.status(404).json({ disabled: true, reason: "TRADE_MODE=futures" });
    return;
  }
  const chain = await ibkr.getOptionChain("SPY", "call", 0, 0, "");
  res.json({
    connected: ibkr.isConnected(),
    count: chain.length,
    sample: chain.slice(0, 3).map((row) => ({ exchange: row.exchange, tradingClass: row.tradingClass, expirations: row.expirations?.length || 0, strikes: row.strikes?.length || 0 })),
  });
});

app.post("/api/webhook/tradingview", async (req, res) => {
  const body = (req.body && typeof req.body === "object") ? req.body as Record<string, unknown> : {};
  const payloadJson = toSafeJson(body);
  const providedSecret = asTrimmedString(body.secret);

  if (!TV_WEBHOOK_SECRET) {
    saveLog({ level: "error", message: "[TV_WEBHOOK_REJECT] WEBHOOK_SECRET_NOT_CONFIGURED", data: payloadJson });
    res.status(500).json({ ok: false, error: "WEBHOOK_SECRET_NOT_CONFIGURED", orderPlaced: false });
    return;
  }

  if (!providedSecret || !secureSecretEquals(providedSecret, TV_WEBHOOK_SECRET)) {
    saveLog({ level: "warn", message: "[TV_WEBHOOK_REJECT] INVALID_SECRET", data: payloadJson });
    res.status(401).json({ ok: false, error: "INVALID_SECRET", orderPlaced: false });
    return;
  }

  if (!consumeWebhookRateLimit(providedSecret)) {
    saveLog({ level: "warn", message: "[TV_WEBHOOK_REJECT] RATE_LIMIT_EXCEEDED", data: payloadJson });
    res.status(429).json({ ok: false, error: "RATE_LIMIT_EXCEEDED", orderPlaced: false });
    return;
  }

  const validationError = getValidationError(body);
  if (validationError) {
    saveLog({ level: "warn", message: `[TV_WEBHOOK_REJECT] ${validationError}`, data: payloadJson });
    res.status(400).json({ ok: false, error: validationError, orderPlaced: false });
    return;
  }

  const symbol = asTrimmedString(body.symbol).toUpperCase();
  const action = asTrimmedString(body.action).toUpperCase();
  const strategyId = asTrimmedString(body.strategy_id);
  const alertId = asTrimmedString(body.alert_id);
  const alertTimestamp = new Date(asTrimmedString(body.timestamp)).toISOString();
  const alertPrice = typeof body.price === "number" ? body.price : Number(body.price);
  const receivedAt = Date.now();

  const inserted = createTradingViewWebhookEvent({
    alert_id: alertId,
    received_at: receivedAt,
    processed_at: null,
    strategy_id: strategyId,
    symbol,
    action,
    alert_price: alertPrice,
    alert_timestamp: alertTimestamp,
    payload_json: payloadJson,
    status: "received",
    brain_decision: null,
    brain_reason: null,
    brain_response_json: null,
    final_result: "pending_no_order",
    last_error: null,
  });

  if (!inserted.changes) {
    const existing = loadTradingViewWebhookEvent(alertId) as Record<string, unknown> | undefined;
    saveLog({ level: "info", message: `[TV_WEBHOOK_DUPLICATE] ${alertId}`, data: payloadJson });
    res.status(200).json({
      ok: true,
      alreadyProcessed: true,
      alertId,
      status: existing?.status ?? "duplicate",
      finalResult: existing?.final_result ?? "no_order",
      orderPlaced: false,
    });
    return;
  }

  saveLog({ level: "info", message: `[TV_WEBHOOK_RECEIVED] ${alertId} ${symbol} ${action}`, data: payloadJson });

  const testOverrides = getDryRunTestOverrides(req);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TV_WEBHOOK_BRAIN_TIMEOUT_MS);

  try {
    const brainPayload = {
      source: "tradingview",
      symbol,
      action,
      alert_price: alertPrice,
      alert_timestamp: alertTimestamp,
      strategy_id: strategyId,
      alert_id: alertId,
    };

    let brainData: Record<string, unknown> = {};
    if (testOverrides.enabled && testOverrides.brainDecision) {
      brainData = {
        decision: testOverrides.brainDecision,
        reason: "LOCAL_DRY_RUN_TEST_OVERRIDE",
        testMode: true,
      };
    } else {
      const response = await fetch(TV_WEBHOOK_BRAIN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(brainPayload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const reason = `SMART_BRAIN_HTTP_${response.status}`;
        finalizeTradingViewWebhookEvent({
          alert_id: alertId,
          processed_at: Date.now(),
          status: "brain_reject",
          brain_decision: "REJECT",
          brain_reason: reason,
          brain_response_json: null,
          final_result: "no_order",
          last_error: reason,
        });
        saveLog({ level: "warn", message: `[TV_WEBHOOK_REJECT] ${alertId} ${reason}`, data: JSON.stringify(brainPayload) });
        res.status(200).json({ ok: true, alertId, brainDecision: "REJECT", executionDecision: "REJECT", reason, finalResult: "no_order", orderPlaced: false, dryRun: true });
        return;
      }

      brainData = await response.json().catch(() => ({})) as Record<string, unknown>;
    }

    const rawDecision = asTrimmedString((brainData as Record<string, unknown>).decision).toUpperCase();
    const normalizedDecision = normalizeBrainDecision(rawDecision);
    const reason = asTrimmedString((brainData as Record<string, unknown>).reason)
      || asTrimmedString((brainData as Record<string, unknown>).summary)
      || "SMART_BRAIN_NO_REASON";

    const bridgeResult = evaluateExecutionBridge({
      symbol,
      brainDecision: normalizedDecision,
      brainReason: reason,
      overrides: testOverrides,
    });

    finalizeTradingViewWebhookEvent({
      alert_id: alertId,
      processed_at: Date.now(),
      status: bridgeResult.status,
      brain_decision: normalizedDecision,
      brain_reason: reason,
      brain_response_json: toSafeJson(brainData),
      final_result: bridgeResult.finalResult,
      last_error: bridgeResult.lastError,
    });
    saveLog({
      level: bridgeResult.executionDecision === "REJECT" ? "warn" : "info",
      message: `[TV_WEBHOOK_EXEC_BRIDGE] ${alertId} brain=${normalizedDecision} exec=${bridgeResult.executionDecision} result=${bridgeResult.finalResult} reason=${bridgeResult.responseReason}`,
      data: JSON.stringify({ brainPayload, testOverridesEnabled: testOverrides.enabled, guardFailure: bridgeResult.guardFailure }),
    });

    res.status(200).json({
      ok: true,
      alertId,
      brainDecision: normalizedDecision,
      executionDecision: bridgeResult.executionDecision,
      reason: bridgeResult.responseReason,
      finalResult: bridgeResult.finalResult,
      guardFailure: bridgeResult.guardFailure,
      orderPlaced: false,
      dryRun: true,
    });
  } catch (error: any) {
    const reason = error?.name === "AbortError" ? "SMART_BRAIN_TIMEOUT" : "SMART_BRAIN_UNREACHABLE";
    finalizeTradingViewWebhookEvent({
      alert_id: alertId,
      processed_at: Date.now(),
      status: "brain_reject",
      brain_decision: "REJECT",
      brain_reason: reason,
      brain_response_json: null,
      final_result: "no_order",
      last_error: String(error?.message || error || reason),
    });
    saveLog({ level: "warn", message: `[TV_WEBHOOK_REJECT] ${alertId} ${reason}`, data: payloadJson });
    res.status(200).json({ ok: true, alertId, brainDecision: "REJECT", executionDecision: "REJECT", reason, finalResult: "no_order", orderPlaced: false, dryRun: true });
  } finally {
    clearTimeout(timeout);
  }
});

// In production, serve static files
const distPath = path.join(process.cwd(), "dist", "public");
app.use(express.static(distPath));
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

const PORT = parseInt(process.env.PORT || "3000");
app.listen(PORT, "0.0.0.0", () => console.log(`AI Trader running on port ${PORT}`));

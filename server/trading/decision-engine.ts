import { OptionQuote, type StockData } from "./market-data.js";

// ========== DECISION ENGINE ==========

export interface DecisionResult {
  decision: "EXECUTE" | "ALERT ONLY" | "REJECT";
  confidence: number; // 0-100
  strengths: string[];
  weaknesses: string[];
  reasonCodes: string[];
  summary: string;
}

// Hard blocks - always reject
const HARD_BLOCKS = {
  marketClosed: () => {
    const hour = new Date().getHours();
    const etHour = hour - 4; // Approximate ET
    return etHour < 9 || etHour >= 16;
  },
  vixHigh: (vix: number | null) => vix !== null && vix > 22,
  newsActive: () => false, // Will be connected to news filter
  maxTradesReached: (todayTrades: number, maxTrades: number) => todayTrades >= maxTrades,
  maxLossReached: (dailyPnl: number, maxLoss: number) => dailyPnl <= -maxLoss,
};

// Soft score components (0-100 each)
interface ScoreInput {
  rsi: number | null;
  emaTrend: "up" | "down" | "neutral";
  adx: number | null;
  vwapPosition: "above" | "below" | "neutral";
  volume: number | null;
  avgVolume: number | null;
  vix: number | null;
  price: number | null;
  prevPrice: number | null;
}

function calculateConfidence(input: ScoreInput, confirmations: number): DecisionResult {
  let score = 0;
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const reasonCodes: string[] = [];

  // ===== HARD BLOCKS =====
  if (HARD_BLOCKS.marketClosed()) {
    return {
      decision: "REJECT",
      confidence: 0,
      strengths: [],
      weaknesses: ["Market Closed"],
      reasonCodes: ["HB_MARKET_CLOSED"],
      summary: "السوق مغلق خارج ساعات التداول",
    };
  }

  if (input.vix !== null && HARD_BLOCKS.vixHigh(input.vix)) {
    return {
      decision: "REJECT",
      confidence: 0,
      strengths: [],
      weaknesses: ["VIX مرتفع"],
      reasonCodes: ["HB_VIX_HIGH"],
      summary: `VIX مرتفع (${input.vix.toFixed(1)})`,
    };
  }

  // ===== SOFT SCORE CALCULATION =====

  // 1. RSI (0-20 points)
  if (input.rsi !== null) {
    const rsiScore = input.rsi >= 40 && input.rsi <= 70 ? 20 :
                      input.rsi >= 30 && input.rsi < 40 ? 15 :
                      input.rsi > 70 && input.rsi <= 80 ? 10 : 5;
    score += rsiScore;
    if (rsiScore >= 15) strengths.push("RSI مناسب");
    else if (rsiScore < 10) weaknesses.push("RSI غير مثالي");
    if (input.rsi >= 40 && input.rsi <= 70) reasonCodes.push("S_RSI_OK");
  }

  // 2. EMA Trend (0-20 points)
  if (input.emaTrend === "up") {
    score += 20;
    strengths.push("ترند صاعد");
    reasonCodes.push("S_EMA_UP");
  } else if (input.emaTrend === "down") {
    score += 10;
    strengths.push("ترند هابط (PUT)");
    reasonCodes.push("S_EMA_DOWN");
  } else {
    score += 5;
    weaknesses.push("ترند محايد");
    reasonCodes.push("W_EMA_NEUTRAL");
  }

  // 3. ADX (0-20 points)
  if (input.adx !== null) {
    const adxScore = input.adx >= 25 ? 20 :
                     input.adx >= 20 ? 15 :
                     input.adx >= 15 ? 10 : 5;
    score += adxScore;
    if (adxScore >= 15) strengths.push("ADX قوي");
    else if (adxScore < 10) weaknesses.push("ADX ضعيف");
    if (input.adx >= 20) reasonCodes.push("S_ADX_STRONG");
  }

  // 4. VWAP (0-15 points)
  if (input.vwapPosition === "above") {
    score += 15;
    strengths.push("السعر فوق VWAP");
    reasonCodes.push("S_VWAP_ABOVE");
  } else if (input.vwapPosition === "below") {
    score += 10;
    strengths.push("السعر تحت VWAP (PUT)");
    reasonCodes.push("S_VWAP_BELOW");
  } else {
    score += 5;
    weaknesses.push("VWAP غير واضح");
    reasonCodes.push("W_VWAP_NEUTRAL");
  }

  // 5. Volume (0-15 points)
  if (input.volume && input.avgVolume) {
    const volRatio = input.volume / input.avgVolume;
    const volScore = volRatio >= 1.2 ? 15 :
                      volRatio >= 0.8 ? 10 :
                      volRatio >= 0.5 ? 5 : 0;
    score += volScore;
    if (volScore >= 10) strengths.push("حجم جيد");
    else if (volScore < 5) weaknesses.push("حجم منخفض");
    if (volRatio >= 1.0) reasonCodes.push("S_VOLUME_OK");
  }

  // 6. VIX (0-10 points)
  if (input.vix !== null && input.vix < 20) {
    score += 10;
    strengths.push("VIX منخفض");
    reasonCodes.push("S_VIX_OK");
  } else if (input.vix !== null && input.vix > 25) {
    score -= 5;
    weaknesses.push("VIX مرتفع");
    reasonCodes.push("W_VIX_HIGH");
  }

  // ===== BASE CONFIRMATIONS (0-10 points) =====
  score += Math.min(confirmations * 2, 10);
  if (confirmations >= 6) {
    strengths.push(`${confirmations}/8 تأكيدات`);
    reasonCodes.push("S_CONFIRMATIONS_OK");
  }

  // ===== CLASSIFICATION =====

  // Ensure score is 0-100
  score = Math.max(0, Math.min(100, score));

  // Final decision based on score and other factors
  let decision: DecisionResult["decision"] = "REJECT";
  let summary = "";

  if (score >= 70) {
    decision = "EXECUTE";
    summary = `إشارة قوية - ثقة ${score}%`;
  } else if (score >= 50) {
    decision = "ALERT ONLY";
    summary = `إشارة متوسطة - ثقة ${score}%`;
  } else {
    decision = "REJECT";
    summary = `إشارة ضعيفة - ثقة ${score}%`;
  }

  return {
    decision,
    confidence: score,
    strengths,
    weaknesses,
    reasonCodes,
    summary,
  };
}

export function evaluateSignal(
  stockData: StockData | null,
  optionQuote: OptionQuote | null,
  todayTrades: number,
  maxTrades: number,
  dailyPnl: number,
  maxLoss: number,
  confirmations: number
): DecisionResult {
  // Check hard blocks first
  if (HARD_BLOCKS.maxTradesReached(todayTrades, maxTrades)) {
    return {
      decision: "REJECT",
      confidence: 0,
      strengths: [],
      weaknesses: ["Max trades reached"],
      reasonCodes: ["HB_MAX_TRADES"],
      summary: "تم الوصول للحد الأقصى للصفقات",
    };
  }

  if (HARD_BLOCKS.maxLossReached(dailyPnl, maxLoss)) {
    return {
      decision: "REJECT",
      confidence: 0,
      strengths: [],
      weaknesses: ["Max daily loss reached"],
      reasonCodes: ["HB_MAX_LOSS"],
      summary: "تم الوصول للحد الأقصى للخسارة",
    };
  }

  // Build score input
  const input: ScoreInput = {
    rsi: stockData?.rsi14 ?? null,
    emaTrend: (stockData?.ema9 ?? 0) > (stockData?.ema21 ?? 0) ? "up" :
             (stockData?.ema9 ?? 0) < (stockData?.ema21 ?? 0) ? "down" : "neutral",
    adx: stockData?.adx ?? null,
    vwapPosition: (stockData?.close ?? 0) > (stockData?.vwap ?? 0) ? "above" :
                  (stockData?.close ?? 0) < (stockData?.vwap ?? 0) ? "below" : "neutral",
    volume: stockData?.volume ?? null,
    avgVolume: stockData?.volume ?? null, // Using current as proxy
    vix: stockData?.vix ?? null,
    price: stockData?.close ?? null,
    prevPrice: stockData?.prevClose ?? null,
  };

  // Calculate confidence
  return calculateConfidence(input, confirmations);
}

export default { evaluateSignal };
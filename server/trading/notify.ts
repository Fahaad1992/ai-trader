import TelegramBot from "node-telegram-bot-api";
import { isSPXOptionsMode } from "./trade-mode.js";

const TOKEN = process.env.TG_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

type DecisionExtras = {
  rawScore?: number | null;
  requestedSize?: number;
  finalSize?: number;
  optionType?: string;
  contract?: string;
  entryPrice?: number | null;
  target?: number | null;
  stopLoss?: number | null;
  reasonArabic?: string | null;
};

let bot: TelegramBot | null = null;
if (TOKEN && CHAT_ID) {
  try {
    bot = new TelegramBot(TOKEN, { polling: false });
  } catch (_e) {}
}

function compactSummary(payloadSummary: string): string {
  return (payloadSummary || "-").replace(/\s+/g, " ").trim();
}

function send(typeOrMsg: string, maybeMsg?: string, payloadSummary: string = ""): void {
  const type = maybeMsg === undefined ? "GENERIC" : typeOrMsg;
  const msg = maybeMsg === undefined ? typeOrMsg : maybeMsg;
  const summary = compactSummary(payloadSummary);
  if (!bot || !CHAT_ID) {
    console.warn(`[NOTIFY_SKIP] type:${type} payload:${summary} reason:telegram_not_configured`);
    return;
  }
  console.log(`[NOTIFY_ATTEMPT] type:${type} payload:${summary}`);
  try {
    bot.sendMessage(CHAT_ID, msg, { parse_mode: "HTML" })
      .then(() => console.log(`[NOTIFY_OK] type:${type} payload:${summary}`))
      .catch((err: any) => console.error(`[NOTIFY_FAIL] type:${type} payload:${summary} error:${err?.message || String(err)}`));
  } catch (err: any) {
    console.error(`[NOTIFY_FAIL] type:${type} payload:${summary} error:${err?.message || String(err)}`);
  }
}

function formatYesNo(value: boolean): string {
  return value ? "نعم" : "لا";
}

function translateDecision(decision: "EXECUTE" | "REDUCE" | "WAIT" | "ALERT_ONLY" | "REJECT"): string {
  switch (decision) {
    case "EXECUTE":
      return "تنفيذ";
    case "REDUCE":
      return "تقليل";
    case "WAIT":
      return "انتظار";
    case "ALERT_ONLY":
      return "تنبيه فقط";
    case "REJECT":
    default:
      return "رفض";
  }
}

function normalizeReasonKey(reason: string): string {
  return reason.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function translateReasonCode(code: string): string {
  const value = normalizeReasonKey(code);
  const map: Record<string, string> = {
    FAST_PATH: "مسار سريع",
    ALERT_ONLY: "تنبيه فقط",
    EMERGENCY_STOP: "إيقاف طارئ",
    MAX_TRADES_REACHED: "تم بلوغ الحد الأقصى للصفقات",
    MAX_OPEN_POSITIONS: "تم بلوغ الحد الأقصى للصفقات المفتوحة",
    DAILY_LOSS_LIMIT: "تم بلوغ حد الخسارة اليومية",
    LOW_CONFIDENCE: "الثقة منخفضة",
    RISK_REJECT: "رفض بسبب المخاطر",
    WAIT_FOR_CONFIRMATION: "بانتظار تأكيد إضافي",
    NO_SETUP: "لا توجد فرصة مناسبة",
    MARKET_CLOSED: "السوق مغلق",
    IBKR_DISCONNECTED: "انقطاع اتصال الوسيط",
    SMART_BRAIN_TIMEOUT: "انتهت مهلة سمارت برين",
    SMART_BRAIN_ERROR: "خطأ في سمارت برين",
    MACRO_UNKNOWN_EVENT_ALERT_ONLY: "تنبيه فقط بسبب حدث ماكرو غير مؤكد",
    MACRO_HIGH_RISK_EVENT: "حدث ماكرو عالي الخطورة",
    MACRO_IMMINENT_EVENT: "حدث ماكرو وشيك",
    MACRO_OIL_SHOCK: "صدمة في حركة النفط",
    MACRO_GUARD_BLOCK: "إيقاف بسبب حماية الماكرو",
    NEWS_BLOCKED: "تم الحجب بسبب الأخبار",
    TOO_EARLY_ENTRY: "الدخول مبكر",
    WEAK_CONFIRMATION: "التأكيدات غير كافية"
  };

  return map[value] || code;
}

function formatReasonCodes(reasonCodes: string[]): string {
  if (!reasonCodes || reasonCodes.length === 0) return "لا يوجد";
  return reasonCodes.map((code) => translateReasonCode(code)).join("، ");
}

function formatMode(mode: string): string {
  const value = mode.toLowerCase();
  if (value === "paper") return "ورقي";
  if (value === "live") return "حقيقي";
  return mode;
}

function formatOptionType(type: string): string {
  const value = String(type || "").toUpperCase();
  if (isSPXOptionsMode()) {
    if (value === "CALL" || value === "LONG") return "CALL طلوع";
    if (value === "PUT" || value === "SHORT") return "PUT نزول";
  }
  if (value === "LONG") return "شراء (LONG)";
  if (value === "SHORT") return "بيع (SHORT)";
  if (value === "CALL") return "كول";
  if (value === "PUT") return "بوت";
  return type;
}

function isFuturesSide(type: string): boolean {
  if (isSPXOptionsMode()) return false;
  const v = String(type || "").toUpperCase();
  return v === "LONG" || v === "SHORT";
}

function formatCurrency(value?: number | null): string {
  return Number.isFinite(value as number) ? `$${Number(value).toFixed(2)}` : "غير متاح";
}

function getReasonPhrasesArabic(reasonCodes: string[] = []): string[] {
  const map: Record<string, string> = {
    S_CONFIRMATIONS_STRONG: "التأكيدات قوية",
    S_RSI_BALANCED: "الزخم متوازن",
    S_EMA_UP: "الاتجاه صاعد",
    S_EMA_DOWN: "الاتجاه هابط",
    W_ADX_WEAK: "الاتجاه ضعيف",
    S_ADX_OK: "الاتجاه جيد",
    S_ADX_STRONG: "الاتجاه قوي",
    W_VWAP_NEUTRAL: "السعر في منطقة محايدة",
    S_VWAP_ABOVE: "السعر فوق VWAP",
    S_VWAP_BELOW: "السعر تحت VWAP",
    S_VOLUME_OK: "الحجم جيد",
    LOW_CONFIDENCE: "الثقة غير كافية",
    WEAK_CONFIRMATION: "تم رفض الصفقة لأن الإشارة غير كافية",
    WAIT_FOR_CONFIRMATION: "بانتظار تأكيد إضافي",
    NO_SETUP: "لا توجد فرصة مناسبة",
    MARKET_CLOSED: "السوق مغلق",
    IBKR_DISCONNECTED: "الوسيط غير متصل",
    CONTRACT_NOT_FOUND: "لم يتم العثور على عقد مناسب",
    VALID_CONTRACT_DEFINITION_FAILED: "بيانات العقد غير مكتملة",
    PREMIUM_SANITY_FILTER_FAILED: "سعر العقد غير مناسب",
    LIQUIDITY_FILTER_FAILED: "سيولة العقد ضعيفة",
    SPREAD_FILTER_FAILED: "السبريد مرتفع",
    STRIKE_EXPIRY_SELECTION_QUALITY_FAILED: "العقد لا يطابق معايير الدخول",
    MARKET_DATA_INVALID: "بيانات السوق غير مكتملة",
    NEWS_BLOCKED: "تم إيقاف الصفقة بسبب الأخبار",
    TOO_EARLY_ENTRY: "الدخول مبكر",
    MACRO_GUARD_BLOCK: "تم إيقاف الصفقة بسبب عامل ماكرو"
  };

  const phrases: string[] = [];
  for (const code of reasonCodes) {
    const normalized = normalizeReasonKey(code);
    const phrase = map[normalized];
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }
  return phrases;
}

function summarizeReasonArabic(
  decision: "EXECUTE" | "REDUCE" | "WAIT" | "ALERT_ONLY" | "REJECT",
  reasonCodes: string[] = [],
  summary: string = "",
  extras?: DecisionExtras,
): string {
  if (extras?.reasonArabic && extras.reasonArabic.trim()) return extras.reasonArabic.trim();

  const phrases = getReasonPhrasesArabic(reasonCodes);
  const hasNeutralPrice = phrases.includes("السعر في منطقة محايدة");
  const hasWeakTrend = phrases.includes("الاتجاه ضعيف");
  const hasStrongConfirmations = phrases.includes("التأكيدات قوية");
  const hasGoodVolume = phrases.includes("الحجم جيد");

  if (decision === "REDUCE") {
    const tail = [hasNeutralPrice ? "السعر في منطقة محايدة" : "", hasWeakTrend ? "الاتجاه ضعيف" : ""]
      .filter(Boolean)
      .join("، ");
    return tail ? `تم تقليل الحجم بسبب ثقة متوسطة، ${tail}` : "تم تقليل الحجم بسبب ثقة متوسطة";
  }

  if (decision === "WAIT" || decision === "ALERT_ONLY" || decision === "REJECT") {
    if (hasNeutralPrice) return "السعر في منطقة محايدة";
    if (hasWeakTrend) return "الاتجاه ضعيف";
    if (phrases.length > 0) return phrases[0];
    if (/medium-confidence/i.test(summary)) return "الثقة غير كافية للتنفيذ";
    if (/confirmation|setup|signal/i.test(summary)) return "تم رفض الصفقة لأن الإشارة غير كافية";
    return "تم رفض الصفقة لأن الإشارة غير كافية";
  }

  const positives = [
    hasStrongConfirmations ? "التأكيدات قوية" : "",
    phrases.includes("السعر فوق VWAP") ? "السعر فوق VWAP" : "",
    hasGoodVolume ? "الحجم جيد" : "",
  ].filter(Boolean);

  if (positives.length > 0) return positives.slice(0, 2).join("، ");
  if (/high-confidence/i.test(summary)) return "التأكيدات قوية";
  return phrases[0] || "الشروط مناسبة للتنفيذ";
}

function translateExitReason(reason: string): string {
  const value = normalizeReasonKey(reason);
  const map: Record<string, string> = {
    STOP_LOSS: "وقف الخسارة",
    TAKE_PROFIT: "جني الربح",
    TARGET_HIT: "تحقق الهدف",
    MANUAL_EXIT: "إغلاق يدوي",
    SIGNAL_EXIT: "خروج بسبب الإشارة",
    TIME_EXIT: "خروج زمني",
    END_OF_DAY: "إغلاق نهاية اليوم",
    EOD: "إغلاق نهاية اليوم",
    TRAILING_STOP: "وقف متحرك",
    EMERGENCY_EXIT: "خروج طارئ"
  };
  return map[value] || reason;
}

function exitTitle(reason: string, pnl: number): string {
  const value = normalizeReasonKey(reason);
  if (value === "STOP_LOSS") return "🛑 تم تنفيذ وقف الخسارة";
  if (value === "TAKE_PROFIT" || value === "TARGET_HIT") return "✅ تم جني الربح";
  return pnl >= 0 ? "✅ تم إغلاق الصفقة" : "🔴 تم إغلاق الصفقة";
}

// ============= DECISION NOTIFICATIONS =============

export function notifyDecision(
  symbol: string,
  signal: string,
  decision: "EXECUTE" | "REDUCE" | "WAIT" | "ALERT_ONLY" | "REJECT",
  confidenceFinal: number,
  reasonCodes: string[],
  summary: string,
  emergencyStop: boolean = false,
  extras?: DecisionExtras,
): void {
  const emoji = decision === "EXECUTE"
    ? "✅"
    : decision === "REDUCE"
      ? "🟠"
      : decision === "WAIT"
        ? "⏳"
        : decision === "ALERT_ONLY"
          ? "⚠️"
          : "❌";

  const reasonArabic = summarizeReasonArabic(decision, reasonCodes, summary, extras);
  const contracts = extras?.finalSize ?? extras?.requestedSize;
  // ===== P0: suppress EXECUTE with incomplete fields =====
  if (decision === 'EXECUTE') {
    const _miss: string[] = [];
    if (!extras?.contract) _miss.push('contract');
    if (!(typeof extras?.entryPrice === 'number' && extras.entryPrice > 0)) _miss.push('entry');
    if (!(typeof extras?.stopLoss === 'number' && extras.stopLoss > 0)) _miss.push('stopLoss');
    if (!(typeof extras?.target === 'number' && extras.target > 0)) _miss.push('target');
    if (!(typeof contracts === 'number' && contracts > 0)) _miss.push('qty');
    if (_miss.length) {
      console.warn(`[NOTIFY_SUPPRESSED] type:DECISION_INCOMPLETE symbol=${symbol} decision=EXECUTE missing=${_miss.join(',')} signal=${signal} confidence=${confidenceFinal}%`);
      send('DECISION_BLOCKED', '', `symbol=${symbol} decision=EXECUTE blocked=incomplete_fields missing=${_miss.join(',')}`);
      return;
    }
  }
  const msg = `${emoji} قرار الصفقة

📌 الرمز: <b>${symbol}</b>
📈 نوع الصفقة: <b>${extras?.optionType ? formatOptionType(extras.optionType) : "غير متاح"}</b>
📄 العقد: <b>${extras?.contract ?? "غير متاح"}</b>
💵 سعر الدخول: <b>${formatCurrency(extras?.entryPrice)}</b>
📦 عدد العقود: <b>${contracts ?? "غير متاح"}</b>
🎯 الهدف: <b>${formatCurrency(extras?.target)}</b>
🛡️ وقف الخسارة: <b>${formatCurrency(extras?.stopLoss)}</b>
${emoji} القرار: <b>${translateDecision(decision)}</b>
📊 الثقة: <b>${confidenceFinal}%</b>
🧾 السبب: <b>${reasonArabic}</b>`;

  const debugSummary = `symbol=${symbol} signal=${signal} decision=${decision} confidence=${confidenceFinal}% reason_codes=${reasonCodes.join(",") || "NONE"} raw_score=${extras?.rawScore ?? "n/a"} emergency_stop=${formatYesNo(emergencyStop)}`;
  send("SMART_DECISION", msg, debugSummary);
}

export function notifyBotStart(mode: string, strategy: string): void {
  send(`🚀 بدأ النظام

النظام: <b>سمارت برين</b>
الوضع: <b>${formatMode(mode)}</b>
الاستراتيجية: <b>${strategy}</b>`);
}

export function notifyTradeEntry(
  symbol: string,
  expiry: string,
  strike: number,
  type: string,
  contracts: number,
  entryPrice: number,
  stopLoss: number,
  target: number,
  confidence: number = 0,
  strengths: string[] = [],
  weaknesses: string[] = [],
  entryTime: number = Date.now(),
  context?: {
    signalScore?: string;
    rawScore?: number | null;
    requestedSize?: number;
    finalSize?: number;
    reductionReason?: string | null;
    orderType?: string;
    orderId?: number | null;
    permId?: number | null;
    stopType?: string;
    protectionMode?: string;
    brokerSideStop?: boolean;
    trailingDistance?: number;
    reasonArabic?: string | null;
  },
): void {
  // Futures-aware contract label: for MES LONG/SHORT show "MES FUT 202606" (no strike/expiry/right).
  const _isFuturesSide = isFuturesSide(type);
  const _futContractMonth = "202606";
  const contract = _isFuturesSide
    ? `${symbol} FUT ${_futContractMonth}`
    : `${symbol} ${expiry} ${strike} ${formatOptionType(type)}`;
  const finalContracts = context?.finalSize ?? contracts;
  const reasonArabic = context?.reasonArabic?.trim()
    || ((context?.requestedSize != null && finalContracts < context.requestedSize)
      ? "تم تقليل الحجم بسبب ثقة متوسطة"
      : "التأكيدات قوية");

  const msg = `✅ قرار الصفقة

📌 الرمز: <b>${symbol}</b>
📈 نوع الصفقة: <b>${formatOptionType(type)}</b>
📄 العقد: <b>${contract}</b>
💵 سعر الدخول: <b>${formatCurrency(entryPrice)}</b>
📦 عدد العقود: <b>${finalContracts}</b>
🎯 الهدف: <b>${formatCurrency(target)}</b>
🛡️ وقف الخسارة: <b>${formatCurrency(stopLoss)}</b>
✅ القرار: <b>تنفيذ</b>
📊 الثقة: <b>${confidence > 0 ? confidence + "%" : "غير متاح"}</b>
🧾 السبب: <b>${reasonArabic}</b>`;

  const entrySummary = `contract=${contract} contracts=${finalContracts} requested=${context?.requestedSize ?? "n/a"} entry=$${entryPrice.toFixed(2)} stop=$${stopLoss.toFixed(2)} target=$${target.toFixed(2)} confidence=${confidence > 0 ? confidence + "%" : "n/a"} signal=${context?.signalScore ?? "n/a"} raw_score=${context?.rawScore ?? "n/a"} reduction_reason=${context?.reductionReason ?? "none"}`;
  send("TRADE_OPEN", msg, entrySummary);
}

export function notifyTradeExit(
  symbol: string,
  expiry: string,
  strike: number,
  type: string,
  reason: string,
  pnl: number,
  pnlPercent: number,
  exitPrice: number,
  entryTime: number,
  exitTime: number = Date.now(),
  opts?: {
    exitReasonKey?: string;
    breakEvenStopMoved?: boolean;
    reEntryAllowed?: boolean;
    blockedReason?: string | null;
    initialStopPrice?: number;
    effectiveStopPrice?: number;
  }
): void {
  // FUTURES-AWARE: in futures mode, symbol already encodes "MES FUT 202606".
  // For options, keep legacy "<sym> <expiry> <strike> CALL/PUT".
  const _isFuturesSide = isFuturesSide(type);
  const contract = _isFuturesSide ? symbol : `${symbol} ${expiry} ${strike} ${formatOptionType(type)}`;
  const pnlColor = pnl > 0 ? "🟢" : "🔴";

  const durationMs = exitTime - entryTime;
  const hours = Math.floor(durationMs / (1000 * 60 * 60));
  const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
  const duration = hours > 0 ? `${hours}س ${minutes}د` : `${minutes}د`;
  const normalizedReason = normalizeReasonKey(reason);
  const eventType = normalizedReason === "STOP_LOSS" ? "STOP_LOSS_EXIT" : normalizedReason === "TRAILING_STOP" ? "TRAILING_EXIT" : "TRADE_CLOSE";

  const msg = `${exitTitle(reason, pnl)}

📌 العقد: <b>${contract}</b>
📋 السبب: ${translateExitReason(reason)}
⏰ مدة الصفقة: ${duration}
💵 سعر الخروج: $${exitPrice.toFixed(2)}
${pnlColor} النتيجة: <b>$${pnl.toFixed(2)}</b> (${pnlPercent.toFixed(1)}%)`;
  const beLine = opts?.exitReasonKey
    ? `\n🏷️ تصنيف الخروج: <b>${opts.exitReasonKey}</b>${(opts.breakEvenStopMoved && opts.exitReasonKey === 'BREAK_EVEN_STOP') ? ' (BE-moved)' : ''}${typeof opts.reEntryAllowed === 'boolean' ? ` | re-entry:${opts.reEntryAllowed ? 'allowed' : 'blocked'}` : ''}${opts.blockedReason ? ` | blocked:${opts.blockedReason}` : ''}`
    : '';
  const finalMsg = msg + beLine;
  const beSummary = opts?.exitReasonKey ? ` exitReason=${opts.exitReasonKey} beMoved=${!!opts.breakEvenStopMoved} reEntry=${opts.reEntryAllowed ?? 'n/a'} blocked=${opts.blockedReason ?? 'none'} initStop=${opts.initialStopPrice ?? 'n/a'} effStop=${opts.effectiveStopPrice ?? 'n/a'}` : '';
  const exitSummary = `contract=${contract} reason=${normalizedReason} pnl=$${pnl.toFixed(2)} pnlPct=${pnlPercent.toFixed(1)} exit=$${exitPrice.toFixed(2)}${beSummary}`;
  send(eventType, finalMsg, exitSummary);
}

export function notifyStopLossHit(symbol: string, pnl: number): void {
  send("STOP_LOSS_HIT", `🛑 تم تفعيل وقف الخسارة

📌 الرمز: <b>${symbol}</b>
💵 النتيجة: <b>$${pnl.toFixed(2)}</b>`, `symbol=${symbol} pnl=$${pnl.toFixed(2)}`);
}

export function notifyTradeRejected(symbol: string, reason: string): void {
  send(`❌ تم رفض الصفقة

📌 الرمز: <b>${symbol}</b>
🧾 السبب: ${translateExitReason(reason)}`);
}

export function notifyHeartbeat(mode: string, strategy: string, running: boolean, ibkrStatus: string, openPositions: number, positions: string): void {
  send(`💓 نبض النظام

▶️ التشغيل: ${running ? "يعمل" : "متوقف"}
🧭 الوضع: ${formatMode(mode)}
🧠 الاستراتيجية: ${strategy}
🏦 حالة IBKR: ${ibkrStatus}
📊 الصفقات المفتوحة: ${openPositions}
📌 المراكز: ${positions}`);
}

export function notifyError(source: string, error: string): void {
  send(`⚠️ خطأ مهم

📍 المصدر: <b>${source}</b>
🧾 التفاصيل: ${error}`);
}

export function notifyIBKRDisconnect(): void {
  send("⚠️ انقطع الاتصال مع الوسيط");
}

export function notifyIBKRReconnect(): void {
  send("✅ تمت إعادة الاتصال مع الوسيط");
}

export function notifyNewsAlert(headline: string, impact: string = "عادي"): void {
  send(`📰 تنبيه أخبار

🗞️ الخبر: ${headline}
⚠️ مستوى التأثير: ${impact}`);
}

export function notifyDailyReport(
  totalTrades: number,
  wins: number,
  losses: number,
  netPnl: number,
  winRate: number
): void {
  const emoji = netPnl >= 0 ? "🟢" : "🔴";
  const msg = `📊 التقرير اليومي

📈 إجمالي الصفقات: ${totalTrades}
✅ الصفقات الرابحة: ${wins}
❌ الصفقات الخاسرة: ${losses}
🎯 نسبة النجاح: ${winRate.toFixed(1)}%
${emoji} الصافي: <b>$${netPnl.toFixed(2)}</b>`;
  send(msg);
}

export function notifyDataLoadFailure(details: string = "تعذر تحميل بيانات السوق"): void {
  send(`⚠️ فشل تحميل البيانات

🧾 التفاصيل: ${details}`);
}

export function notifyWaitingMode(reason: string = "النظام بانتظار توفر الشروط أو البيانات"): void {
  send(`⏳ دخول وضع الانتظار

🧾 السبب: ${reason}`);
}

export function notifyBotStopped(reason: string = "تم إيقاف البوت"): void {
  send(`🛑 توقف البوت

🧾 السبب: ${reason}`);
}

export function notifyDataSourceFailure(source: string, details: string = "تعطل مصدر البيانات"): void {
  send(`⚠️ تعطل مصدر بيانات

📍 المصدر: <b>${source}</b>
🧾 التفاصيل: ${details}`);
}

export function notifyCriticalError(source: string, details: string): void {
  send(`🚨 خطأ حرج

📍 المصدر: <b>${source}</b>
🧾 التفاصيل: ${details}`);
}

export function notifyHealthFailure(details: string): void {
  send(`🚨 فشل في الحالة الصحية

🧾 التفاصيل: ${details}`);
}

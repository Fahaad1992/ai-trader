import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.TG_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

let bot: TelegramBot | null = null;
if (TOKEN && CHAT_ID) {
  try {
    bot = new TelegramBot(TOKEN, { polling: false });
  } catch (_e) {}
}

function send(msg: string): void {
  if (!bot || !CHAT_ID) return;
  try {
    bot.sendMessage(CHAT_ID, msg, { parse_mode: "HTML" }).catch(() => {});
  } catch {}
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

function translateReasonCode(code: string): string {
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

  return map[code] || "سبب تقني";
}

function formatReasonCodes(reasonCodes: string[]): string {
  if (!reasonCodes || reasonCodes.length === 0) return "لا يوجد";
  return reasonCodes.map(translateReasonCode).join("، ");
}

function formatMode(mode: string): string {
  const value = mode.toLowerCase();
  if (value === "paper") return "ورقي";
  if (value === "live") return "حقيقي";
  return mode;
}

function formatOptionType(type: string): string {
  const value = type.toUpperCase();
  if (value === "CALL") return "كول";
  if (value === "PUT") return "بوت";
  return type;
}

function translateExitReason(reason: string): string {
  const value = reason.trim().toUpperCase();
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
  const value = reason.trim().toUpperCase();
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
  emergencyStop: boolean = false
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

  const msg = `${emoji} قرار سمارت برين

📌 الرمز: <b>${symbol}</b>
🧠 الإشارة: <b>${signal}</b>
${emoji} القرار: <b>${translateDecision(decision)}</b>
📊 الثقة النهائية: <b>${confidenceFinal}%</b>
🧾 الأسباب: <b>${formatReasonCodes(reasonCodes)}</b>
🚨 تنبيه فقط: <b>${formatYesNo(decision === "ALERT_ONLY")}</b>
🛑 إيقاف طارئ: <b>${formatYesNo(emergencyStop)}</b>${summary ? `
📝 الملحوظة: ${summary}` : ""}`;

  send(msg);
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
  entryTime: number = Date.now()
): void {
  const contract = `${symbol} ${expiry} ${strike} ${formatOptionType(type)}`;
  const time = new Date(entryTime).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" });
  const msg = `✅ تم فتح صفقة

📌 العقد: <b>${contract}</b>
⏰ الوقت: ${time}
💵 سعر الدخول: $${entryPrice.toFixed(2)}
📊 عدد العقود: ${contracts}
🎯 الهدف: $${target.toFixed(2)}
🛡️ وقف الخسارة: $${stopLoss.toFixed(2)}
📈 ثقة القرار: ${confidence > 0 ? confidence + "%" : "غير متاح"}${strengths.length > 0 ? `
💪 نقاط القوة: ${strengths.join("، ")}` : ""}${weaknesses.length > 0 ? `
⚠️ نقاط الضعف: ${weaknesses.join("، ")}` : ""}`;
  send(msg);
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
  exitTime: number = Date.now()
): void {
  const contract = `${symbol} ${expiry} ${strike} ${formatOptionType(type)}`;
  const pnlColor = pnl > 0 ? "🟢" : "🔴";

  const durationMs = exitTime - entryTime;
  const hours = Math.floor(durationMs / (1000 * 60 * 60));
  const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
  const duration = hours > 0 ? `${hours}س ${minutes}د` : `${minutes}د`;

  const msg = `${exitTitle(reason, pnl)}

📌 العقد: <b>${contract}</b>
📋 السبب: ${translateExitReason(reason)}
⏰ مدة الصفقة: ${duration}
💵 سعر الخروج: $${exitPrice.toFixed(2)}
${pnlColor} النتيجة: <b>$${pnl.toFixed(2)}</b> (${pnlPercent.toFixed(1)}%)`;
  send(msg);
}

export function notifyStopLossHit(symbol: string, pnl: number): void {
  send(`🛑 تم تفعيل وقف الخسارة

📌 الرمز: <b>${symbol}</b>
💵 النتيجة: <b>$${pnl.toFixed(2)}</b>`);
}

export function notifyTradeRejected(symbol: string, reason: string): void {
  send(`❌ تم رفض الصفقة

📌 الرمز: <b>${symbol}</b>
🧾 السبب: ${translateExitReason(reason)}`);
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

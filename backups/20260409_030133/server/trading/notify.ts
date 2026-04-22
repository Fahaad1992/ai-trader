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

  const msg = `${emoji} قرار Smart Brain

📌 <b>${symbol}</b>
🧠 signal: <b>${signal}</b>
${emoji} decision: <b>${decision}</b>
📊 confidence_final: <b>${confidenceFinal}%</b>
🧾 reason_codes: <b>${reasonCodes.length > 0 ? reasonCodes.join(", ") : "NONE"}</b>
🚨 ALERT_ONLY: <b>${decision === "ALERT_ONLY" ? "YES" : "NO"}</b>
🛑 EMERGENCY_STOP: <b>${emergencyStop ? "YES" : "NO"}</b>

📝 ${summary}`;

  send(msg);
}

export function notifyBotStart(mode: string, strategy: string): void {
  send(`🚀 البوت بدأ | <b>${mode}</b> | ${strategy}`);
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
  const contract = `${symbol} ${expiry} ${strike} ${type.toUpperCase()}`;
  const time = new Date(entryTime).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const msg = `✅ صفقة دخلت

📌 <b>${contract}</b>
⏰ الوقت: ${time}
💵 الدخول: $${entryPrice.toFixed(2)}
📊 العقود: ${contracts}
🎯 الهدف: $${target.toFixed(2)}
🛡️ الوقف: $${stopLoss.toFixed(2)}
📊 ثقة القرار: ${confidence > 0 ? confidence + "%" : "N/A"}`;
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
  const contract = `${symbol} ${expiry} ${strike} ${type.toUpperCase()}`;
  const emoji = pnl > 0 ? "💰" : "🛑";
  const pnlColor = pnl > 0 ? "🟢" : "🔴";

  const durationMs = exitTime - entryTime;
  const hours = Math.floor(durationMs / (1000 * 60 * 60));
  const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
  const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  const msg = `${emoji} صفقة خرجت

📌 <b>${contract}</b>
📋 السبب: ${reason}
⏰ مدة الصفقة: ${duration}
💵 الخروج: $${exitPrice.toFixed(2)}
${pnlColor} الربح/الخسارة: <b>$${pnl.toFixed(2)}</b> (${pnlPercent.toFixed(1)}%)`;
  send(msg);
}

export function notifyStopLossHit(symbol: string, pnl: number): void {
  send(`🛑 Stop Loss Hit | ${symbol} | 💰$${pnl.toFixed(2)}`);
}

export function notifyTradeRejected(symbol: string, reason: string): void {
  send(`❌ صفقة ${symbol} مرفوضة: ${reason}`);
}

export function notifyError(source: string, error: string): void {
  send(`⚠️ خطأ من ${source}: ${error}`);
}

export function notifyIBKRDisconnect(): void {
  send("⚠️ انقطع الاتصال بـ IBKR");
}

export function notifyIBKRReconnect(): void {
  send("✅ تم إعادة الاتصال بـ IBKR");
}

export function notifyNewsAlert(headline: string, impact: string = "عادي"): void {
  send(`📰 خبر عاجل

${headline}
⚠️ السوق قد يتذبذب - ${impact}`);
}

export function notifyDailyReport(
  totalTrades: number,
  wins: number,
  losses: number,
  netPnl: number,
  winRate: number
): void {
  const emoji = netPnl >= 0 ? "🟢" : "🔴";
  const msg = `📊 تقرير يومي

📈 total الصفقات: ${totalTrades}
✅ الرابحة: ${wins}
❌ الخاسرة: ${losses}
🎯 نسبة النجاح: ${winRate.toFixed(1)}%
${emoji} الصافي: <b>$${netPnl.toFixed(2)}</b>`;
  send(msg);
}

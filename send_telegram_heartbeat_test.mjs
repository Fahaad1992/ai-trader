import TelegramBot from 'node-telegram-bot-api';

const token = process.env.TG_TOKEN;
const chatId = process.env.TG_CHAT_ID;

if (!token || !chatId) {
  console.error(JSON.stringify({ ok: false, error: 'MISSING_TG_ENV' }));
  process.exit(2);
}

const bot = new TelegramBot(token, { polling: false });
const now = new Date().toISOString();
const text = `💓 Heartbeat تجريبية\n\n⏱️ الوقت: ${now}\n🧭 الوضع: فحص يدوي\n🧠 الحالة: تم تنفيذ اختبار الإرسال الآن`;

try {
  const res = await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  console.log(JSON.stringify({ ok: true, message_id: res.message_id, chat_id: res.chat.id }));
} catch (error) {
  const message = error?.response?.body?.description || error?.message || String(error);
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

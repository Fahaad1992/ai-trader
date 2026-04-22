import os

with open("engine.ts", "r") as f:
    content = f.read()

# Add import after the last import line
old = 'import { notifyBotStart, notifyTradeEntry, notifyTradeExit, notifyTradeRejected, notifyError, notifyIBKRDisconnect, notifyStopLossHit, notifyNewsAlert, notifyDailyReport } from "./notify.js";'
new = '''import { notifyBotStart, notifyTradeEntry, notifyTradeExit, notifyTradeRejected, notifyError, notifyIBKRDisconnect, notifyStopLossHit, notifyNewsAlert, notifyDailyReport } from "./notify.js";
import { evaluateSignal } from "./decision-engine.js";'''

content = content.replace(old, new)

# Add decision evaluation before openTrade call
old = '''if (r.passed >= minRequired) {
          this.log("info", `[SIGNAL_PASSED] ✅ ${r.underlying}: ${r.passed}/8 تأكيدات (${modeName})`);
          this.log("info", `📊 المؤشرات الداعمة: ${passedNames}`);
          if (failedNames) this.log("info", `⚠️ لم تتحقق: ${failedNames}`);

          const validated = await this.validateOptionForEntry(r.underlying, r.confirmations);
          if (validated) {
            try { notifyTradeEntry(r.underlying, validated.optExpiry, validated.optStrike, validated.type, this.config.options.contractsPerTrade, validated.optBid, (validated.optBid * 0.7).toFixed(2), (validated.optBid * 1.5).toFixed(2)); } catch {} // notify
            await this.openTrade(r.underlying, r.confirmations, validated);
            break;
          }
        }'''

new = '''if (r.passed >= minRequired) {
          this.log("info", `[SIGNAL_PASSED] ✅ ${r.underlying}: ${r.passed}/8 تأكيدات (${modeName})`);
          this.log("info", `📊 المؤشرات الداعمة: ${passedNames}`);
          if (failedNames) this.log("info", `⚠️ لم تتحقق: ${failedNames}`);

          // Decision Engine evaluation
          const data = market.getStockData(r.underlying);
          const decision = evaluateSignal(
            data, null,
            this.stats.todayTrades,
            this.config.risk.maxTradesPerDay,
            this.stats.todayPnl,
            (this.config.capital.mainCapital * this.config.risk.maxDailyLossPercent / 100),
            r.passed
          );

          // Log decision details
          this.log("info", `[DECISION] ثقة: ${decision.confidence}% | القرار: ${decision.decision}`);
          this.log("info", `[DECISION] نقاط القوة: ${decision.strengths.join(", ") || "-none"}`);
          this.log("info", `[DECISION] نقاط الضعف: ${decision.weaknesses.join(", ") || "none"}`);
          this.log("info", `[DECISION] السبب: ${decision.summary}`);

          // Telegram notification with full decision
          try {
            notifyTradeEntry(
              r.underlying,
              data?.expiry || "N/A",
              data?.strike || 0,
              data?.type || "CALL",
              this.config.options.contractsPerTrade,
              data?.price || 0,
              data?.target || 0,
              data?.stop || 0,
              decision.confidence,
              decision.strengths,
              decision.weaknesses
            );
          } catch {}

          // Only proceed if EXECUTE or ALERT
          if (decision.decision === "EXECUTE") {
            const validated = await this.validateOptionForEntry(r.underlying, r.confirmations);
            if (validated) {
              await this.openTrade(r.underlying, r.confirmations, validated);
              break;
            }
          } else if (decision.decision === "ALERT_ONLY") {
            this.log("info", `[ALERT] إشارة متوسطة - جاري الإشعار فقط`);
          }
        }'''

content = content.replace(old, new)

with open("engine.ts", "w") as f:
    f.write(content)

print("OK - Decision Engine added to engine.ts")
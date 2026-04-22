import os

with open("engine.ts", "r") as f:
    content = f.read()

# Add notifyDecision to imports
old = 'import { notifyBotStart, notifyTradeEntry, notifyTradeExit, notifyTradeRejected, notifyError, notifyIBKRDisconnect, notifyStopLossHit, notifyNewsAlert, notifyDailyReport } from "./notify.js";'
new = 'import { notifyBotStart, notifyTradeEntry, notifyTradeExit, notifyTradeRejected, notifyError, notifyIBKRDisconnect, notifyStopLossHit, notifyNewsAlert, notifyDailyReport, notifyDecision } from "./notify.js";'
content = content.replace(old, new)

# Add notifyDecision call after decision evaluation
# Find the section where decision is logged and add notification
old = '''// Decision Engine evaluation
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

          // Telegram notification with full decision'''

new = '''// Decision Engine evaluation
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

          // Send Telegram notification for ALL decisions (EXECUTE/ALERT/REJECT)
          try {
            notifyDecision(r.underlying, decision.decision, decision.confidence, decision.strengths, decision.weaknesses, decision.summary);
          } catch (e) {
            this.log("error", `[TELEGRAM] Failed to send decision notification: ${e.message}`);
          }

          // Telegram notification'''

content = content.replace(old, new)

with open("engine.ts", "w") as f:
    f.write(content)

print("OK - Added notifyDecision import and call")
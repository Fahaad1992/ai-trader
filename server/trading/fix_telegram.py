import re

with open("engine.ts", "r") as f:
    content = f.read()

# Find and replace the notify section - make sure notifyDecision is called for ALL signals
old_pattern = '''// Telegram notification with full decision
          try {
            notifyTradeEntry('''

new_pattern = '''// ALWAYS send Telegram notification for EVERY signal (EXECUTE/ALERT/REJECT)
          try {
            notifyDecision(
              r.underlying,
              decision.decision,
              decision.confidence,
              decision.strengths,
              decision.weaknesses,
              decision.summary
            );
          } catch (e) {
            this.log("error", `[TELEGRAM ERROR] ${e.message}`);
          }

          // OLD notification (keep for trade entry only)
          /* try {
            notifyTradeEntry('''

content = content.replace(old_pattern, new_pattern)

# Also replace the closing of the try block
old_close = '''            );
          } catch {} // notify

          // Only proceed'''

new_close = '''            ); 
          } catch {} // notify */

          // Only proceed'''

content = content.replace(old_close, new_close)

with open("engine.ts", "w") as f:
    f.write(content)

print("Fixed: notifyDecision now called for ALL signals")
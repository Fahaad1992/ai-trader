import re

with open("engine.ts", "r") as f:
    content = f.read()

# 1. Add notifyBotStart after startup message  
pattern1 = 'this.log("info", `بدء التشغيل'
replacement1 = '''this.log("info", `بدء التشغيل`);
    try { notifyBotStart(this.config.mode, this.config.activeStrategy); } catch {} // notify'''
content = content.replace(pattern1, replacement1)

# 2. Add notifyTradeEntry after openTrade call
pattern2 = 'await this.openTrade(r.underlying, r.confirmations, validated);'
replacement2 = '''try { notifyTradeEntry(r.underlying, validated.type, validated.optBid, validated.optStrike); } catch {} // notify
            await this.openTrade(r.underlying, r.confirmations, validated);'''
content = content.replace(pattern2, replacement2)

# 3. Add notifyTradeExit for trailing-stop
pattern3 = 'await this.closeTrade(t, "trailing-stop");'
replacement3 = '''try { notifyTradeExit(t.symbol, "trailing-stop", pnl); } catch {} // notify
        await this.closeTrade(t, "trailing-stop");'''
content = content.replace(pattern3, replacement3)

# 4. Add notifyTradeExit for stop-loss  
pattern4 = 'await this.closeTrade(t, "stop-loss");'
replacement4 = '''try { notifyTradeExit(t.symbol, "stop-loss", pnl); } catch {} // notify
        await this.closeTrade(t, "stop-loss");'''
content = content.replace(pattern4, replacement4)

# 5. Add notifyTradeRejected for option rejection
pattern5 = 'this.log("warn", `[OPTION_REJECTED]'
replacement5 = '''try { notifyTradeRejected(underlying, "no contract"); } catch {} // notify
        this.log("warn", `[OPTION_REJECTED]'''
content = content.replace(pattern5, replacement5)

with open("engine.ts", "w") as f:
    f.write(content)

print("OK - All notifications added")
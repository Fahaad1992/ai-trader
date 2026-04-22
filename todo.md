# AI Trader Bot - Todo

## Core Features
- [x] Dashboard with dark theme
- [x] Sidebar navigation
- [x] Trading Engine with strategies (Milking, Hold, Zero Hero)
- [x] Paper/Live mode switching
- [x] Risk Management system
- [x] Confirmations 6/8 system
- [x] Filters (News, VIX, Time, Volatility)
- [x] Settings page with all parameters
- [x] Open Trades page
- [x] Trade History page
- [x] Reports page
- [x] Bot Logs page
- [x] Demo mode working

## Hybrid Market Data (Real Stock + BS Options)
- [x] Polygon for SPY/QQQ/VIX only (3 API calls total)
- [x] Black-Scholes for all option pricing (no API)
- [x] Accurate Delta near ATM
- [x] Weekly expiry matching
- [x] Realistic bid/ask spread simulation
- [x] Single contract selection per trade
- [x] PnL based on real stock movement
- [x] Speed + Stability focus
- [x] Rebuild and test bot with hybrid data

## Deployment Fix
- [x] Fix build script to produce dist/index.js
- [x] Ensure production mode works correctly

## Realistic Trading System (No Fake Data)
- [ ] Strict US market hours enforcement (9:30 AM - 4:00 PM ET only)
- [ ] Real options data only (bid/ask, Greeks, IV, volume, OI) - no BS simulation
- [ ] If real data unavailable → bot stays idle, no trades
- [ ] Realistic bid/ask fills with spread and slippage
- [ ] PAPER = real data + simulated execution, LIVE = real broker only
- [ ] Remove misleading labels if no real broker connected
- [ ] Show data source, timestamp, real-time vs delayed clearly
- [ ] Safety: no trades if market closed, data missing, or conditions unconfirmed

## Arabic UI + RTL
- [x] Full Arabic translation of all UI text
- [x] RTL layout with sidebar on right
- [x] Professional Saudi-friendly Arabic
- [x] Color coding: green=profit, red=loss, yellow=warning, purple=signal
- [x] Keep numbers, $, % in standard format

## ضبط التنفيذ (بدون features جديدة)
- [x] Max open positions = 1 فقط
- [x] تأكيدات 7/8 مطلوبة (minConfirmations = 7)
- [x] Delta range: 0.40 – 0.60 (ATM أو قريب)
- [x] طباعة سبب الدخول مفصل (كم تأكيد + أي مؤشرات)
- [x] طباعة سبب الخروج واضح (TP/SL/Trailing)
- [x] تخفيف ضغط API: caching أطول + scan interval أبطأ
- [x] تنفيذ فوري بدون تأخير
- [x] استقرار: لا errors ولا تعليق

## تعديل التأكيدات
- [x] تغيير minConfirmations إلى 7 (7/8) موحد لكل الاستراتيجيات

## إصلاح البيانات - intraday بدل daily close
- [x] استخدام YahooFinance intraday 5min بدل /prev (إغلاق أمس)
- [x] VWAP محسوب من شموع اليوم
- [x] RSI/MACD من شموع intraday حقيقية
- [x] توضيح إذا البيانات delayed أو real-time
- [x] لا تستخدم daily close أبداً

## إصلاح الواجهة (بدون تغيير منطق التداول)
- [x] إصلاح P&L: فصل مغلق عن مفتوح + تحديث كل 2 ثانية
- [x] تبسيط الداشبورد: رأس المال + ربح مفتوح + ربح مغلق + صفقة حالية فقط
- [x] تعريب كامل 100% RTL بدون خلط إنجليزي

## إصلاح فشل تحميل البيانات
- [x] إصلاح fallback: Yahoo Finance مباشرة إذا Polygon فشل
- [x] أسعار SPY/QQQ/TSLA تظهر مباشرة بدون أخطاء
- [x] لا يظهر "فشل تحميل البيانات" أبداً
- [x] بيانات intraday فقط (لا daily close)

## تحسين شروط الدخول
- [x] محافظ = 6/8، هجومي = 5/8
- [x] weight للإشارات (EMA+VWAP أهم من RSI والشمعة)
- [x] ADX قوي + اتجاه واضح = دخول حتى لو 5/8

## إصلاح retry تحميل البيانات
- [x] retry 3 مرات مع 2-3 ثواني بين كل محاولة
- [x] لا يعتبرها فشل مباشر
- [x] لا يبدأ التداول إلا بعد نجاح التحميل

## إصلاح منطق التشغيل والاتصال
- [x] البوت يبقى شغال ولا يطفّي نفسه عند فشل البيانات
- [x] ينتظر ويعيد المحاولة بدل ما يوقف
- [x] حالات واضحة: تشغيل / انتظار بيانات / متصل / فشل نهائي
- [x] لا يوقف التداول إلا بعد 3 محاولات فاشلة كاملة ثم يعيد المحاولة
- [x] إزالة "غير متصل" و"بيانات قديمة" إلا إذا تحققت فعلاً

## تعديلات المراجعة (5 نقاط فقط)
- [x] توحيد الشروط: محافظ=6/8، هجومي=5/8، إزالة أي 7/8 قديم
- [x] تنظيف منطق الدخول: نمط واحد فقط يتحكم (محافظ أو هجومي)
- [x] تثبيت حالة البيانات: "انتظار بيانات" إذا فشلت، لا إشارات مضللة
- [x] تعديل التسمية: "بيانات حقيقية + تنفيذ ورقي" بدل REAL
- [x] إصلاح تحديث P&L: تحديث كل 1 ثانية بسعر العقد الحالي
## ربط Polygon في مرحلة الدخول
- [x] signal (Yahoo) → validateOptionForEntry (Polygon) → openTrade

## إصلاح authentication في الإنتاج
- [x] استخدام FORGE_KEY في headers إذا SANDBOX_TOKEN فاضي

## Yahoo Finance API مباشر
- [x] استخدام Yahoo Finance API مباشر (query1.finance.yahoo.com) بدل Manus API Proxy

## Paper Trading مطابق للحقيقي
- [x] Polygon للأوبشنز + Yahoo للأسهم (الأفضل للـ free tier)
- [x] منطق IBKR: دخول على ask، خروج على bid
- [x] إضافة slippage بسيط (0.01-0.03)
- [x] رفض الصفقة إذا spread عالي (>15% من mid)
- [x] رفض الصفقة إذا volume ضعيف (<100)
- [x] حساب P&L حقيقي (ask entry / bid exit)

## IBKR Market Data كمصدر أساسي
- [ ] IBKR كمصدر أساسي للأسعار (bid/ask/last real-time)
- [ ] Yahoo كـ fallback للعرض فقط (بدون إشارات)
- [ ] SPX بدل SPY كمؤشر أساسي
- [ ] IBKR Options (SPX/SPXW) بدل Polygon
- [ ] إذا IBKR غير متصل: لا إشارات ولا صفقات (عرض فقط)
- [ ] لا تغيير في engine.ts

## Phase 1 - Security & Database
- [x] Firewall: Secure Port 4001 with UFW (localhost only)
- [x] Verify UFW status and ss output
- [x] Create /root/data directory and install better-sqlite3
- [x] Create server/trading/database.ts with trades, logs, daily_stats tables
- [x] Integrate SQLite with engine.ts (save/load trades, logs)
- [x] Verify SQLite integration working

## Phase 2 - IBKR Historical Data + News Filter
- [x] Task 1: Add reqHistoricalData to ibkr-client.ts
- [x] Task 1: Calculate indicators (RSI, MACD, ADX, EMA, VWAP) from IBKR candles
- [x] Task 1: Yahoo as fallback only when IBKR disconnected
- [x] Task 2: Create news-filter.ts with Economic Calendar API
- [x] Task 2: Block trading 15min before/after high-impact events
- [x] Task 2: Integrate news filter with engine.ts checkFilters
- [x] Task 2: Log block events with name, time, block window
- [x] Verify all working

## Phase 3 - Scan Speed & Realistic Slippage
- [x] Reduce scan cycle to under 2 minutes
- [x] Implement parallel scanning for underlyings
- [x] Replace fixed slippage with spread-based slippage (spread * 0.3)
- [x] Cap slippage to prevent extreme values
- [x] Update tests for new slippage model
- [x] Verify all tests pass (59/59)

## Fix - Deploy Failure (better-sqlite3 native binary)
- [ ] Replace better-sqlite3 with Drizzle/MySQL (project's existing DB)
- [ ] Add trades, logs, daily_stats tables to Drizzle schema
- [ ] Rewrite database.ts to use Drizzle async queries
- [ ] Update engine.ts for async DB calls
- [ ] Remove better-sqlite3 dependency
- [ ] Test and redeploy

## FINAL Dollar-Based Trailing Stop (March 31)
- [x] Remove old fixed TP (50%) from engine.ts
- [x] Remove old percentage-based trailing stop (30%) from engine.ts
- [x] Add getTrailingConfig() with variable distances based on premium
- [x] Add new trade fields: peakPrice, trailingActive, trailingStopPrice, trailingConfig
- [x] Implement new updateTrailingStop() dollar-based exit logic
- [x] Keep initial SL at -30% (before trailing activates only)
- [x] Write unit tests for all 17 trailing stop scenarios (ALL PASSED)
- [x] All existing tests pass
- [x] Deploy to DigitalOcean server
- [x] Verify: IBKR connected, bot running, waiting for market data subscription

## Deployment Fix
- [x] Fix EACCES: permission denied mkdir /root/data - changed to /tmp/data for Lambda

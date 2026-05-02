# SPX Options Architecture — مستند التصميم الكامل

> هذا مستند تصميم فقط. لا يحتوي على كود قابل للتنفيذ.
> لا يتم تطبيق أي شيء بدون موافقة صريحة من المالك.
> كل مرجع لـ MES هو علامة حمراء ويجب تدقيقه.

---

## 0) الهدف

بناء نظام SPX Options مخصص ومنفصل تماماً عن MES Futures.
يستخدم نفس فلسفة التداول (scalping/milking سريع) لكن بمسار أوبشن صحيح:
- CALL للإشارة الصاعدة
- PUT للإشارة الهابطة
- PnL = premium_change × 100 × contracts
- ستوب/هدف/trailing على premium الأوبشن
- لا نقاط MES، لا مضاعف 5، لا FUT/CME

---

## 1) SPX UI / تأثير الواجهة الأمامية

### الملفات المتأثرة:
- `shared/types.ts`
- `src/pages/Dashboard.tsx`
- `src/pages/Trades.tsx`
- `src/pages/Settings.tsx`
- `src/pages/History.tsx`
- `src/pages/Reports.tsx`
- `src/pages/Logs.tsx`
- `src/components/Sidebar.tsx`

### التغييرات المطلوبة:

**`shared/types.ts`:**
- تغيير `TradeRuntimeMode` من `"options" | "futures"` إلى `"options" | "futures" | "spx_options"`
- إضافة `"spx_options"` كقيمة مقبولة في `BotConfig.tradeMode`

**محدد الوضع (Settings.tsx):**
- يجب عرض 3 أوضاع: Options العام، MES Futures، SPX Options
- SPX Options يظهر كخيار منفصل مع إعدادات مخصصة:
  - delta range
  - premium range (min/max)
  - max contracts
  - max spread
  - stop/target/trailing بالـ premium
- لا يظهر إعدادات futures (trailingStopPoints, initialStopPoints) في وضع SPX

**لوحة التحكم (Dashboard.tsx):**
- عندما `tradeMode === "spx_options"`:
  - يظهر "SPX OPTION CALL" أو "SPX OPTION PUT" بدل "MES FUT 202606"
  - يعرض premium entry/stop/target/exit
  - PnL يُحسب كـ premium × 100 × contracts
  - الحالة الفعالة: `SPX_OPTIONS_DRY_RUN` أو `SPX_OPTIONS_LIVE`
  - تحذير إذا البيانات قديمة (dataFresh=false)
  - تحذير إذا spread واسع
  - تحذير إذا حقول مفقودة
  - لا يظهر أي label يحتوي MES

**بطاقات الصفقات (Trades.tsx):**
- الشرط الحالي `tradeMode !== "futures"` يعرض تفاصيل الأوبشن
- يجب إضافة شرط `tradeMode === "spx_options"` لعرض:
  - strike, expiry, right (CALL/PUT)
  - premium entry, premium current, premium stop, premium target
  - PnL = (current - entry) × 100 × contracts
  - delta, spread, IV
- لا يظهر contractMonth أو FUT labels

**التقارير (Reports.tsx, History.tsx):**
- SPX reports تعرض premium-based PnL فقط
- لا multiplier=5، لا نقاط MES

**تحذيرات مطلوبة في الواجهة:**
- "بيانات SPX غير محدثة" إذا dataFresh=false
- "spread واسع — الدخول محظور" إذا spread > الحد
- "delta خارج النطاق" إذا delta غير مقبول
- "وضع SPX Options — DRY_RUN فقط" حتى يتم اعتماد Live

---

## 2) SPX engine path — مسار المحرك

### المبدأ:
مسار تنفيذ منفصل داخل `engine.ts` لـ SPX Options. لا يُعاد استخدام أي منطق MES مباشرة.

### الممنوعات (علامات حمراء):
- ❌ `synthetic OptionQuote` المُنشأ في `validateOptionForEntry` لـ MES
- ❌ سعر MES futures كـ premium
- ❌ `FUTURES_INITIAL_STOP_POINTS` أو `FUTURES_TRAILING_STOP_POINTS`
- ❌ PnL = (exit - entry) × 5 × qty
- ❌ `buildFuturesContract` أو `placeFuturesBracket`
- ❌ `contractMonth=202606`
- ❌ `secType=FUT`

### المطلوب:
```
validateSPXOptionForEntry(underlying: "SPX", confirmations):
  - يجلب SPX index price من IBKR
  - يبحث عن أوبشن CALL أو PUT حسب الإشارة
  - يُفلتر حسب: delta range, premium range, spread max, volume min, DTE
  - يرفض إذا bid/ask مفقود أو spread واسع
  - يرجع OptionQuote حقيقي (ليس synthetic)
  - لا يستخدم Polygon إذا IBKR متصل ويوفر البيانات

openSPXTrade(underlying: "SPX", conf, opt: OptionQuote):
  - يحسب: stopPremium, targetPremium, trailingDistance بناءً على premium
  - sizing: contracts حسب capital / (premium × 100)
  - route: buildOptionContract مع underlying=SPX, secType=OPT
  - يحفظ في DB مع right=CALL/PUT, strike, expiry, premium fields
  - DRY_RUN: يُنشئ simulated trade بدون أمر IBKR
  - LIVE: يستخدم placeBracketOrder مع premium prices

updateSPXTrailingStop(trade, currentPremium):
  - trailing على premium الأوبشن
  - activation: بعد premium يتحرك بمقدار معين لصالح الصفقة
  - distance: مسافة trailing بالـ $premium
  - breakeven: نقل الستوب لسعر الدخول + spread cost

closeSPXTrade(trade, exitPremium, reason):
  - PnL = (exitPremium - entryPremium) × 100 × contracts
  - يحفظ: exit_premium, close_reason, exit_reason, pnl, points
  - Telegram exit message
```

### SPX stop/target profile:
```
SPX_OPTIONS_STOP_PROFILE:
  initialStopDistance: $X.XX (premium dollars, not index points)
  trailingStopDistance: $X.XX (premium dollars)
  targetDistance: $X.XX (premium dollars)
  breakEvenActivation: $X.XX (premium must move this much before BE)
  
  ملاحظة: القيم الدقيقة يحددها المالك. التصميم يدعم أي قيمة.
```

---

## 3) SPX live data requirements — متطلبات البيانات الحية

### البيانات المطلوبة:

```
SPX index price:
  المصدر: IBKR (secType=IND, exchange=CBOE, symbol=SPX)
  الموجود: getSPXPrice() في ibkr-client.ts
  الحالة: يعمل إذا IBKR متصل ومشترك

SPX options chain:
  المصدر الأول: IBKR (reqContractDetails + reqMktData لعقد OPT محدد)
  المصدر الثاني: Polygon API (fetchOptionsChain موجود)
  المطلوب لكل عقد:
    - bid: سعر الشراء
    - ask: سعر البيع
    - mid: (bid + ask) / 2
    - last: آخر سعر تنفيذ
    - delta: حساسية السعر للتغير
    - gamma, theta, vega: Greeks إضافية
    - iv: التقلب الضمني
    - volume: حجم التداول اليوم
    - openInterest: العقود المفتوحة
    - timestamp: وقت آخر تحديث
    - dte: أيام حتى الانتهاء

spread calculation:
  spread = ask - bid
  spread_percent = spread / mid × 100
  max_allowed_spread: يحدده المالك (مثال: $0.50 أو 5%)

data freshness:
  SPX_DATA_FRESH_TTL: 120 ثانية (قابل للتعديل)
  إذا timestamp > TTL: dataFresh=false → block trade
  إذا bid=0 أو ask=0: block trade
  إذا mid=0: block trade

stale data blocker:
  SPX_STALE_DATA_BLOCK: يمنع الدخول إذا:
    - SPX index price غير متاح
    - option bid/ask غير محدث
    - timestamp أقدم من TTL
    - delta=0 أو NaN
```

---

## 4) IBKR / market data integration — تكامل البيانات

### SPX index:
```
contract:
  symbol: SPX
  secType: IND
  exchange: CBOE
  currency: USD
  
الموجود في ibkr-client.ts سطر 612-614:
  if (ticker === "SPX") → secType=IND, exchange=CBOE
  getSPXPrice() موجود سطر 1462
```

### SPX options:
```
contract:
  symbol: SPX
  secType: OPT
  exchange: SMART (يوجه IBKR تلقائياً لـ CBOE/ISE/etc)
  currency: USD
  right: C أو P
  strike: سعر التنفيذ
  lastTradeDateOrContractMonth: تاريخ الانتهاء (YYYYMMDD)
  multiplier: 100
  
الموجود: buildOptionContract في ibkr-client.ts سطر 1016-1032
  يبني OPT/SMART/USD/multiplier=100
  يعمل لأي underlying بما فيه SPX
  
ملاحظة: SPX options هي European style (تُنفذ عند الانتهاء فقط)
  يجب التأكد أن IBKR يتعامل معها صحيحاً عبر SMART routing
```

### subscriptions المطلوبة:
```
- US Securities Snapshot and Futures Value Bundle (للـ SPX index)
- OPRA (Options Price Reporting Authority) أو ما يعادله في Derayah/IBKR
- إذا SPX options data غير متاح: Polygon API كـ fallback
```

### إذا bid/ask غير متاح:
```
- لا يتم الدخول
- يُسجل: [SPX_DATA_BLOCK] bid/ask unavailable
- يُبلغ عبر Telegram: "بيانات الأوبشن غير متاحة — الدخول محظور"
```

---

## 5) Telegram messages — رسائل تيليجرام

### رسالة الدخول SPX:
```
✅ صفقة SPX Options

📌 النوع: SPX OPTION CALL  (أو PUT)
📅 انتهاء العقد: 2026-05-09
💰 سعر التنفيذ: $5,700
📦 عدد العقود: 1
💵 premium الدخول: $12.50
🛡️ premium الستوب: $10.00
🎯 premium الهدف: $16.00
📊 Delta: 0.45
📈 Spread: $0.30 (2.4%)
⚙️ الوضع: DRY_RUN

🧾 القرار: تنفيذ
📊 الثقة: 75%
```

### رسالة الخروج SPX:
```
🔴 إغلاق صفقة SPX Options  (أو 🟢)

📌 العقد: SPX OPTION CALL $5,700 2026-05-09
📋 سبب الخروج: trailing_stop
⏰ مدة الصفقة: 12د
💵 premium الدخول: $12.50
💵 premium الخروج: $15.80
🟢 النتيجة: +$330.00 (+26.4%)
📊 PnL = ($15.80 - $12.50) × 100 × 1 = +$330.00
🏷️ تصنيف: TRAILING_STOP
```

### قواعد صارمة:
- ❌ لا يظهر "MES" في أي رسالة SPX
- ❌ لا يظهر "FUT 202606" في أي رسالة SPX
- ❌ لا يظهر "نقاط × 5" في أي رسالة SPX
- ✅ كل الرسائل بالعربية
- ✅ PnL واضح بصيغة premium × 100 × contracts

---

## 6) Database / reporting — قاعدة البيانات والتقارير

### أعمدة DB الحالية القابلة للاستخدام:
```
موجود ويصلح:
  id, mode, strategy, underlying, symbol, contract_type, strike, expiry,
  entry_premium, exit_premium, quantity, delta, pnl, pnl_percent, status,
  open_reason, close_reason, opened_at, closed_at, data_source,
  side, mode_effective, trade_mode, sec_type,
  stop_price, target_price, signal_id, confidence,
  confirmations_passed, confirmations_total,
  order_sent_to_ibkr, ibkr_order_id, perm_id,
  slippage, requested_size, final_size
```

### أعمدة جديدة مطلوبة (NULL-safe migration):
```
premium_stop REAL        — ستوب premium عند الدخول
premium_target REAL      — هدف premium عند الدخول
iv REAL                  — implied volatility
bid REAL                 — سعر الشراء عند الدخول
ask REAL                 — سعر البيع عند الدخول
mid REAL                 — (bid+ask)/2 عند الدخول
spread REAL              — ask - bid عند الدخول
right TEXT               — CALL أو PUT (صريح، ليس مُستنتج)
```

### قيم SPX في DB:
```
underlying = "SPX"
sec_type = "OPT"
trade_mode = "spx_options"
contract_type = "call" أو "put"
right = "CALL" أو "PUT"
strike = سعر التنفيذ
expiry = تاريخ الانتهاء
entry_premium = premium عند الدخول
exit_premium = premium عند الخروج
premium_stop = ستوب premium
premium_target = هدف premium
pnl = (exit_premium - entry_premium) × 100 × quantity
multiplier ضمني = 100 (ليس 5)

ممنوع:
  ❌ contract_month = 202606
  ❌ multiplier = 5
  ❌ sec_type = FUT
  ❌ symbol = "MES FUT 202606"
```

### التقرير اليومي SPX:
```
npm run report:trades:today

يجب أن يعرض عند tradeMode=spx_options:
  total SPX trades
  CALL count
  PUT count
  contracts per trade
  winners / losers
  gross profit (premium-based)
  gross loss (premium-based)
  net pnl
  biggest win (premium × 100 × qty)
  biggest loss
  avg win / avg loss
  win rate
  stop-loss count
  trailing-stop count
  target count
  overlap YES/NO
  any contracts > configured max YES/NO
  any real orders YES/NO
  spread avg
  delta avg
  unknown/null fields count

ممنوع:
  ❌ PnL بصيغة نقاط × 5
  ❌ أي إشارة لـ MES
```

---

## 7) Route isolation audit — تدقيق فصل المسارات

### MES leftovers audit — تدقيق بقايا MES

لكل ملف يتأثر بـ SPX، يجب فحص كل مرجع MES وتحديد: مسموح / ممنوع / يحتاج حارس.

#### `engine.ts` (~3000 سطر):
```
MES references found:
  - FUTURES_ASSET_TYPE = "MES" → ممنوع في SPX path
  - FUTURES_INITIAL_STOP_POINTS → ممنوع في SPX path
  - FUTURES_TRAILING_STOP_POINTS → ممنوع في SPX path
  - const DRY_RUN = true (4 مواقع) → خطر مشترك، SPX يجب أن يستخدم نفس آلية DRY_RUN
  - synthetic OptionQuote for MES → ممنوع في SPX path
  - isFuturesMode() checks → SPX يضيف isSPXOptionsMode() checks
  - getAssetStopProfile("SPX") → موجود كـ index، يحتاج profile مخصص للـ premium
  - UNDERLYINGS list → SPX غير مضمّن حالياً، يحتاج إضافة أو مسار مستقل
  - PnL formula سطر 945: (currentPremium - entryPremium) × quantity × 100 → صحيح للأوبشن ✅
  - PnL formula futures: (exit - entry) × 5 × qty → ممنوع في SPX

كيف يتجنب SPX المسار:
  - isSPXOptionsMode() يُفحص قبل أي عملية
  - validateSPXOptionForEntry منفصل عن validateOptionForEntry
  - openSPXTrade منفصل عن openTrade
  - لا يدخل أي branch يحتوي isFuturesMode()
```

#### `trade-mode.ts`:
```
MES references found:
  - TRADE_MODE = "futures" | "options" → يحتاج إضافة "spx_options"
  - isFuturesMode() → لا تتأثر
  - isOptionsMode() → لا تتأثر (SPX يستخدم isSPXOptionsMode())

المطلوب:
  + export type RuntimeTradeMode = "options" | "futures" | "spx_options"
  + export function isSPXOptionsMode(): boolean { return TRADE_MODE === "spx_options" }
  + export function getSPXOptionsRuntimeGuardMessage(scope: string): string
  + حارس: assertSPXOptionsRuntimeAllowed(scope)
```

#### `ibkr-client.ts`:
```
MES references found:
  - buildFuturesContract (سطر 863) → ممنوع في SPX
  - placeFuturesBracket (سطر 1095+) → ممنوع في SPX
  - FUT_ROUTE markers → ممنوع في SPX
  - FUTURES_CONTRACT_PREVIEW → ممنوع في SPX
  - OPT_BLOCKED_IN_FUTURES (سطر 1178) → مسموح (يحمي من الاختلاط)
  - buildOptionContract (سطر 1016) → مسموح ✅ يُستخدم لـ SPX OPT
  - placeBracketOrder (سطر 1168) → مسموح ✅ يُستخدم لـ SPX OPT bracket
  - placeOrder (سطر 1034) → مسموح ✅
  - getSPXPrice (سطر 1462) → مسموح ✅
  - SPX contract handling (سطر 612-614, 688-690) → مسموح ✅

المطلوب:
  + حارس جديد: FUT_BLOCKED_IN_SPX_OPTIONS
    في placeFuturesBracket وbuildFuturesContract:
    if (isSPXOptionsMode()) → reject with FUT_BLOCKED_IN_SPX_OPTIONS
```

#### `market-data.ts`:
```
MES references found:
  - FUTURES_UNDERLYING = "MES" → لا يتأثر (يُستخدم فقط في futures mode)
  - isFuturesMode() checks → لا تتأثر
  - mes-specific ticker lists → لا تتأثر

مسموح للاستخدام في SPX:
  - OptionQuote interface ✅
  - fetchOptionsChain ✅
  - findOption ✅ (يحتاج تمرير underlying="SPX")
  - findOptionIBKR ✅
  - getPrice("SPX") ✅

المطلوب:
  + SPX data freshness check
  + SPX-specific ticker subscription في loadPrices
  + isSPXOptionsMode() → subscribe SPX + options data
```

#### `notify.ts`:
```
MES references found:
  - isFuturesSide() → يُستخدم لتحديد MES LONG/SHORT labels
  - "MES FUT 202606" contract label → ممنوع في SPX
  - _futContractMonth = "202606" → ممنوع في SPX

المطلوب:
  + isSPXOptionsSide() check
  + SPX-specific entry formatter: يعرض "SPX OPTION CALL/PUT"
  + SPX-specific exit formatter: يعرض premium PnL
  + لا يمر عبر isFuturesSide() branch
```

#### `database.ts`:
```
MES references found:
  - contract_month column → لا يُستخدم في SPX (يبقى NULL)
  - sec_type column → يُملأ بـ "OPT" لـ SPX

المطلوب:
  + أعمدة جديدة: premium_stop, premium_target, iv, bid, ask, mid, spread, right
  + migration NULL-safe
```

#### `report-today.ts`:
```
MES references found:
  - PM2 log scanning → لا يتأثر
  - PnL calculations → يحتاج فحص أنها premium-based لـ SPX

المطلوب:
  + SPX section في التقرير إذا tradeMode=spx_options
  + premium-based PnL فقط
  + لا multiplier=5
```

#### `decision-engine.ts`:
```
MES references found:
  - لا مراجع MES مباشرة
  - evaluateSignal يستقبل OptionQuote → يعمل مع SPX ✅

المطلوب:
  - لا تغييرات (المنطق عام وقابل لإعادة الاستخدام)
```

#### Frontend files:
```
Dashboard.tsx:
  - tradeMode !== "futures" checks → يحتاج إضافة "spx_options" handling
  - MES/futures labels → لا تظهر في SPX mode

Trades.tsx:
  - tradeMode !== "futures" checks → يحتاج إضافة "spx_options" handling
  - premium display → يعمل ✅

Settings.tsx:
  - isFuturesMode check → يحتاج إضافة isSPXOptionsMode
  - SPX-specific settings section

History.tsx / Reports.tsx:
  - يحتاج فلترة حسب tradeMode
```

---

## 8) Frontend / API endpoints — واجهة برمجية وعرض

### API endpoints الحالية (لا تحتاج تغيير كبير):
```
GET /api/bot/status → يضاف tradeMode: "spx_options" + SPX-specific fields
GET /api/config → يضاف SPX options config section
PUT /api/config → يقبل SPX options settings
GET /api/trades/open → يعمل (يعرض أي صفقة مفتوحة)
GET /api/trades/closed → يعمل
GET /api/market/status → يضاف SPX data freshness + subscription status
GET /api/stats/overall → يحتاج premium-based PnL لـ SPX
GET /api/stats/daily → يحتاج premium-based PnL لـ SPX
```

### API endpoints جديدة (اختيارية):
```
GET /api/spx/option-preview → يعرض أفضل CALL/PUT متاح حالياً
  - strike, expiry, bid, ask, mid, spread, delta, iv, dte
  - freshness indicator
  
GET /api/spx/blockers → يعرض أسباب عدم التداول حالياً
  - data stale
  - spread too wide
  - delta out of range
  - market closed
  - daily loss limit
  - IBKR not connected
```

### عرض الواجهة:
```
SPX mode status card:
  - وضع SPX Options: DRY_RUN / LIVE
  - SPX index price: $X,XXX.XX
  - آخر تحديث: XX:XX:XX
  - IBKR: متصل / غير متصل
  - بيانات الأوبشن: محدثة / قديمة

SPX selected option preview card:
  - أفضل CALL: strike $X,XXX | exp XX-XX | premium $XX.XX | delta 0.XX | spread $X.XX
  - أفضل PUT: strike $X,XXX | exp XX-XX | premium $XX.XX | delta 0.XX | spread $X.XX

SPX open trade card:
  - SPX OPTION CALL/PUT
  - strike, expiry
  - entry premium → current premium
  - PnL = premium_change × 100 × contracts
  - stop premium, target premium
  - trailing status

SPX daily PnL:
  - premium-based فقط
  - لا نقاط MES

تحذير صريح:
  - إذا SPX mode يحاول استخدام MES data → "تحذير: بيانات MES لا تنطبق على SPX Options"
```

---

## 9) Hard blockers — حالات الحظر الإلزامية

### يجب حظر الصفقة إذا:
```
1.  option bid = 0 أو null أو missing
2.  option ask = 0 أو null أو missing
3.  spread > max_allowed_spread (قابل للتعديل)
4.  delta = 0 أو NaN أو خارج النطاق المحدد
5.  premium = 0 أو null
6.  data timestamp > SPX_DATA_FRESH_TTL
7.  strike missing أو null
8.  expiry missing أو null
9.  route يحاول FUT → FUT_BLOCKED_IN_SPX_OPTIONS
10. route يستخدم MES price كـ premium → SPX_PREMIUM_SOURCE_BLOCK
11. PnL formula = points × 5 → SPX_PNL_FORMULA_BLOCK
12. Telegram/DB يعرض MES fields → SPX_LABEL_CONTAMINATION
13. effective mode غير واضح (ليس SPX_OPTIONS_DRY_RUN أو SPX_OPTIONS_LIVE)
14. IBKR غير متصل + Polygon غير متاح = لا بيانات
15. SPX index price غير متاح
16. volume = 0 على العقد المحدد
17. IV = 0 أو غير متاح (تحذير، ليس حظر كامل)

كل حظر يُسجل في:
  - DB: blocked_reason
  - Log: [SPX_TRADE_BLOCKED] reason
  - Telegram: إشعار رفض مع السبب
```

---

## 10) Acceptance criteria — معايير القبول

### SPX design لا يُقبل إلا إذا أثبت:

```
1.  صفر labels MES في واجهة SPX / Telegram / التقارير
    - لا "MES"
    - لا "FUT 202606"
    - لا "contractMonth"
    - لا "multiplier=5"
    - لا "نقاط × 5"

2.  صفر MES futures PnL formula في SPX
    - PnL = premium_change × 100 × contracts فقط

3.  صفر MES futures route في SPX
    - لا buildFuturesContract
    - لا placeFuturesBracket
    - لا FUT_ROUTE
    - لا secType=FUT
    - لا exchange=CME for futures

4.  SPX premium PnL فقط
    - DB: entry_premium, exit_premium, pnl = premium-based
    - Telegram: PnL بالـ premium
    - Report: PnL بالـ premium

5.  SPX option contract preview صحيح
    - symbol=SPX, secType=OPT, exchange=SMART
    - right=CALL/PUT, strike, expiry, multiplier=100

6.  SPX DRY_RUN entry/exit يمكن تقريره بدون تخمين
    - كل حقل موجود في DB
    - side صريح (CALL/PUT)
    - premium_stop, premium_target موجودان
    - exit_reason صريح

7.  أي مرجع MES موثق تحت "MES leftovers audit"
    - لكل ملف: المرجع + مسموح/ممنوع/محمي بحارس

8.  كل حارس أمان موجود ومُختبر:
    - FUT_BLOCKED_IN_SPX_OPTIONS
    - OPT_BLOCKED_IN_FUTURES (موجود)
    - SPX_SPREAD_FILTER
    - SPX_DELTA_FILTER
    - SPX_STALE_DATA_BLOCK
    - SPX_MISSING_FIELD_BLOCK
    - SPX_MAX_PREMIUM_CAP
    - SPX_MAX_CONTRACTS_CAP
    - SPX_NO_AVERAGING_DOWN
    - SPX_SINGLE_POSITION
```

---

## 11) ترتيب التنفيذ المقترح

```
المرحلة 1: البنية التحتية (DRY_RUN فقط)
  1.1  trade-mode.ts: إضافة "spx_options" + isSPXOptionsMode()
  1.2  ibkr-client.ts: حارس FUT_BLOCKED_IN_SPX_OPTIONS
  1.3  database.ts: أعمدة جديدة (NULL-safe migration)
  1.4  shared/types.ts: تحديث TradeRuntimeMode

المرحلة 2: المحرك (DRY_RUN فقط)
  2.1  engine.ts: validateSPXOptionForEntry
  2.2  engine.ts: openSPXTrade
  2.3  engine.ts: updateSPXTrailingStop
  2.4  engine.ts: closeSPXTrade
  2.5  engine.ts: SPX stop/target/trailing profile

المرحلة 3: الإبلاغ (DRY_RUN فقط)
  3.1  notify.ts: SPX Telegram formatters
  3.2  report-today.ts: SPX daily report section

المرحلة 4: الواجهة
  4.1  Settings.tsx: SPX options config
  4.2  Dashboard.tsx: SPX mode display
  4.3  Trades.tsx: SPX trade cards
  4.4  History/Reports: SPX premium-based display

المرحلة 5: التحقق
  5.1  DRY_RUN test: entry + exit + PnL + DB + Telegram
  5.2  MES leftovers audit: تأكيد صفر تسريب
  5.3  Route guard tests
  5.4  Daily report test

كل مرحلة = مهمة منفصلة + تقرير + موافقة المالك.
لا ينتقل لمرحلة تالية بدون اعتماد.
```

---

## 12) ملاحظات نهائية

```
هذا نظام تداول/مخاطر.

كل تغيير في SPX يجب أن يجيب:
  هل يمكن أن يُرسل أمر حقيقي؟
  هل يمكن أن يؤثر على IBKR؟
  هل يمكن أن يغير margin/risk؟
  هل يمكن أن يخلط SPX مع MES؟
  هل يمكن أن يخفي CALL/PUT/contracts؟
  هل يمكن أن يخلط DRY_RUN مع LIVE؟

إذا نعم أو غير واضح:
  توقف → أبلغ → اسأل المالك
```

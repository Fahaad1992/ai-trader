# Options Reintroduction Plan

هذا الملف هو **مرجع استرجاع** لمسار الأوبشن في مشروع **ai-trader** قبل تنفيذ أي حذف فعلي. الغرض منه ليس الدفاع عن بقاء الأوبشن في المسار الحالي، بل **توثيق ما كان موجودًا فعليًا** وما الذي يجب الاحتفاظ بمعرفته حتى يمكن إعادة بناء دعم الأوبشن لاحقًا بطريقة نظيفة ومعزولة. يعتمد هذا المستند على معاينة مباشرة لنسخة المشروع المنشورة على **Server 1**، مع الاستناد إلى الملفات الفعلية ومساراتها وخطوطها التقريبية داخل الشفرة الحالية [1] [2] [3] [4] [5] [6] [7] [8] [9] [10] [11] [13] [14].

## 1. Current removal scope

نطاق الإزالة المعتمد الآن يجب أن يركّز على **إخراج الأوبشن بالكامل من المسار التشغيلي الحالي** بدون المساس بمسار **futures** النشط. البنية الحالية ما زالت تحمل بقايا أوبشن في طبقات **HTTP endpoints**، و**market data**، و**execution orchestration**، و**shared types**، و**database schema**، إضافة إلى بقايا مزوّدات خارجية مثل **Polygon** و**tastytrade** [1] [2] [3] [5] [6] [7] [8] [9] [10] [11] [14].

| Scope | What exists now | Planned removal now | Evidence |
|---|---|---|---|
| Files: primary runtime | `server/trading/market-data.ts`, `server/trading/engine.ts`, `server/trading/ibkr-client.ts`, `server/index.ts`, `shared/types.ts`, `server/trading/database.ts`, `server/trading/trade-mode.ts` | إزالة أو تعطيل كل الفروع والدوال والأنواع التي تخص الأوبشن فقط، مع إبقاء ما يخدم futures وIBKR live | [1] [2] [3] [4] [7] [8] [9] [14] |
| Files: provider remnants | `server/trading/tastytrade-account.ts`, `server/trading/mes-market-feed.ts` | إزالة الملفات أو فصلها تمامًا إذا لم تعد مطلوبة لمسار futures الحالي | [5] [6] [14] |
| Endpoints | `/api/ibkr/spy-chain` في `server/index.ts` ويستدعي `ibkr.getOptionChain("SPY", "call", 0, 0, "")` تقريبًا عند السطور 75–80 | إزالة endpoint التشخيص الخاص بالسلسلة الاختيارية | [1] [14] |
| Env vars | `POLYGON_API_KEY`, `TASTYTRADE_API_BASE`, `TASTYTRADE_SESSION_TOKEN`, `TASTYTRADE_ACCOUNT_NUMBER` | إزالة المتغيرات الخاصة بالأوبشن/المزوّدات القديمة بعد اعتماد الحذف | [5] [6] [11] [14] |
| Dependencies | لا توجد حزمة npm مخصّصة لـ Polygon أو tastytrade في `package.json`; التكامل يتم عبر `fetch` وenv vars، بينما تبقى `@stoqey/ib` مطلوبة لمسار IBKR/futures | لا حذف مطلوب على مستوى npm لمجرّد إزالة Polygon/tastytrade؛ الحذف الفعلي سيكون في الشفرة والمتغيرات فقط، مع الإبقاء على `@stoqey/ib` | [2] [5] [6] [10] |
| Backup artifacts | توجد **41** ملفات backup داخل `server/` | ليست ضمن الحذف التشغيلي الأول، لكنها تحتاج خطة تنظيف مستقلة لاحقًا | [13] |

يجب اعتبار الإزالة المقترحة هنا **إزالة تشغيلية** لا **إزالة تاريخية**؛ أي إن الهدف هو جعل runtime الحالي **futures-only** بلا أي استدعاء latent لمسارات الأوبشن، لا أن نفقد معرفة كيفية عمل الأوبشن سابقًا. لذلك فهذا المستند يجب أن يُحفَظ قبل أي تعديل لاحق [13] [14].

## 2. Previous options architecture

المعمارية السابقة لم تكن وحدة أوبشن مستقلة بالكامل، بل كانت **موزعة عبر عدة ملفات**. كانت طبقة `market-data.ts` مسؤولة عن **جلب السلسلة والـ pricing والـ filtering**، بينما كانت `engine.ts` مسؤولة عن **اختيار العقد وتنفيذ قرار التداول وتحديث الصفقة**، وكانت `ibkr-client.ts` تحمل **دوال مساعدة IBKR**، إلى جانب بقايا ربط tastytrade في الحساب والرموز ومصدر MES القديم [2] [3] [4] [5] [6] [14].

| Layer | Actual behavior in project | Approximate file/lines |
|---|---|---|
| HTTP/API layer | يوجد endpoint مباشر لاختبار Option Chain عبر `/api/ibkr/spy-chain` | `server/index.ts` ~75–80 [1] [14] |
| Decision context | `market-data.ts` يبني `TradingDecisionContext` ويضم `optionDataSource` و`polygonAvailable` و`ibkrConnected` | `server/trading/market-data.ts` ~470+ [2] [14] |
| Option chain source | `fetchOptionsChain()` يستدعي Polygon snapshot endpoint `/v3/snapshot/options/{underlying}` ويحوّل النتائج إلى `OptionQuote[]` | `server/trading/market-data.ts` ~343–417 [2] [14] |
| Option selection | `findOption()` يفلتر حسب expiry window وdelta وpremium والسيولة ثم يختار أفضل عقد | `server/trading/market-data.ts` ~597–688 [2] [14] |
| Option pricing refresh | `getOptionPrice()` يعيد تسعير العقد المفتوح تقريبًا عبر chain narrowed lookup | `server/trading/market-data.ts` ~692+ [2] [14] |
| IBKR options fallback | `findOptionIBKR()` يستدعي `ibkr.getOptionSnapshot()` عندما تكون طبقة IBKR option snapshot متاحة | `server/trading/market-data.ts` ~554–592 [2] [14] |
| Execution orchestration | `engine.ts` يستدعي `market.findOption(...)` ثم لاحقًا يمرر `underlying`, `contractType`, `strike`, `expiry` إلى `ibkr.placeOrder(...)` | `server/trading/engine.ts` ~1469, ~1771 [3] [14] |
| Open trade repricing | الصفقات المفتوحة يتم تحديثها عبر `market.getOptionPrice(...)` | `server/trading/engine.ts` ~822, ~2021 [3] [14] |
| Shared domain model | `Trade` و`BotConfig` و`BotStatus` ما زالت تحتوي حقولًا مهيأة للأوبشن | `shared/types.ts` ~233–330 [8] [13] |
| Runtime mode guard | `trade-mode.ts` لا يزيل منطق الأوبشن، بل يكتفي بتمييز `options|futures` مع `stripOptionFields` عند futures | `server/trading/trade-mode.ts` ~334–410 [9] [13] |

### 2.1 Data flow

كان تدفق البيانات للأوبشن يبدأ من `engine.ts` عند الحاجة إلى عقد قابل للتنفيذ، ثم ينتقل إلى `market-data.ts` حيث يتم بناء `OptionQuote` واختيار المصدر المناسب. في الوضع العملي الظاهر في النسخة الحالية، **السلسلة والتسعير كانا يعتمدان أساسًا على Polygon** عبر `fetchOptionsChain()`، مع وجود مسار `findOptionIBKR()` كخيار IBKR snapshot في بعض الحالات، وليس كوحدة مستقلة كاملة تغطي كل دورة الحياة [2] [3] [14].

> عمليًا، هذا يعني أن منطق الأوبشن كان **مختلطًا** مع منطق data eligibility، وليس معزولًا كموديول مستقل. وهذا أحد أسباب قرار الإزالة من المسار الحالي [2] [3] [9] [14].

### 2.2 Execution flow

من جهة التنفيذ، كان `engine.ts` يحتفظ بخصائص العقد داخل الصفقة نفسها مثل `contractType`, `strike`, `expiry`, `optionTicker`، ثم يستخدم هذه القيم عند محاولة فتح أو إغلاق المركز. في المواضع الظاهرة حاليًا، يوجد استدعاء فعلي إلى `ibkr.placeOrder(underlying, ct, opt.strike, opt.expiry, "SELL", orderQuantity)`، ما يؤكد أن مسار execution لم يكن مستقلاً عن تمثيل العقد الاختياري داخل الصفقة [3] [8] [14].

### 2.3 Option chain, pricing, greeks, and selection

النوع `OptionQuote` في `market-data.ts` يمثل مركز ثقل نموذج الأوبشن؛ فهو يحمل الحقول اللازمة مثل `bid`, `ask`, `mid`, `last`, `volume`, `openInterest`, `delta`, `gamma`, `theta`, `vega`, `iv`, `dte`, و`moneyness`. ثم تقوم `findOption()` بتطبيق فلاتر فعلية على `expiry`, `delta`, `premium`, و`volume`, مع تسجيلات تشخيصية مثل `[OPTION_DIAG]` و`[Options] Found ATM` [2] [14].

| Capability | Where it lived | Notes |
|---|---|---|
| Chain fetch | `fetchOptionsChain()` | Polygon REST snapshot [2] |
| ATM candidate filtering | `findOption()` | expiry + delta + premium + liquidity [2] |
| Single-contract repricing | `getOptionPrice()` | narrow strike/expiry refresh [2] |
| IBKR option snapshot | `findOptionIBKR()` | not the dominant runtime path in current deployed copy [2] |
| Greeks representation | `OptionQuote`, `Trade`, logs/details | spread across `market-data.ts` and `shared/types.ts` [2] [8] |

## 3. External dependencies previously used

المشروع كان يستعمل عدة مزوّدات خارجية بشكل غير متجانس. جزء منها كان **مباشرًا عبر REST**، وجزء عبر **IBKR API**، وجزء بقي كتركة تشغيلية حتى بعد الانتقال إلى futures mode [2] [4] [5] [6] [10] [11] [14].

| Provider | How it was used in this project | Code evidence | Current status |
|---|---|---|---|
| Polygon | جلب option snapshots والسلاسل عبر REST، مع `POLYGON_API_KEY` ومحدد معدل calls | `market-data.ts` (`POLYGON_KEY`, `POLYGON_BASE`, `fetchOptionsChain`) [2] [11] [14] | ما زال موجودًا في الشفرة، لكنه dormant جزئيًا في futures runtime |
| tastytrade | account snapshot وsession/account variables، إضافة إلى ملف `mes-market-feed.ts` بمصدر `tastytrade-dxfeed` | `tastytrade-account.ts`, `mes-market-feed.ts` [5] [6] [11] [14] | بقايا/تركة تشغيلية يجب فصلها عن futures |
| IBKR options | option snapshot / option chain / execution bridge داخل `ibkr-client.ts` و`engine.ts` وendpoint الاختبار | `ibkr-client.ts`, `engine.ts`, `/api/ibkr/spy-chain` [1] [3] [4] [14] | يجب إبقاء IBKR core للفيوتشرز، لكن إزالة فرع options runtime الحالي |

فيما يخص الصلاحيات والاشتراكات، كان مسار Polygon يحتاج **API key فعّال**، ومسار tastytrade يحتاج **session token + account number**، بينما مسار IBKR options يحتاج عمليًا إلى **تعاقدات option قابلة للتنفيذ وبيانات سوق مناسبة لأسعار/سلاسل الأوبشن** حتى يكون ذا فائدة فعلية في runtime [2] [4] [5] [6] [11].

## 4. What would be needed to restore options later

إعادة الأوبشن مستقبلًا لا ينبغي أن تتم عبر التراجع عن حذف عشوائي، بل عبر **إعادة بناء منظمة** انطلاقًا من هذا المستند. الإرجاع سيتطلب استعادة أنواع، وواجهات، وحقول قاعدة بيانات، وبيئة تشغيل، ومسارات API، وربط providers، واختبارات، لا مجرد إعادة بضعة أسطر منطقية [1] [2] [3] [4] [7] [8] [9] [10] [11] [14].

| Area | What must be restored later |
|---|---|
| Files | وحدات equivalent لـ `market-data.ts` option functions، و`engine.ts` option execution path، و`ibkr-client.ts` option helpers، و`server/index.ts` option endpoints، وملفات مزوّدي Polygon/tastytrade إذا تقرر إحياؤها [1] [2] [3] [4] [5] [6] |
| Types | `OptionQuote`، وحقول `Trade` الخاصة بالأوبشن (`optionTicker`, `contractType`, `strike`, `expiry`, `delta`, `gamma`, `theta`, `vega`, `iv`, `volume`, `openInterest`) و`BotConfig.options` وحقول `BotStatus` التي تفصح عن option data source [2] [8] |
| Env vars | `POLYGON_API_KEY`, `TASTYTRADE_API_BASE`, `TASTYTRADE_SESSION_TOKEN`, `TASTYTRADE_ACCOUNT_NUMBER`، وأي feature flag جديد لدعم الأوبشن [5] [6] [11] |
| Endpoints | endpointات تشخيصية أو تشغيلية من نوع `/api/ibkr/spy-chain`، وأي APIs أمامية تحتاج chain/quote/position lifecycle [1] |
| Database fields | `contract_type`, `strike`, `expiry`, `entry_premium`, `exit_premium`, `delta`، وربما إضافة حقول مفقودة مستقبلًا مثل `greeks_snapshot`, `provider`, `quote_timestamp`, `order_metadata` بدل الاعتماد على logs فقط [7] [8] |
| UI/API changes | واجهات config وstatus وtrade history يجب أن تفرّق بوضوح بين futures وoptions، بدل النوع الهجين الحالي |

يجب التنبيه إلى أن **قاعدة البيانات الحالية ليست مهيأة بالكامل كـ options ledger مستقل**. فهي تحمل أعمدة أساسية تكفي لصفقة option مبسطة، لكنها لا تحفظ بالضرورة كل ما يلزم لإعادة بناء سلسلة قرار أوبشن متقدمة مثل source-of-truth للـ greeks أو provider provenance أو multi-leg structure [7] [8].

## 5. Rules for future reintroduction

القواعد التالية إلزامية إذا تقرر إعادة الأوبشن لاحقًا. هذه ليست توصيات تجميلية، بل شروط لمنع عودة الاختلاط الذي أوصل الشفرة إلى الحالة الحالية [2] [3] [8] [9] [14].

| Rule | Required interpretation |
|---|---|
| Options module must be isolated | كل منطق الأوبشن يكون في موديول مستقل، لا داخل `market-data.ts` أو `engine.ts` العامَّين |
| No mixing with futures runtime | futures runtime لا يستورد أي Option types أو Option providers أو Option endpoints افتراضيًا |
| No delayed data | يمنع تشغيل options runtime على delayed quotes أو incomplete greeks |
| Clear feature flag | يجب أن يوجد علم صريح مثل `ENABLE_OPTIONS_RUNTIME=false` أو `TRADING_RUNTIME=futures|options`، لا guard مبعثر فقط [9] |
| Futures mode remains fully independent | يجب أن يستطيع futures mode البناء والتشغيل والاختبار بدون أي ملف أو env خاص بالأوبشن |

صيغة `trade-mode.ts` الحالية مفيدة فقط كطبقة **حراسة وتشذيب outputs**، لكنها ليست معيارًا صالحًا لإعادة إدخال الأوبشن مستقبلًا. فهي اليوم تقول إن `TRADE_MODE` هو `options|futures`، لكن الشفرة الأساسية نفسها ما زالت مشتركة، وتستخدم `stripOptionFields` كحل تصحيحي بعدي بدل الفصل البنيوي من الأصل [9].

## 6. Recommended clean architecture for future options support

المعمارية الموصى بها لاحقًا يجب أن تكون **مستقلة طبقيًا** لا مجرد فروع شرطية داخل ملفات futures الحالية. الخيار الأنظف هو إنشاء مساحة أسماء منفصلة للأوبشن، سواء تحت `server/options/` أو `server/modules/options/`، بحيث تكون حدود الموديول، وحدود المزوّد، وحدود التنفيذ واضحة وقابلة للاختبار [2] [3] [4] [8] [9].

| Boundary | Recommendation |
|---|---|
| Module boundaries | إنشاء وحدات منفصلة مثل `options/types.ts`, `options/providers/polygon.ts`, `options/providers/ibkr-options.ts`, `options/selection.ts`, `options/execution.ts`, `options/routes.ts` |
| Provider boundaries | فصل Polygon عن IBKR وعن أي tastytrade integration عبر interfaces واضحة مثل `OptionChainProvider`, `OptionQuoteProvider`, `OptionExecutionProvider` |
| Execution boundaries | منع `engine.ts` العام من تمرير `strike/expiry/contractType` مباشرة؛ بدل ذلك يستدعي `optionsExecutionService.place(orderIntent)` |
| Database boundaries | إنشاء migration مخصّصة لـ options trades أو جدول/جداول منفصلة إذا عاد الدعم فعليًا؛ وعدم تحميل futures ledger الحالي تعقيدًا إضافيًا |
| API boundaries | أي endpoint خاص بالأوبشن يكون تحت namespace واضح مثل `/api/options/...`، وليس ضمن `/api/ibkr/...` العام |
| Testing plan | unit tests للفلترة والـ pricing adapters، integration tests للـ provider mocks، paper-trading tests، ثم staging live على عقد واحد فقط قبل أي تشغيل كامل |

الموصى به أيضًا هو أن يتم تمثيل الأوبشن داخليًا عبر كيان domain مستقل مثل `OptionContract`, `OptionQuote`, `OptionSelectionRequest`, `OptionExecutionIntent`، بدل الاعتماد على نشر حقول الأوبشن داخل `Trade` العام. وإذا بقي `Trade` مشتركًا، فيجب أن يكون union type واضحًا مثل `FuturesTrade | OptionsTrade` بدل الشكل المرن الحالي الذي يسمح باختلاط الصفات [8] [9].

## What stays for futures runtime

بعد إزالة مسارات الأوبشن، يجب أن يبقى في runtime فقط ما يخدم **التداول الحي على العقود المستقبلية عبر IBKR**. الأدلة الحالية تظهر أن النسخة العاملة في `TRADE_MODE=futures` تعتمد على اشتراك `/MESM6` و`VIX`، وتعرض حالة اتصال ناجحة مع `requestedMarketDataType:"LIVE"` و`marketDataMode:"live"` عندما تكون طبقة IBKR سليمة، حتى لو بقيت بعض مسارات الأوبشن dormant داخل الشفرة [2] [3] [4] [9] [17] [18].

| Component | Why it stays in futures runtime | Constraint after cleanup |
|---|---|---|
| `server/trading/ibkr-client.ts` | هو قلب الاتصال بـ IBKR، ويبني عقد MES، ويشترك في بيانات السوق، ويجلب historical bars، ويصدر أوامر التنفيذ [4] [18] [19] | يبقى **futures-only**؛ أي helpers خاصة بالأوبشن تُزال أو تُفصل لاحقًا |
| `server/trading/market-data.ts` | ما زال مسؤولًا عن تحميل البيانات الدنيا المطلوبة لمسار futures وعن حظر التداول عند غياب بيانات IBKR اللازمة [2] [17] [18] | يحتفظ فقط بمسار MES/VIX وبيانات IBKR الحية/التاريخية |
| `server/trading/engine.ts` | يبقى orchestrator الرئيسي للتشغيل، الصحة، التقييم، التنفيذ، وإخراج الحالة العامة للبوت [3] [17] | يمنع أي استدعاء option selection أو option execution |
| `server/trading/mes-futures-resolver.ts` | يخدم دقة التعامل مع عقد MES الجاري ويُعد جزءًا تخصصيًا من futures path [13] | يبقى دون خلط مع أي naming أو provider legacy |
| `server/trading/database.ts` | التخزين المحلي للصفقات والسجلات والإحصاءات ما زال مطلوبًا لمسار futures [7] | تُحتمل الأعمدة legacy مؤقتًا، لكن لا تُستخدم لإعادة منطق options ضمن runtime |
| `server/trading/trade-mode.ts` | يوفر guard مفيدًا خلال مرحلة الانتقال، ويمنع تسرب بعض حقول الأوبشن إلى مخرجات futures [9] | يبقى مؤقتًا إلى أن يكتمل الفصل البنيوي الكامل |
| `server/trading/news-filter.ts` و`server/trading/notify.ts` | لا توجد أدلة على أنهما مرتبطان جوهريًا بمسار الأوبشن، وهما يخدمان filters والإشعارات العامة للبوت [13] | يستمران دون أي اعتماد على أنواع أو مزوّدات options |
| `server/index.ts` | يبقى shell الخاص بالـ API والـ bot lifecycle [1] [13] | تبقى فقط endpointات futures والعمليات العامة، مع حذف endpointات options لاحقًا |

المعيار هنا ليس "ما يمكن أن يظل موجودًا نظريًا"، بل **ما لا يستطيع futures runtime العمل بدونه**. لذلك فإن أي ملف يظل بعد التنظيف يجب أن تكون له وظيفة مباشرة في: **IBKR live connectivity** أو **MES/VIX market state** أو **risk orchestration** أو **persistence** أو **notifications**، وما عدا ذلك ينبغي إعادة هيكلته أو إخراجه من المسار التشغيلي [2] [3] [4] [7] [9] [17].

## File-by-file decision table

الجدول التالي هو **جدول قرار تنفيذي** يحدد الإجراء المستقبلي المقترح لكل ملف ذي صلة بمرحلة التحويل إلى futures-only. المقصود هنا هو قرار التخطيط، لا تنفيذ الحذف الآن؛ إذ إن القيود الحالية ما زالت تمنع أي حذف أو rebuild قبل الاعتماد اللاحق [1] [2] [3] [4] [5] [6] [7] [8] [9] [13] [15].

| File | Decision | Rationale | Futures runtime consequence |
|---|---|---|---|
| `server/trading/market-data.ts` | **REFACTOR** | يحتوي مسار futures المطلوب، لكنه يضم كذلك `OptionQuote`, `fetchOptionsChain`, `findOption`, `getOptionPrice`, وrate limiter لـ Polygon [2] [13] | يبقى ملفًا مركزيًا بعد تنظيف كل فروع الأوبشن |
| `server/trading/engine.ts` | **REFACTOR** | هو محرك التشغيل الرئيسي، لكنه ما زال يستورد tastytrade snapshot ويحمل فروع execution مرتبطة بالأوبشن [3] [13] | يجب أن يبقى، لكن بعد نزع option execution بالكامل |
| `server/trading/ibkr-client.ts` | **REFACTOR** | مطلوب لمسار الاتصال والتنفيذ والعقود المستقبلية، لكنه ما زال يحتوي helpers لـ option chain/snapshot [4] [13] | يبقى core client الخاص بـ IBKR futures/live |
| `server/index.ts` | **REFACTOR** | يحتوي endpoint عامّة لازمة، وبالمقابل يضم `/api/ibkr/spy-chain` الخاص بالأوبشن [1] [13] | يبقى كواجهة API للبوت بعد إزالة endpoint الأوبشن |
| `shared/types.ts` | **REFACTOR** | النماذج الحالية هجينة بين futures وoptions، ما يسبب اختلاطًا على مستوى النوع والمخرجات [8] [13] | يجب أن تنتهي إلى futures-only أو union types واضحة لاحقًا |
| `server/trading/trade-mode.ts` | **KEEP** | لا ينشئ الفصل البنيوي المطلوب، لكنه guard انتقالي مهم لمسار futures الحالي [9] | يبقى مؤقتًا لحين اكتمال التنظيف البنيوي |
| `server/trading/database.ts` | **KEEP** | التخزين الحالي ما زال يخدم trades/logs/stats المطلوبة للبوت [7] [13] | لا حاجة لتغييره قبل تنظيف runtime نفسه |
| `server/trading/mes-futures-resolver.ts` | **KEEP** | ملف متخصص في futures path ولا توجد أدلة على أنه جزء من options runtime [13] | يجب الاحتفاظ به كما هو |
| `server/trading/news-filter.ts` | **KEEP** | يخدم منطق الفلترة الإخبارية العامة، لا مسار options بحد ذاته [13] | يستمر مع futures runtime |
| `server/trading/notify.ts` | **KEEP** | إشعارات عامة وليست جزءًا خاصًا بالأوبشن [13] | يستمر كما هو |
| `server/trading/tastytrade-account.ts` | **DELETE** | تكامل مزوّد قديم لا يخدم هدف IBKR futures-only، وما زال ظاهرًا فقط كتركة تشغيلية [5] [13] | يجب ألا يبقى ضمن runtime النهائي |
| `server/trading/mes-market-feed.ts` | **DELETE** | مصدر `tastytrade-dxfeed` legacy ولا يتوافق مع مسار IBKR-only المعتمد [6] [13] | ينبغي إخراجه نهائيًا من مسار التشغيل |
| `server/trading/decision-engine.ts` | **REFACTOR** | الجرد الحالي يُظهر اعتمادًا على `OptionQuote`، ما يعني أن الملف ليس futures-pure بعد [13] | يمكن إبقاؤه فقط إذا أزيل الاعتماد على types الخاصة بالأوبشن |
| `.env` | **KEEP** | المستخدم حظر تعديله في هذه المرحلة، كما أنه ليس جزءًا من حذف مسارات الأوبشن الآن [11] | يبقى ثابتًا دون تعديل |
| `package.json` | **KEEP** | لا توجد حزم npm خاصة بـ Polygon/tastytrade تستلزم حذفًا عاجلًا؛ التكامل الحالي يتم بالشفرة وenv vars [10] [13] | لا حاجة لتغييره قبل مرحلة الكود |
| `docs/options-reintroduction-plan.md` | **KEEP** | هذا هو المرجع المعتمد قبل أي حذف | يجب أن يبقى كوثيقة الضبط المرجعي الحالية |
| `server/trading/*.bak*` و`server/trading/backup_*` | **ARCHIVE** | ملفات مرجعية متراكمة وعددها كبير، لكنها ليست runtime production files [13] | لا تُحذف الآن؛ تبقى مرجعًا مؤرشفًا خارج نطاق التنفيذ |

> معنى القرارات هنا دقيق: **KEEP** يعني أن الملف يجب أن يظل في runtime النهائي للفيوتشرز؛ **REFACTOR** يعني أن الملف يبقى لكن بعد تنظيف داخله؛ **DELETE** يعني أنه لا ينبغي أن يبقى في runtime النهائي؛ و**ARCHIVE** يعني أنه لا يدخل في runtime أصلًا لكنه يُحتفَظ به مؤقتًا كمرجع حتى إغلاق مرحلة التحويل [13] [15].

## Live-only runtime data rules

لكي يكون مسار futures فعلاً **live-only**، لا يكفي أن تكون جلسة IBKR متصلة أو أن تكون قيمة `requestedMarketDataType` قد ضُبطت مرة واحدة على `LIVE`. الأدلة الحالية تُظهر أن البوت قد يكون `ibkrConnected=true` بينما تبقى `dataFresh=false` و`stocks={}`، ما يؤكد أن **الاتصال وحده ليس معيار صلاحية للتداول** [17]. كما أن فحوص المكتبة تشير بوضوح إلى مجموعة tick types المتأخرة `66, 67, 68, 72, 73, 75, 76` التي تُعامل كبيانات delayed، مقابل live tick types منفصلة [16].

| Rule | Detection condition | Required behavior |
|---|---|---|
| **`marketDataType=3` forbidden** | إذا كانت حالة الطلب أو الحالة الداخلية تشير إلى delayed market data بدل `LIVE (1)`، أو إذا لم تعد `requestedMarketDataType` مساوية لـ `LIVE` [17] | **HARD BLOCK** فوري: لا scan، لا signal evaluation، لا entry orders، ولا fallback إلى delayed mode |
| **`delayedTickTypes` forbidden** | إذا استقبلت المنظومة أي tick type من المجموعة `66, 67, 68, 72, 73, 75, 76` المصنفة delayed في فحص المكتبة [16] | **HARD BLOCK** فوري، مع وسم الحالة `marketDataMode=delayed` ورفض استخدام هذه القيم في pricing أو indicators |
| **`stale > 2s` forbidden** | إذا تجاوز الفرق بين `Date.now()` و`dataTimestamp` آخر بيانات مطلوبة لـ MES/VIX أكثر من `2000ms`، أو إذا بقيت `dataFresh=false` أثناء وقت السوق المفتوح [17] | **HARD BLOCK** فوري حتى تعود بيانات live fresh؛ ويُمنع أي قرار تداول جديد أو إعادة تسعير تعتمد على feed قديم |

المقصود بعبارة **HARD BLOCK** هنا هو سلوك صارم لا لبس فيه: **لا دخول صفقات جديدة، لا تقييم إشارات جديدة، لا fallback إلى Polygon أو delayed data، ولا استخدام أسعار قديمة في اتخاذ قرار runtime**. يمكن أن تبقى أوامر الحماية المرسلة مسبقًا إلى الوسيط فعّالة من جهة الوسيط نفسه، لكن البوت لا يملك حق اتخاذ قرار جديد اعتمادًا على تغذية متأخرة أو stale [2] [16] [17].

ولكي تبقى هذه القاعدة قابلة للتدقيق لاحقًا، يجب أن تسجّل المنظومة سبب الحظر بصياغة صريحة، مثل `ibkr_delayed_data_forbidden` أو `ibkr_data_stale_gt_2s`، بدل الاكتفاء بعبارات عامة من نوع `waiting`. وهذا مهم خصوصًا لأن السجلات الحالية أظهرت حالات اتصال ناجح مع `marketDataMode:"live"` يقابلها في الوقت نفسه فشل في اكتمال طبقة البيانات الدنيا لـ `MES` و`VIX` [17] [18] [19] [20].

## 7. References (Git commits)

تمت معالجة غياب Git metadata في نسخة `Server 1` المنشورة عبر **تهيئة مستودع Git محلي جديد داخل `/opt/ai-trader`** ثم أخذ **snapshot baseline** قبل أي حذف لمسارات الأوبشن. هذا لا يعيد التاريخ الأصلي للمستودع المصدر، لكنه يوفر **نقطة رجوع محلية قابلة للاستخدام** ووسمًا واضحًا قبل بدء أعمال التنظيف [12] [15].

| Reference | Current value on Server 1 local snapshot |
|---|---|
| Baseline pre-removal commit | `c3d4fa36568363d0d1c10d7ab74f425d1306ae21` |
| Short hash | `c3d4fa3` |
| Tag | `pre-options-removal-20260422` |
| Provenance note | **Local bootstrap snapshot created on Server 1 after `git init`; not original source history** |

> هذه القيمة تمثل **أول snapshot محلي** في بيئة النشر بعد إنشاء `.git` يدويًا، وبالتالي فهي صالحة للـ rollback المحلي ولإنشاء branchات تجريبية قبل الحذف، لكنها **لا تمثل آخر commit تاريخي من المستودع الأصلي** الذي نُشرت منه النسخة الحالية [12] [15].

## Practical restoration checklist

إذا قرر فريق العمل إعادة الأوبشن مستقبلًا، فيجب أن يبدأ من هذه القائمة المختصرة بدل الارتجال. كما يجب التمييز منذ البداية بين **المرجع التاريخي الأصلي** وبين **snapshot Server 1 المحلي** ذي الهاش `c3d4fa36568363d0d1c10d7ab74f425d1306ae21` [15].

| Step | Action |
|---|---|
| 1 | استرجاع commit/tag الصحيح من المستودع الأصلي، لا من نسخة Server 1 المنشورة |
| 2 | إعادة بناء موديول options مستقل، وليس إعادة نسخ الشفرة المختلطة إلى `engine.ts` و`market-data.ts` |
| 3 | إعادة تعريف الأنواع في `shared/types.ts` كاتحادات واضحة أو ملفات منفصلة |
| 4 | إعادة إنشاء env vars والـ provider adapters اللازمة فقط |
| 5 | تصميم schema أو migration صريحة تحفظ metadata الخاصة بالأوبشن بشكل كامل |
| 6 | إضافة endpoints وواجهات UI تحت namespace منفصل |
| 7 | اختبار providers والـ selection والـ execution في paper/staging قبل أي live rollout |

## References

[1]: file:///opt/ai-trader/server/index.ts "server/index.ts"
[2]: file:///opt/ai-trader/server/trading/market-data.ts "server/trading/market-data.ts"
[3]: file:///opt/ai-trader/server/trading/engine.ts "server/trading/engine.ts"
[4]: file:///opt/ai-trader/server/trading/ibkr-client.ts "server/trading/ibkr-client.ts"
[5]: file:///opt/ai-trader/server/trading/tastytrade-account.ts "server/trading/tastytrade-account.ts"
[6]: file:///opt/ai-trader/server/trading/mes-market-feed.ts "server/trading/mes-market-feed.ts"
[7]: file:///opt/ai-trader/server/trading/database.ts "server/trading/database.ts"
[8]: file:///opt/ai-trader/shared/types.ts "shared/types.ts"
[9]: file:///opt/ai-trader/server/trading/trade-mode.ts "server/trading/trade-mode.ts"
[10]: file:///opt/ai-trader/package.json "package.json"
[11]: file:///opt/ai-trader/.env "environment variables"
[12]: file:///home/ubuntu/server1_git_repo_status_check.txt "Server 1 deployed copy Git status check"
[13]: file:///home/ubuntu/server1_inventory_audit_raw.txt "Server 1 inventory audit raw"
[14]: file:///home/ubuntu/server1_options_reference_evidence_raw.txt "Server 1 options reference evidence raw"
[15]: file:///home/ubuntu/server1_git_bootstrap_full_raw.txt "Server 1 local Git bootstrap raw output"
[16]: file:///home/ubuntu/server1_ib_library_probe_raw.txt "IB library delayed and live tick type probe"
[17]: file:///home/ubuntu/server1_engine_start_probe_raw.txt "Server 1 engine start and status probe"
[18]: file:///home/ubuntu/server1_data_layer_probe_stage2_raw.txt "Server 1 data layer probe stage 2"
[19]: file:///home/ubuntu/server1_minimal_hist_tests_raw_local.txt "Server 1 minimal historical tests"
[20]: file:///home/ubuntu/ibkr_market_data_subscription_notes_20260422.txt "IBKR market data subscription notes"

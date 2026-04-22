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

## 7. References (Git commits)

هذا القسم **لا يمكن ملؤه بقيم commit حقيقية من Server 1 نفسه** لأن النسخة المنشورة في `/opt/ai-trader` **لا تحتوي على مجلد `.git` أصلًا**، وبالتالي لا يمكن استخراج `HEAD` أو تاريخ commits أو tags من بيئة النشر الحالية [12]. لذلك تُسجل القيم التالية كـ **حقول واجبة التعبئة من المستودع الأصلي** قبل تنفيذ الحذف النهائي:

| Reference | Current value from Server 1 deployment copy |
|---|---|
| Last commit with options runtime | `UNKNOWN_FROM_SERVER1_NO_GIT_METADATA` |
| Commit that removed options | `NOT_CREATED_YET_IN_DEPLOYED_COPY` |
| Tag | `pre-options-removal-20260422` **(planned tag; must be created in the source repository, not on Server 1 deployment copy)** |

> الإجراء الصحيح قبل أول commit حذف فعلي هو: العودة إلى المستودع الأصلي، أخذ آخر commit ما قبل الإزالة، إنشاء tag باسم `pre-options-removal-20260422`، ثم تسجيل hash فعلي في هذا القسم. نسخة Server 1 الحالية تكفي لتوثيق البنية، لكنها لا تكفي وحدها لتوثيق التاريخ Git [12].

## Practical restoration checklist

إذا قرر فريق العمل إعادة الأوبشن مستقبلًا، فيجب أن يبدأ من هذه القائمة المختصرة بدل الارتجال:

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

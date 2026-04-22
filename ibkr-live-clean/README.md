# IBKR Live Clean Path

هذا المجلد يحتوي مسار IBKR Live النظيف على **Server 1** فقط.

## الهدف

تشغيل **حاوية واحدة فقط** لـ **IB Gateway + IBC** مع **منفذ API واحد فقط**:

- `127.0.0.1:4001 -> container:4001`

ولا يوجد فيه أي `socat` أو أي bridge أو تحويل داخلي غامض.

## الملفات الثابتة

- `config/jts.ini`: إعدادات IB Gateway الثابتة.
- `config/config.ini`: إعدادات IBC الثابتة.
- `scripts/run.sh`: سكربت التشغيل الوحيد داخل الحاوية.
- `Dockerfile`: بناء الصورة النظيفة من مثبت رسمي لـ IB Gateway ونسخة IBC رسمية.

## مجلدات التشغيل على الخادم

- `config/`: ملفات الإعداد الثابتة الواضحة.
- `state/`: حالة JTS وملفات المستخدم بعد تسجيل الدخول.

## خطوات التحقق النهائية

1. `docker ps` يُظهر الحاوية في حالة `Up`.
2. `ss -tlnp | grep 4001` يُظهر listener على الهوست.
3. سجلات الحاوية تحتوي `Login has completed`.
4. سجلات البوت تحتوي `ibkrConnected=true`.
5. تظهر `account values`.
6. تظهر `market data` الخاصة بـ `MES`.

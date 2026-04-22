# بيانات الحسابات والسيرفر - مرجع

> هذا الملف للمرجع فقط. لا تشاركه مع أحد.

---

## 1. Interactive Brokers (IBKR)

| البند | القيمة |
|-------|--------|
| **Username** | fahaad306 |
| **Password** | Ff097531 |
| **نوع الحساب** | Individual Cash Account - IBKR Lite |
| **العملة** | USD (دولار أمريكي) |
| **الاسم** | Fahad M Aldosari |
| **رابط التسجيل** | https://ndcdyn.interactivebrokers.com/registration |
| **الحالة** | مفتوح ومعتمد - غير ممول ($0) |

---

## 2. DigitalOcean (السيرفر)

| البند | القيمة |
|-------|--------|
| **الإيميل** | fahaad1992@outlook.com |
| **الاسم** | Fahad Mohammed |
| **كلمة المرور** | FhD$2026!DigOcn#Srv |
| **رابط الدخول** | https://cloud.digitalocean.com/login |
| **الغرض** | سيرفر لتشغيل IB Gateway + ngrok |

---

## 3. IBKR - بيانات التسجيل الأولية

| البند | القيمة |
|-------|--------|
| **Username (تسجيل)** | fahaad1992 |
| **Password (تسجيل)** | Ff097531 |
| **الإيميل** | fahaad1992@outlook.com |

---

## 4. الخطة التقنية

```
DigitalOcean Droplet (VPS)
  └── IB Gateway (headless) → يتصل بـ IBKR
  └── ngrok → يكشف port 4001/4002 للإنترنت
  └── البوت (Manus) → يتصل عبر ngrok URL
```

---

## 5. ملاحظات

- الحساب IBKR Lite (بدون عمولة على الأسهم الأمريكية)
- يحتاج تمويل قبل التداول الحقيقي
- IB Gateway يحتاج إعادة تشغيل كل يوم تقريباً (أو استخدام IBC للتشغيل التلقائي)
- ngrok يعطي رابط عام يتغير كل ما يعاد تشغيله (إلا بالاشتراك المدفوع)

---

*آخر تحديث: 29 مارس 2026*

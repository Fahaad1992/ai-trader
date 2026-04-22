import { Save, ShieldCheck } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { BotConfig } from "../../shared/types";
import { useConfig, useUpdateConfig } from "../hooks/useTrading";

function Num({
  label,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step ?? 1}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-foreground ltr-nums"
        />
        {suffix && <span className="text-xs text-muted-foreground whitespace-nowrap">{suffix}</span>}
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{label}</span>
      <button onClick={() => onChange(!checked)} className={`w-10 h-5 rounded-full transition-colors ${checked ? "bg-primary" : "bg-secondary"}`}>
        <div className={`w-4 h-4 rounded-full bg-white transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}

function StaticField({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-secondary/15 p-3 space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm font-medium break-words">{value}</div>
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

function Section({ title, children, badge }: { title: string; children: ReactNode; badge?: string }) {
  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <div className="p-4 border-b border-border flex items-center gap-2 flex-wrap">
        <h3 className="font-medium text-sm">{title}</h3>
        {badge && <span className="px-2 py-0.5 rounded text-xs bg-secondary text-muted-foreground">{badge}</span>}
      </div>
      <div className="p-4 space-y-4">{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();
  const [local, setLocal] = useState<BotConfig | null>(null);

  useEffect(() => {
    if (config) setLocal(JSON.parse(JSON.stringify(config)));
  }, [config]);

  if (!local) return <div className="p-8 text-center text-muted-foreground">جاري تحميل الإعدادات...</div>;

  const u = (path: string, value: any) => {
    const copy = JSON.parse(JSON.stringify(local));
    const keys = path.split(".");
    let obj: any = copy;
    for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
    obj[keys[keys.length - 1]] = value;
    setLocal(copy);
  };

  const save = async () => {
    await updateConfig(local);
    toast.success("تم حفظ الإعدادات");
  };

  const isFuturesMode = local.tradeMode === "futures";
  const unlimitedTradesLabel = isFuturesMode ? "غير محدود" : String(local.risk.maxTradesPerDay);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">الإعدادات</h1>
          <p className="text-sm text-muted-foreground mt-1">وضع Futures الحالي يقرأ الرصيد الحقيقي وحد الخسارة اليومي من IBKR API مباشرة فقط، ويعرض الشرطة بدلًا من أي قيمة محلية عندما لا تكون بيانات IBKR متاحة.</p>
        </div>
        <button onClick={save} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity">
          <Save className="h-4 w-4" /> حفظ
        </button>
      </div>

      <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm">
        <div className="flex items-start gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-400 mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium text-emerald-300">سياسة Futures المعتمدة</p>
            <p className="text-muted-foreground">
              تبقى إعدادات الأوبشن كاملة داخل المشروع، لكنها تُخفى من الواجهة عندما يكون <span className="text-foreground font-semibold">TRADE_MODE=futures</span>. كما أن <span className="text-foreground font-semibold">نوع الأصل</span> و<span className="text-foreground font-semibold">Trailing Distance</span> و<span className="text-foreground font-semibold">Initial Stop</span> أصبحت للعرض فقط، بينما يُحسب حد الخسارة اليومي من الرصيد الحقيقي القادم من IBKR فقط عند توفره.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Section title="الوضع والتنفيذ" badge={isFuturesMode ? "Futures" : undefined}>
          <StaticField label="وضع التداول" value={local.mode === "live" ? "حقيقي" : "ورقي"} />
          <StaticField label="الاستراتيجية النشطة" value="حلب سريع فقط" note="المحرك يفرض هذه الاستراتيجية في المسار الحالي." />
          <StaticField label="مصدر التنفيذ" value={local.futures.executionBroker} />
          <StaticField label="مصدر بيانات الرصيد" value="IBKR API مباشرة" />
        </Section>

        <Section title="إعدادات Futures الثابتة" badge="قراءة فقط">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <StaticField label="نوع الأصل" value={local.futures.assetType} note="Read-only" />
            <StaticField label="Trailing Distance" value={`${local.futures.trailingStopPoints} نقطة`} note="Read-only" />
            <StaticField label="Initial Stop" value={`${local.futures.initialStopPoints} نقاط`} note="Read-only" />
            <StaticField label="Max Contracts" value={String(local.futures.maxContracts)} note="الحد الأقصى المسموح به للمسار الحالي" />
            <StaticField label="Daily Loss Limit" value={`${local.futures.dailyLossLimitPercent}% من الرصيد الحقيقي`} note="يُحسب تلقائيًا من IBKR عند توفر البيانات الحقيقية" />
            <StaticField label="Balance Refresh" value={`${local.futures.balanceRefreshSeconds} ثانية`} note="مزامنة دورية مع IBKR" />
          </div>
        </Section>

        <Section title="إدارة المخاطر القابلة للتعديل">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <StaticField label="أقصى صفقات/يوم" value={unlimitedTradesLabel} note="في Futures لا يوجد حد يومي لعدد الصفقات." />
            <StaticField label="أقصى خسارة يومية" value={`${local.futures.dailyLossLimitPercent}%`} note="تُشتق من الرصيد الحقيقي ولا تُضبط يدويًا." />
            <Num label="أقصى خسائر متتالية" value={local.risk.maxConsecutiveLosses} onChange={(v) => u("risk.maxConsecutiveLosses", v)} min={1} max={10} />
            <Num label="فترة الانتظار" value={local.risk.cooldownMinutes} onChange={(v) => u("risk.cooldownMinutes", v)} min={0} max={60} suffix="دقيقة" />
          </div>
        </Section>

        <Section title="رأس المال والعرض">
          <StaticField label="الرصيد الحقيقي" value="يُقرأ تلقائيًا من IBKR ويظهر كـ — عند عدم توفره" note="لا يُدار يدويًا من صفحة الإعدادات." />
          <Num label="الرصيد الورقي" value={local.capital.paperBalance} onChange={(v) => u("capital.paperBalance", v)} min={100} suffix="$" />
          <Toggle label="ترحيل ربح/خسارة اليوم داخليًا" checked={local.capital.carryDailyPnlIntoCapital} onChange={(v) => u("capital.carryDailyPnlIntoCapital", v)} />
        </Section>

        {isFuturesMode ? (
          <Section title="إعدادات Options" badge="مخفية في Futures mode">
            <div className="rounded-xl border border-border/60 bg-secondary/20 p-4 text-sm text-muted-foreground">
              إعدادات Options ما زالت موجودة بالكامل داخل الكود وضمن التهيئة الحالية، لكنها مخفية من هذه الواجهة لأن وضع التشغيل الحالي هو <span className="font-semibold text-foreground">futures</span>.
            </div>
          </Section>
        ) : (
          <Section title="إعدادات Options">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Num label="أقل دلتا" value={local.options.deltaMin} onChange={(v) => u("options.deltaMin", v)} min={0.05} max={1} step={0.05} />
              <Num label="أعلى دلتا" value={local.options.deltaMax} onChange={(v) => u("options.deltaMax", v)} min={0.05} max={1} step={0.05} />
              <Num label="أقل علاوة" value={local.options.minPremium} onChange={(v) => u("options.minPremium", v)} min={0.1} step={0.5} suffix="$" />
              <Num label="أعلى علاوة" value={local.options.maxPremium} onChange={(v) => u("options.maxPremium", v)} min={1} suffix="$" />
              <Num label="أقصى عقود Options" value={local.options.maxContracts} onChange={(v) => u("options.maxContracts", v)} min={1} max={50} />
              <Num label="عقود لكل صفقة" value={local.options.contractsPerTrade} onChange={(v) => u("options.contractsPerTrade", v)} min={1} max={20} />
            </div>
            <div className="space-y-3 pt-2">
              <Toggle label="أسبوعي فقط" checked={local.options.weeklyOnly} onChange={(v) => u("options.weeklyOnly", v)} />
              <Toggle label="السماح بـ 0DTE" checked={local.options.allow0DTE} onChange={(v) => u("options.allow0DTE", v)} />
              <Toggle label="السماح بأوبشنز رخيصة" checked={local.options.allowCheapOptions} onChange={(v) => u("options.allowCheapOptions", v)} />
            </div>
          </Section>
        )}

        <Section title="فلاتر التشغيل">
          <Num label="أقل تأكيدات مطلوبة" value={local.filters.minConfirmations} onChange={(v) => u("filters.minConfirmations", v)} min={1} max={8} suffix="/8" />
          <div className="space-y-3">
            <Toggle label="فلتر الأخبار" checked={local.filters.enableNewsFilter} onChange={(v) => u("filters.enableNewsFilter", v)} />
            <Toggle label="فلتر VIX" checked={local.filters.enableVixFilter} onChange={(v) => u("filters.enableVixFilter", v)} />
            <Toggle label="فلتر التقلب" checked={local.filters.enableVolatilityFilter} onChange={(v) => u("filters.enableVolatilityFilter", v)} />
            <Toggle label="فلتر الوقت" checked={local.filters.enableTimeFilter} onChange={(v) => u("filters.enableTimeFilter", v)} />
            <Toggle label="حظر أول 10 دقائق" checked={local.filters.blockFirst10Minutes} onChange={(v) => u("filters.blockFirst10Minutes", v)} />
            <Toggle label="حظر آخر 30 دقيقة" checked={local.filters.blockLast30Minutes} onChange={(v) => u("filters.blockLast30Minutes", v)} />
            <Toggle label="اشتراط اختراق" checked={local.filters.requireBreakout} onChange={(v) => u("filters.requireBreakout", v)} />
          </div>
        </Section>
      </div>
    </div>
  );
}

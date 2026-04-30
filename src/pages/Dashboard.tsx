import { useMemo, useState, type ElementType, type ReactNode } from "react";
import {
  Activity,
  BarChart3,
  Clock,
  DollarSign,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
  Wifi,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import type { BotLog, DecisionStatsWindow, Trade } from "../../shared/types";
import {
  useBotControl,
  useBotLogs,
  useBotStatus,
  useDailyStats,
  useOpenTrades,
  useOverallStats,
  useSmartBrainStats,
} from "../hooks/useTrading";

const pnlColor = (v: number) =>
  v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted-foreground";

const strategyAr: Record<string, string> = {
  milking: "حلب سريع",
  hold: "احتفاظ",
  zeroHero: "زيرو هيرو",
};

type WindowKey = "24h" | "48h";

function SectionCard({
  title,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  icon: ElementType;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="bg-card border border-border rounded-2xl overflow-hidden">
      <div className="p-4 border-b border-border flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-xl bg-secondary flex items-center justify-center">
            <Icon className="h-4 w-4 text-primary" />
          </div>
          <h2 className="font-bold">{title}</h2>
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function MiniStat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "green" | "red" | "amber" | "blue";
}) {
  const toneClass = {
    default: "border-border bg-secondary/20 text-foreground",
    green: "border-green-500/20 bg-green-500/5 text-green-400",
    red: "border-red-500/20 bg-red-500/5 text-red-400",
    amber: "border-amber-500/20 bg-amber-500/5 text-amber-400",
    blue: "border-blue-500/20 bg-blue-500/5 text-blue-400",
  }[tone];

  return (
    <div className={`rounded-xl border p-3 ${toneClass}`}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-lg font-bold ltr-nums mt-1">{value}</p>
    </div>
  );
}

function TradeDetail({ trade }: { trade: Trade | null }) {
  if (!trade) {
    return <p className="text-sm text-muted-foreground text-center py-6">لا توجد صفقة مفتوحة حاليًا.</p>;
  }

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
      <div><p className="text-muted-foreground text-xs">الرمز</p><p className="font-medium">{trade.underlying}</p></div>
      <div><p className="text-muted-foreground text-xs">العقد</p><p className="font-medium ltr-nums break-all">{trade.symbol}</p></div>
      <div><p className="text-muted-foreground text-xs">Premium</p><p className="font-medium ltr-nums">${trade.entryPremium.toFixed(2)}</p></div>
      <div><p className="text-muted-foreground text-xs">الكمية</p><p className="font-medium ltr-nums">x{trade.quantity}</p></div>
      <div><p className="text-muted-foreground text-xs">السعر الحالي</p><p className="font-medium ltr-nums">${trade.currentPremium.toFixed(2)}</p></div>
      <div><p className="text-muted-foreground text-xs">الربح/الخسارة</p><p className={`font-medium ltr-nums ${pnlColor(trade.pnl)}`}>{trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}</p></div>
      {trade.tradeMode !== "futures" && (
        <>
          <div><p className="text-muted-foreground text-xs">Delta</p><p className="font-medium ltr-nums">{trade.delta?.toFixed(3) ?? "—"}</p></div>
          <div><p className="text-muted-foreground text-xs">Expiry</p><p className="font-medium ltr-nums">{trade.expiry ?? "—"}</p></div>
        </>
      )}
    </div>
  );
}

type ActivityCategory =
  | "ALL"
  | "WAIT"
  | "REJECT"
  | "EXECUTE"
  | "DRY_RUN"
  | "IBKR"
  | "ERROR"
  | "TELEGRAM"
  | "SMART_BRAIN";

function classifyLog(log: BotLog): ActivityCategory[] {
  const cats: ActivityCategory[] = [];
  const msg = (log.message || "").toUpperCase();
  const dec = (log.decision || "").toUpperCase();
  const level = (log as any).level ? String((log as any).level).toUpperCase() : "";
  if (dec === "WAIT" || msg.includes("WAIT")) cats.push("WAIT");
  if (dec === "REJECT" || msg.includes("REJECT")) cats.push("REJECT");
  if (dec === "EXECUTE" || msg.includes("EXECUTE") || msg.includes("TRADE_OPEN")) cats.push("EXECUTE");
  if (msg.includes("DRY_RUN") || msg.includes("[DRY")) cats.push("DRY_RUN");
  if (msg.includes("IBKR")) cats.push("IBKR");
  if (level === "ERROR" || msg.includes("ERROR") || msg.includes("FAILED")) cats.push("ERROR");
  if (msg.includes("TELEGRAM") || msg.includes("NOTIFY")) cats.push("TELEGRAM");
  if (msg.includes("SMART") || msg.includes("BRAIN")) cats.push("SMART_BRAIN");
  return cats;
}

function categoryColor(cat: ActivityCategory): string {
  switch (cat) {
    case "WAIT":        return "border-amber-500/40 bg-amber-500/5";
    case "REJECT":      return "border-red-500/40 bg-red-500/5";
    case "EXECUTE":     return "border-green-500/40 bg-green-500/5";
    case "DRY_RUN":     return "border-blue-500/40 bg-blue-500/5";
    case "IBKR":        return "border-cyan-500/40 bg-cyan-500/5";
    case "ERROR":       return "border-red-600/50 bg-red-600/10";
    case "TELEGRAM":    return "border-purple-500/40 bg-purple-500/5";
    case "SMART_BRAIN": return "border-indigo-500/40 bg-indigo-500/5";
    default:            return "border-border/60 bg-secondary/10";
  }
}

function categoryBadge(cat: ActivityCategory): string {
  switch (cat) {
    case "WAIT":        return "bg-amber-500/20 text-amber-400";
    case "REJECT":      return "bg-red-500/20 text-red-400";
    case "EXECUTE":     return "bg-green-500/20 text-green-400";
    case "DRY_RUN":     return "bg-blue-500/20 text-blue-400";
    case "IBKR":        return "bg-cyan-500/20 text-cyan-400";
    case "ERROR":       return "bg-red-600/20 text-red-400";
    case "TELEGRAM":    return "bg-purple-500/20 text-purple-400";
    case "SMART_BRAIN": return "bg-indigo-500/20 text-indigo-400";
    default:            return "bg-secondary text-muted-foreground";
  }
}

function RecentLogRow({ log }: { log: BotLog }) {
  const cats = classifyLog(log);
  const primary = cats[0] ?? ("ALL" as ActivityCategory);
  const borderCls = categoryColor(primary);
  return (
    <div className={`rounded-xl border p-3 ${borderCls}`}>
      <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{log.message}</p>
      <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground mt-2 ltr-nums">
        <span>{new Date(log.createdAt).toLocaleString("ar-SA")}</span>
        {log.symbol && <span className="px-1.5 py-0.5 rounded bg-secondary">{log.symbol}</span>}
        {log.decision && (
          <span className={`px-1.5 py-0.5 rounded font-medium ${categoryBadge(log.decision as ActivityCategory)}`}>
            {log.decision}
          </span>
        )}
        {log.confidence !== null && log.confidence !== undefined && (
          <span className="px-1.5 py-0.5 rounded bg-secondary">Conf: {log.confidence}</span>
        )}
        {cats.slice(0, 2).map((c) => (
          <span key={c} className={`px-1.5 py-0.5 rounded text-[10px] ${categoryBadge(c)}`}>
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}

const ACTIVITY_FILTERS: ActivityCategory[] = [
  "ALL",
  "WAIT",
  "REJECT",
  "EXECUTE",
  "DRY_RUN",
  "IBKR",
  "ERROR",
  "TELEGRAM",
  "SMART_BRAIN",
];

function ActivityFeed({ logs }: { logs: BotLog[] }) {
  const [filter, setFilter] = useState<ActivityCategory>("ALL");
  const filtered = useMemo(() => {
    if (filter === "ALL") return logs;
    return logs.filter((l) => classifyLog(l).includes(filter));
  }, [logs, filter]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5 text-xs">
        {ACTIVITY_FILTERS.map((c) => (
          <button
            key={c}
            onClick={() => setFilter(c)}
            className={`px-2.5 py-1 rounded-lg border transition-colors ${
              filter === c
                ? "bg-primary text-primary-foreground border-primary"
                : `border-border/60 hover:bg-accent ${c === "ALL" ? "" : categoryBadge(c)}`
            }`}
          >
            {c}
          </button>
        ))}
      </div>
      <div
        className="max-h-[360px] md:max-h-[480px] overflow-y-auto overflow-x-hidden pr-1 space-y-2 rounded-xl border border-border/40 bg-background/40 p-2"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {!filtered.length ? (
          <p className="text-sm text-muted-foreground text-center py-6">لا يوجد نشاط مطابق.</p>
        ) : (
          filtered.map((log) => <RecentLogRow key={log.id} log={log} />)
        )}
      </div>
      <p className="text-[11px] text-muted-foreground text-center">
        يعرض آخر {logs.length} نشاط — مُرشّح: {filter} — مرّر للأعلى والأسفل داخل السجل.
      </p>
    </div>
  );
}

function CompactDecisionStats({ window }: { window?: DecisionStatsWindow }) {
  const reasons = window?.topReasonCodes?.slice(0, 3) ?? [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MiniStat label="الإشارات" value={String(window?.signalsTotal ?? 0)} tone="blue" />
        <MiniStat label="EXECUTE" value={String(window?.execute ?? 0)} tone="green" />
        <MiniStat label="WAIT" value={String(window?.wait ?? 0)} tone="amber" />
        <MiniStat label="REJECT" value={String(window?.reject ?? 0)} tone="red" />
      </div>

      <div className="rounded-xl border border-border/60 p-3 space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-muted-foreground">
          <span className="ltr-nums">REDUCE: <span className="text-foreground font-semibold">{window?.reduce ?? 0}</span></span>
          <span className="ltr-nums">Avg Conf: <span className="text-foreground font-semibold">{window?.avgConfidenceAll ?? 0}</span></span>
          <span className="ltr-nums">Exec Conf: <span className="text-foreground font-semibold">{window?.avgConfidenceExecuted ?? 0}</span></span>
          <span className="ltr-nums">premium=0: <span className="text-foreground font-semibold">{window?.premiumZeroCount ?? 0}</span></span>
          <span className="ltr-nums">option rejected: <span className="text-foreground font-semibold">{window?.optionRejected ?? 0}</span></span>
        </div>

        {!!reasons.length && (
          <div className="pt-2 border-t border-border/50 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground ml-2">الأسباب الأكثر تكرارًا:</span>
            {reasons.map((item) => `${item.code} (${item.count})`).join(" • ")}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { data: status } = useBotStatus();
  const { data: stats } = useOverallStats();
  const { data: daily } = useDailyStats();
  const { data: open } = useOpenTrades();
  const { data: smartBrain, refetch: refetchSmart } = useSmartBrainStats();
  const { data: logs, refetch: refetchLogs } = useBotLogs({ limit: 50 });
  const { start, stop } = useBotControl();
  const [statsWindow, setStatsWindow] = useState<WindowKey>("24h");

  const openPnl = open?.reduce((sum, trade) => sum + trade.pnl, 0) ?? 0;
  const closedPnl = daily?.dailyPnl ?? 0;
  const firstTrade = open?.[0] ?? null;
  const recentLogs = useMemo(() => (logs ?? []), [logs]);
  const activeWindow = statsWindow === "24h" ? smartBrain?.last24h : smartBrain?.last48h;
  const brokerAccount = status?.brokerAccount ?? null;
  const realBalance = brokerAccount?.netLiquidatingValue ?? null;
  const dailyLossLimitAmount = brokerAccount?.dailyLossLimitAmount ?? null;
  const dataUpdatedAt = brokerAccount?.updatedAt ? new Date(brokerAccount.updatedAt).toLocaleString("ar-SA") : "—";
  const internalBalance = null;

  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">لوحة التحكم</h1>
          <p className="text-sm text-muted-foreground mt-1">عرض مبسّط للجوال مع تحديث تلقائي كل 5 ثوانٍ.</p>
        </div>
        <button
          onClick={() => {
            refetchSmart();
            refetchLogs();
          }}
          className="px-3 py-2 rounded-lg bg-secondary hover:bg-accent text-sm flex items-center gap-2"
        >
          <RefreshCw className="h-4 w-4" /> تحديث الآن
        </button>
      </div>

      <SectionCard
        title="حالة البوت"
        icon={Activity}
        action={
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm ${status?.running ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
            <div className={`w-2 h-2 rounded-full ${status?.running ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
            {status?.running ? "يعمل" : "متوقف"}
          </div>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="px-2 py-0.5 rounded font-medium bg-blue-500/20 text-blue-400">بيانات حقيقية · تشغيل فعلي</span>
            <span className="px-2 py-0.5 rounded bg-secondary text-muted-foreground">{strategyAr[status?.activeStrategy ?? ""] ?? status?.activeStrategy ?? "—"}</span>
            <span className={`flex items-center gap-1 px-2 py-0.5 rounded font-medium ${
              status?.dataState === "connected"
                ? "bg-green-500/10 text-green-400"
                : status?.dataState === "waiting"
                  ? "bg-yellow-500/10 text-yellow-400"
                  : "bg-red-500/10 text-red-400"
            }`}>
              {status?.dataState === "connected" ? (
                <><Wifi className="h-3 w-3" /> بيانات متصلة</>
              ) : status?.dataState === "waiting" ? (
                <><Activity className="h-3 w-3 animate-pulse" /> انتظار بيانات</>
              ) : (
                <><WifiOff className="h-3 w-3" /> غير متصل</>
              )}
            </span>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {status?.running ? (
              <button onClick={() => { stop(); toast.info("تم إيقاف البوت"); }} className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium">
                إيقاف
              </button>
            ) : (
              <button onClick={() => { start(); toast.success("تم تشغيل البوت"); }} className="px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium">
                تشغيل
              </button>
            )}
            {status?.blockedReason && status.blockedReason !== "انتظار بيانات" && (
              <span className="px-3 py-2 rounded-lg text-xs bg-amber-500/10 text-amber-400">{status.blockedReason}</span>
            )}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="الرصيد الحقيقي من IBKR" icon={DollarSign}>
        <div className="space-y-4">
          <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
            <p className="text-xs text-muted-foreground">Net Liquidating Value</p>
            <p className="text-3xl font-bold text-blue-400 ltr-nums mt-1">{realBalance !== null ? `$${realBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}</p>
            <p className="text-xs text-muted-foreground mt-2">
              تُعرض هذه القيمة من IBKR API مباشرة فقط، وإذا لم تكن متاحة تظهر الشرطة بدلًا من أي fallback محلي أو قيمة ثابتة.
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MiniStat label="حد الخسارة اليومي" value={dailyLossLimitAmount !== null ? `$${dailyLossLimitAmount.toFixed(2)}` : "—"} tone="red" />
            <MiniStat label="مصدر الرصيد" value={brokerAccount?.source ?? "—"} tone="blue" />
            <MiniStat label="رقم الحساب" value={brokerAccount?.accountNumber ?? "—"} />
            <MiniStat label="تحديث آخر" value={dataUpdatedAt} tone="amber" />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MiniStat label="Futures Approved" value={brokerAccount ? (brokerAccount.futuresApproved ? "نعم" : "لا") : "—"} tone={brokerAccount?.futuresApproved ? "green" : "red"} />
            <MiniStat label="نوع الحساب" value={brokerAccount?.accountTypeName ?? "—"} />
            <MiniStat label="Cash / Margin" value={brokerAccount?.marginOrCash ?? "—"} />
            <MiniStat label="الرصيد الداخلي" value="—" tone="default" />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="حالة السوق" icon={Wifi}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <MiniStat label="الحالة" value={status?.marketOpen ? "مفتوح" : "مغلق"} tone={status?.marketOpen ? "green" : "default"} />
          <MiniStat label="الوقت (ET)" value={status?.marketTimeET ?? "—"} />
          <MiniStat label="SPY" value={status?.spyPrice ? `$${status.spyPrice.toFixed(2)}` : "—"} tone="blue" />
          <MiniStat label="QQQ" value={status?.qqqPrice ? `$${status.qqqPrice.toFixed(2)}` : "—"} tone="blue" />
        </div>
        <div className="mt-3 text-sm text-muted-foreground ltr-nums">
          VIX: <span className={`font-semibold ${(status?.vix ?? 0) > 25 ? "text-red-400" : "text-green-400"}`}>{status?.vix?.toFixed(1) ?? "—"}</span>
        </div>
      </SectionCard>

      <SectionCard title="الصفقة المفتوحة الحالية" icon={TrendingUp}>
        <TradeDetail trade={firstTrade} />
      </SectionCard>

      <SectionCard title="ملخص المخاطر الفعلي" icon={ShieldCheck}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MiniStat label="ربح اليوم المغلق" value={`${closedPnl >= 0 ? "+" : ""}$${closedPnl.toFixed(2)}`} tone={closedPnl >= 0 ? "green" : "red"} />
          <MiniStat label="الربح المفتوح" value={`${openPnl >= 0 ? "+" : ""}$${openPnl.toFixed(2)}`} tone={openPnl >= 0 ? "green" : "red"} />
          <MiniStat label="بداية اليوم" value={`$${(daily?.startCapital ?? 0).toFixed(2)}`} />
          <MiniStat label="فوز / خسارة اليوم" value={`${daily?.wins ?? 0} / ${daily?.losses ?? 0}`} tone="amber" />
        </div>
      </SectionCard>

      <SectionCard title="سجل الأنشطة" icon={Clock}>
        <ActivityFeed logs={recentLogs} />
      </SectionCard>

      <SectionCard
        title="الإحصائيات المختصرة"
        icon={BarChart3}
        action={
          <div className="rounded-xl bg-secondary/60 p-1 flex items-center gap-1 text-xs">
            <button
              onClick={() => setStatsWindow("24h")}
              className={`px-3 py-1 rounded-lg transition-colors ${statsWindow === "24h" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              24h
            </button>
            <button
              onClick={() => setStatsWindow("48h")}
              className={`px-3 py-1 rounded-lg transition-colors ${statsWindow === "48h" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              48h
            </button>
          </div>
        }
      >
        <CompactDecisionStats window={activeWindow} />
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4 pt-4 border-t border-border/50">
          <MiniStat label="نسبة الفوز" value={`${stats?.winRate ?? 0}%`} tone="amber" />
          <MiniStat label="إجمالي الربح" value={`$${(stats?.totalPnl ?? 0).toFixed(2)}`} tone={(stats?.totalPnl ?? 0) >= 0 ? "green" : "red"} />
          <MiniStat label="إجمالي الصفقات" value={`${stats?.totalTrades ?? 0}`} />
        </div>
      </SectionCard>
    </div>
  );
}

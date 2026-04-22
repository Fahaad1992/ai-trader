import { useBotStatus, useOpenTrades, useDailyStats, useOverallStats, useBotLogs, useBotControl } from "../hooks/useTrading";
import { DollarSign, TrendingUp, TrendingDown, Activity, Clock, Wifi, WifiOff, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

const pnlColor = (v: number) => v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted-foreground";

const strategyAr: Record<string, string> = {
  milking: "حلب سريع",
  hold: "احتفاظ",
  zeroHero: "زيرو هيرو",
};

export default function Dashboard() {
  const { data: status } = useBotStatus();
  const { data: stats } = useOverallStats();
  const { data: daily } = useDailyStats();
  const { data: open } = useOpenTrades();
  const { data: logs } = useBotLogs(8);
  const { start, stop } = useBotControl();

  // حساب الربح المفتوح (الصفقات الحالية)
  const openPnl = open?.reduce((sum, t) => sum + t.pnl, 0) ?? 0;
  // ربح اليوم = الصفقات المغلقة فقط
  const closedPnl = daily?.dailyPnl ?? 0;

  return (
    <div className="space-y-5 max-w-6xl">
      {/* الرأس */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">لوحة التحكم</h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap text-xs">
            <span className="px-2 py-0.5 rounded font-medium bg-blue-500/20 text-blue-400">
              بيانات حقيقية · تنفيذ ورقي
            </span>
            <span className="text-muted-foreground">{strategyAr[status?.activeStrategy ?? ''] ?? status?.activeStrategy}</span>
            <span className={`flex items-center gap-1 px-2 py-0.5 rounded font-medium ${
              status?.dataState === 'connected' ? 'bg-green-500/10 text-green-400' :
              status?.dataState === 'waiting' ? 'bg-yellow-500/10 text-yellow-400' :
              'bg-red-500/10 text-red-400'
            }`}>
              {status?.dataState === 'connected' ? <><Wifi className="h-3 w-3" /> بيانات متصلة</> :
               status?.dataState === 'waiting' ? <><Activity className="h-3 w-3 animate-pulse" /> انتظار بيانات</> :
               !status?.running ? <><WifiOff className="h-3 w-3" /> غير متصل</> :
               <><WifiOff className="h-3 w-3" /> غير متصل</>}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm ${status?.running ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
            <div className={`w-2 h-2 rounded-full ${status?.running ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
            {status?.running ? 'يعمل' : 'متوقف'}
          </div>
          {status?.running ? (
            <button onClick={() => { stop(); toast.info("تم إيقاف البوت"); }} className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium">إيقاف</button>
          ) : (
            <button onClick={() => { start(); toast.success("تم تشغيل البوت"); }} className="px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium">تشغيل</button>
          )}
        </div>
      </div>

      {/* شريط السوق */}
      <div className="bg-card border border-border rounded-xl p-3">
        <div className="flex items-center gap-5 flex-wrap text-sm">
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${status?.marketOpen ? 'bg-green-500/20 text-green-400' : 'bg-secondary text-muted-foreground'}`}>
            {status?.marketOpen ? 'السوق مفتوح' : 'السوق مغلق'}
          </span>
          {status?.marketTimeET && <span className="text-xs text-muted-foreground ltr-nums">{status.marketTimeET}</span>}
          {status?.spyPrice ? <span className="ltr-nums">SPY: <span className="font-bold text-blue-400">${status.spyPrice.toFixed(2)}</span></span> : null}
          {status?.qqqPrice ? <span className="ltr-nums">QQQ: <span className="font-bold text-purple-400">${status.qqqPrice.toFixed(2)}</span></span> : null}
          <span className="ltr-nums">VIX: <span className={`font-bold ${(status?.vix ?? 0) > 25 ? 'text-red-400' : 'text-green-400'}`}>{status?.vix?.toFixed(1) ?? '-'}</span></span>
          {status?.dataState === 'connected' && !status?.dataFresh && status?.dataTimestamp && (
            <span className="flex items-center gap-1 text-xs text-amber-400"><AlertTriangle className="h-3 w-3" /> تحديث البيانات...</span>
          )}
          {status?.blockedReason && status.blockedReason !== 'انتظار بيانات' && (
            <span className="mr-auto px-2 py-0.5 rounded text-xs bg-amber-500/10 text-amber-400">{status.blockedReason}</span>
          )}
        </div>
      </div>

      {/* 4 بطاقات رئيسية */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* رأس المال */}
        <div className="bg-card border border-border rounded-xl p-4">
          <p className="text-xs text-muted-foreground">رأس المال</p>
          <p className="text-2xl font-bold text-blue-400 ltr-nums mt-1">${(stats?.currentCapital ?? 1000).toLocaleString()}</p>
          <p className="text-xs text-muted-foreground mt-1 ltr-nums">البداية: ${(daily?.startCapital ?? 1000).toLocaleString()}</p>
        </div>

        {/* الربح المفتوح - مباشر */}
        <div className="bg-card border border-border rounded-xl p-4">
          <p className="text-xs text-muted-foreground">الربح المفتوح</p>
          <p className={`text-2xl font-bold ltr-nums mt-1 ${pnlColor(openPnl)}`}>{openPnl >= 0 ? '+' : ''}${openPnl.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground mt-1">{open?.length ?? 0} صفقة مفتوحة</p>
        </div>

        {/* ربح اليوم المغلق */}
        <div className="bg-card border border-border rounded-xl p-4">
          <p className="text-xs text-muted-foreground">ربح اليوم (مغلق)</p>
          <p className={`text-2xl font-bold ltr-nums mt-1 ${pnlColor(closedPnl)}`}>{closedPnl >= 0 ? '+' : ''}${closedPnl.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground mt-1 ltr-nums">{daily?.wins ?? 0} فوز / {daily?.losses ?? 0} خسارة</p>
        </div>

        {/* نسبة الفوز */}
        <div className="bg-card border border-border rounded-xl p-4">
          <p className="text-xs text-muted-foreground">نسبة الفوز</p>
          <p className="text-2xl font-bold text-amber-400 ltr-nums mt-1">{stats?.winRate ?? 0}%</p>
          <p className="text-xs text-muted-foreground mt-1 ltr-nums">الإجمالي: ${(stats?.totalPnl ?? 0).toFixed(2)}</p>
        </div>
      </div>

      {/* الصفقة الحالية */}
      <div className="bg-card border border-border rounded-xl">
        <div className="p-4 border-b border-border flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <span className="font-medium text-sm">الصفقة الحالية</span>
        </div>
        <div className="p-4">
          {!open?.length ? (
            <p className="text-sm text-muted-foreground text-center py-6">لا توجد صفقة مفتوحة</p>
          ) : (
            open.map(t => (
              <div key={t.id} className="flex items-center justify-between flex-wrap gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${t.contractType === 'call' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>{t.contractType === 'call' ? 'شراء' : 'بيع'}</span>
                    <span className="text-lg font-bold">{t.underlying}</span>
                    <span className="text-xs text-muted-foreground">{strategyAr[t.strategy] ?? t.strategy}</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 text-sm">
                    <div><span className="text-muted-foreground text-xs">سعر التنفيذ</span><p className="font-medium ltr-nums">${t.strike}</p></div>
                    <div><span className="text-muted-foreground text-xs">سعر الدخول</span><p className="font-medium ltr-nums">${t.entryPremium.toFixed(2)}</p></div>
                    <div><span className="text-muted-foreground text-xs">السعر الحالي</span><p className={`font-medium ltr-nums ${pnlColor(t.currentPremium - t.entryPremium)}`}>${t.currentPremium.toFixed(2)}</p></div>
                    <div><span className="text-muted-foreground text-xs">الكمية</span><p className="font-medium ltr-nums">x{t.quantity}</p></div>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground ltr-nums flex-wrap">
                    {t.delta != null && <span>دلتا: <span className="text-blue-400 font-medium">{t.delta.toFixed(3)}</span></span>}
                    {t.iv != null && <span>IV: <span className="text-foreground font-medium">{(t.iv * 100).toFixed(0)}%</span></span>}
                    {t.volume != null && <span>الحجم: <span className="text-foreground font-medium">{t.volume.toLocaleString()}</span></span>}
                    <span>الانتهاء: {t.expiry}</span>
                  </div>
                </div>
                <div className="text-left">
                  <p className={`text-2xl font-bold ltr-nums ${pnlColor(t.pnl)}`}>{t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}</p>
                  <p className={`text-sm ltr-nums ${pnlColor(t.pnlPercent)}`}>{t.pnlPercent >= 0 ? '+' : ''}{t.pnlPercent.toFixed(1)}%</p>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* آخر النشاط */}
      <div className="bg-card border border-border rounded-xl">
        <div className="p-4 border-b border-border flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" />
          <span className="font-medium text-sm">آخر النشاط</span>
        </div>
        <div className="p-4">
          {!logs?.length ? (
            <p className="text-sm text-muted-foreground text-center py-6">لا يوجد نشاط</p>
          ) : (
            <div className="space-y-2 max-h-[250px] overflow-y-auto">
              {logs.map(l => (
                <div key={l.id} className="flex items-start gap-3 p-2 text-sm">
                  <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${l.level === 'trade' ? 'bg-blue-400' : l.level === 'error' ? 'bg-red-400' : l.level === 'warn' ? 'bg-amber-400' : 'bg-green-400'}`} />
                  <div className="min-w-0">
                    <p className="truncate">{l.message}</p>
                    <p className="text-xs text-muted-foreground ltr-nums">{new Date(l.createdAt).toLocaleTimeString('ar-SA')}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useClosedTrades } from "../hooks/useTrading";

const strategyAr: Record<string, string> = {
  milking: "حلب سريع",
  hold: "احتفاظ",
  zeroHero: "زيرو هيرو",
};

const reasonAr: Record<string, string> = {
  "take-profit": "جني أرباح",
  "stop-loss": "وقف خسارة",
  trailing: "وقف متحرك",
  manual: "يدوي",
};

const pnlColor = (v: number) =>
  v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted-foreground";

export default function HistoryPage() {
  const { data: all, refetch, isLoading } = useClosedTrades();
  const [fStrategy, setFS] = useState("all");
  const [fType, setFT] = useState("all");
  const isFuturesMode = Boolean(all?.some((t) => t.tradeMode === "futures"));

  const filtered = useMemo(() => {
    return (all ?? []).filter((t) => {
      if (fStrategy !== "all" && t.strategy !== fStrategy) return false;
      if (!isFuturesMode && fType !== "all" && t.contractType !== fType) return false;
      return true;
    });
  }, [all, fStrategy, fType, isFuturesMode]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">سجل الصفقات المغلقة</h1>
          <p className="text-sm text-muted-foreground">مراجعة الأداء التاريخي وأسباب الإغلاق.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={fStrategy} onChange={(e) => setFS(e.target.value)} className="bg-secondary text-foreground border border-border rounded-lg px-3 py-1.5 text-sm">
            <option value="all">كل الاستراتيجيات</option>
            <option value="milking">حلب سريع</option>
            <option value="hold">احتفاظ</option>
            <option value="zeroHero">زيرو هيرو</option>
          </select>
          {!isFuturesMode && (
            <select value={fType} onChange={(e) => setFT(e.target.value)} className="bg-secondary text-foreground border border-border rounded-lg px-3 py-1.5 text-sm">
              <option value="all">كل الأنواع</option>
              <option value="call">شراء</option>
              <option value="put">بيع</option>
            </select>
          )}
          <button onClick={() => refetch()} className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-secondary flex items-center gap-2">
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} /> تحديث
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-card border border-border rounded-2xl p-6 text-sm text-muted-foreground">
          لا توجد صفقات مغلقة مطابقة للفلاتر الحالية.
        </div>
      ) : (
        <div className="bg-card border border-border rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 text-muted-foreground">
              <tr>
                <th className="text-left py-3 px-4 font-medium">التاريخ</th>
                <th className="text-left py-3 px-4 font-medium">الرمز</th>
                {!isFuturesMode && <th className="text-left py-3 px-4 font-medium">النوع</th>}
                <th className="text-left py-3 px-4 font-medium">الاستراتيجية</th>
                <th className="text-left py-3 px-4 font-medium">الدخول</th>
                <th className="text-left py-3 px-4 font-medium">الخروج</th>
                <th className="text-left py-3 px-4 font-medium">الكمية</th>
                <th className="text-left py-3 px-4 font-medium">الربح/الخسارة</th>
                <th className="text-left py-3 px-4 font-medium">%</th>
                <th className="text-right py-3 px-4 font-medium">السبب</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.id} className="border-b border-border/50 hover:bg-secondary/30 transition-colors">
                  <td className="py-3 px-4 text-muted-foreground ltr-nums">{t.closedAt ? new Date(t.closedAt).toLocaleDateString('ar-SA') : '-'}</td>
                  <td className="py-3 px-4 font-medium">{t.underlying}</td>
                  {!isFuturesMode && <td className="py-3 px-4"><span className={`px-1.5 py-0.5 rounded text-xs ${t.contractType === 'call' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>{t.contractType === 'call' ? 'شراء' : 'بيع'}</span></td>}
                  <td className="py-3 px-4"><span className="px-1.5 py-0.5 rounded text-xs bg-secondary text-muted-foreground">{strategyAr[t.strategy] ?? t.strategy}</span></td>
                  <td className="py-3 px-4 text-left ltr-nums">${t.entryPremium.toFixed(2)}</td>
                  <td className="py-3 px-4 text-left ltr-nums">${t.currentPremium.toFixed(2)}</td>
                  <td className="py-3 px-4 text-left ltr-nums">{t.quantity}</td>
                  <td className={`py-3 px-4 text-left font-bold ltr-nums ${pnlColor(t.pnl)}`}>{t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}</td>
                  <td className={`py-3 px-4 text-left ltr-nums ${pnlColor(t.pnlPercent)}`}>{t.pnlPercent >= 0 ? '+' : ''}{t.pnlPercent.toFixed(1)}%</td>
                  <td className="py-3 px-4"><span className={`px-1.5 py-0.5 rounded text-xs border ${t.closeReason === 'take-profit' ? 'text-green-400 border-green-400/30' : t.closeReason === 'stop-loss' ? 'text-red-400 border-red-400/30' : 'text-muted-foreground border-border'}`}>{reasonAr[t.closeReason ?? ''] ?? t.closeReason ?? 'يدوي'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

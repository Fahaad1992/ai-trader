import { useOpenTrades, useCloseTrade } from "../hooks/useTrading";
import { Activity, X } from "lucide-react";
import { toast } from "sonner";

const pnlColor = (v: number) => v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted-foreground";

const strategyAr: Record<string, string> = {
  milking: "حلب سريع",
  hold: "احتفاظ",
  zeroHero: "زيرو هيرو",
};

export default function TradesPage() {
  const { data: trades, refetch } = useOpenTrades();
  const closeTrade = useCloseTrade();

  const handleClose = async (id: string, cp: number) => {
    await closeTrade(id, cp);
    toast.success("تم إغلاق الصفقة");
    refetch();
  };

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold">الصفقات المفتوحة</h1>
        <p className="text-sm text-muted-foreground mt-1">{trades?.length ?? 0} صفقة نشطة</p>
      </div>

      {!trades?.length ? (
        <div className="bg-card border border-border rounded-xl py-16 text-center">
          <Activity className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-lg text-muted-foreground">لا توجد صفقات مفتوحة</p>
          <p className="text-sm text-muted-foreground mt-1">تظهر الصفقات هنا عندما يفتح البوت مراكز جديدة</p>
        </div>
      ) : (
        <div className="space-y-3">
          {trades.map(t => {
            const isSPX = t.tradeMode === "spx_options";
            const typeLabel = isSPX
              ? (t.contractType === "call" ? "SPX CALL طلوع" : "SPX PUT نزول")
              : t.contractType === "call" ? "CALL" : t.contractType === "put" ? "PUT" : t.underlying;
            const typeBg = t.contractType === "call" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400";
            return (
              <div key={t.id} className="bg-card border border-border rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-2 py-0.5 rounded text-sm font-bold ${typeBg}`}>{typeLabel}</span>
                    {!isSPX && <span className="text-sm font-bold">{t.underlying}</span>}
                  </div>
                  <p className={`text-xl font-bold ltr-nums ${pnlColor(t.pnl)}`}>{t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}</p>
                </div>

                <div className="flex items-center gap-4 text-sm ltr-nums">
                  <span>دخول <b>${t.entryPremium.toFixed(2)}</b></span>
                  <span>حالي <b className={pnlColor(t.currentPremium - t.entryPremium)}>${t.currentPremium.toFixed(2)}</b></span>
                  <span>وقف <b className="text-red-400">${t.trailingStopPrice?.toFixed(2) ?? t.initialStopPrice?.toFixed(2) ?? "—"}</b></span>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-3 text-xs text-muted-foreground ltr-nums flex-wrap">
                    {t.strike && <span>Strike ${t.strike}</span>}
                    {t.expiry && <span>{t.expiry}</span>}
                    {t.delta && <span>Δ{t.delta.toFixed(2)}</span>}
                    <span>x{t.quantity}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => handleClose(t.id, t.currentPremium)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-medium">
                      <X className="h-3 w-3" /> إغلاق
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

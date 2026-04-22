import { useOverallStats, useDailyHistory } from "../hooks/useTrading";
import { BarChart3, TrendingUp, Target, Award, DollarSign, Percent } from "lucide-react";

const pnlColor = (v: number) => v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted-foreground";

function Metric({ label, value, icon: Icon, color }: { label: string; value: string; icon: any; color: string }) {
  return (
    <div className="flex items-center gap-3 p-4 rounded-lg bg-secondary/50">
      <div className="p-2 rounded-lg bg-secondary"><Icon className={`h-4 w-4 ${color}`} /></div>
      <div><p className="text-xs text-muted-foreground">{label}</p><p className={`text-lg font-bold ltr-nums ${color}`}>{value}</p></div>
    </div>
  );
}

export default function ReportsPage() {
  const { data: o } = useOverallStats();
  const { data: hist } = useDailyHistory();

  return (
    <div className="space-y-6 max-w-7xl">
      <div><h1 className="text-2xl font-bold">التقارير</h1><p className="text-sm text-muted-foreground mt-1">نظرة عامة على الأداء</p></div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Metric label="إجمالي الصفقات" value={`${o?.totalTrades ?? 0}`} icon={BarChart3} color="text-blue-400" />
        <Metric label="نسبة الفوز" value={`${o?.winRate ?? 0}%`} icon={Target} color="text-amber-400" />
        <Metric label="معامل الربح" value={`${o?.profitFactor ?? 0}`} icon={Award} color="text-purple-400" />
        <Metric label="إجمالي الربح/الخسارة" value={`$${(o?.totalPnl ?? 0).toFixed(2)}`} icon={DollarSign} color={pnlColor(o?.totalPnl ?? 0)} />
        <Metric label="متوسط الربح" value={`$${(o?.avgWin ?? 0).toFixed(2)}`} icon={TrendingUp} color="text-green-400" />
        <Metric label="متوسط الخسارة" value={`$${(o?.avgLoss ?? 0).toFixed(2)}`} icon={Percent} color="text-red-400" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="font-medium mb-4">تفصيل الفوز والخسارة</h3>
          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span className="text-green-400">فوز: {o?.wins ?? 0}</span>
                <span className="text-red-400">خسارة: {o?.losses ?? 0}</span>
              </div>
              <div className="h-3 rounded-full bg-secondary overflow-hidden flex">
                <div className="bg-green-500 h-full" style={{ width: `${o?.totalTrades ? (o.wins / o.totalTrades) * 100 : 50}%` }} />
                <div className="bg-red-500 h-full" style={{ width: `${o?.totalTrades ? (o.losses / o.totalTrades) * 100 : 50}%` }} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="p-3 rounded-lg bg-green-500/10"><p className="text-muted-foreground">إجمالي الأرباح</p><p className="text-green-400 font-bold text-lg ltr-nums">${(o?.grossProfit ?? 0).toFixed(2)}</p></div>
              <div className="p-3 rounded-lg bg-red-500/10"><p className="text-muted-foreground">إجمالي الخسائر</p><p className="text-red-400 font-bold text-lg ltr-nums">${(o?.grossLoss ?? 0).toFixed(2)}</p></div>
            </div>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="font-medium mb-4">نمو رأس المال</h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center p-3 rounded-lg bg-secondary/50"><span className="text-sm text-muted-foreground">البداية</span><span className="font-bold ltr-nums">$1,000.00</span></div>
            <div className="flex justify-between items-center p-3 rounded-lg bg-secondary/50"><span className="text-sm text-muted-foreground">الحالي</span><span className={`font-bold ltr-nums ${pnlColor((o?.currentCapital ?? 1000) - 1000)}`}>${(o?.currentCapital ?? 1000).toFixed(2)}</span></div>
            <div className="flex justify-between items-center p-3 rounded-lg bg-secondary/50"><span className="text-sm text-muted-foreground">العائد</span><span className={`font-bold ltr-nums ${pnlColor(o?.totalPnl ?? 0)}`}>{((o?.totalPnl ?? 0) / 1000 * 100).toFixed(2)}%</span></div>
          </div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl">
        <div className="p-4 border-b border-border"><h3 className="font-medium">الأداء اليومي</h3></div>
        <div className="p-4">
          {!hist?.length ? <p className="text-sm text-muted-foreground text-center py-8">لا توجد بيانات يومية بعد</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-muted-foreground">
                  <th className="text-right py-3 px-4 font-medium">التاريخ</th>
                  <th className="text-left py-3 px-4 font-medium">الصفقات</th>
                  <th className="text-left py-3 px-4 font-medium">فوز</th>
                  <th className="text-left py-3 px-4 font-medium">خسارة</th>
                  <th className="text-left py-3 px-4 font-medium">نسبة الفوز</th>
                  <th className="text-left py-3 px-4 font-medium">الربح/الخسارة</th>
                </tr></thead>
                <tbody>{hist.map(d => (
                  <tr key={d.date} className="border-b border-border/50 hover:bg-secondary/30">
                    <td className="py-3 px-4 ltr-nums">{d.date}</td>
                    <td className="py-3 px-4 text-left ltr-nums">{d.trades}</td>
                    <td className="py-3 px-4 text-left text-green-400 ltr-nums">{d.wins}</td>
                    <td className="py-3 px-4 text-left text-red-400 ltr-nums">{d.losses}</td>
                    <td className="py-3 px-4 text-left ltr-nums">{d.winRate}%</td>
                    <td className={`py-3 px-4 text-left font-bold ltr-nums ${pnlColor(d.pnl)}`}>{d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

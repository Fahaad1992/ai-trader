import { useBotLogs } from "../hooks/useTrading";
import { Bot, RefreshCw } from "lucide-react";

const levelColor: Record<string, string> = {
  trade: "bg-blue-400", error: "bg-red-400", warn: "bg-amber-400", info: "bg-green-400",
};

const levelAr: Record<string, string> = {
  trade: "صفقة", error: "خطأ", warn: "تحذير", info: "معلومة",
};

export default function LogsPage() {
  const { data: logs, refetch } = useBotLogs(100);

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">سجل البوت</h1>
          <p className="text-sm text-muted-foreground mt-1">{logs?.length ?? 0} سجل</p>
        </div>
        <button onClick={refetch} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary text-foreground text-sm hover:bg-accent transition-colors">
          <RefreshCw className="h-4 w-4" /> تحديث
        </button>
      </div>

      {!logs?.length ? (
        <div className="bg-card border border-border rounded-xl py-16 text-center">
          <Bot className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-lg text-muted-foreground">لا توجد سجلات بعد</p>
          <p className="text-sm text-muted-foreground mt-1">شغّل البوت لرؤية النشاط</p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl divide-y divide-border/50">
          {logs.map(l => (
            <div key={l.id} className="flex items-start gap-3 p-4 hover:bg-secondary/30 transition-colors">
              <div className={`w-2 h-2 rounded-full mt-2 shrink-0 ${levelColor[l.level] ?? 'bg-gray-400'}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                    l.level === 'trade' ? 'bg-blue-500/20 text-blue-400' :
                    l.level === 'error' ? 'bg-red-500/20 text-red-400' :
                    l.level === 'warn' ? 'bg-amber-500/20 text-amber-400' :
                    'bg-green-500/20 text-green-400'
                  }`}>{levelAr[l.level] ?? l.level}</span>
                  <span className="text-xs text-muted-foreground ltr-nums">{new Date(l.createdAt).toLocaleString('ar-SA')}</span>
                </div>
                <p className="text-sm">{l.message}</p>
                {l.details && (
                  <pre className="text-xs text-muted-foreground mt-1 overflow-x-auto ltr-nums">{JSON.stringify(l.details, null, 2)}</pre>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

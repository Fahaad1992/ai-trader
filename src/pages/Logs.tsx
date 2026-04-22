import { useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Bot, RefreshCw } from "lucide-react";
import type { BotLog } from "../../shared/types";
import { useBotLogs, useLastErrors } from "../hooks/useTrading";

const levelColor: Record<string, string> = {
  trade: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  error: "bg-red-500/20 text-red-300 border-red-500/30",
  warn: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  info: "bg-green-500/20 text-green-300 border-green-500/30",
};

const levelAr: Record<string, string> = {
  trade: "صفقة",
  error: "خطأ",
  warn: "تحذير",
  info: "معلومة",
};

function formatDateInput(ts?: number) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toTimestamp(value: string) {
  return value ? new Date(value).getTime() : undefined;
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-border/40 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="text-sm text-right break-all whitespace-pre-wrap ltr-nums">{value ?? "—"}</div>
    </div>
  );
}

function LogDetailCard({ log }: { log: BotLog | null }) {
  if (!log) {
    return (
      <div className="bg-card border border-border rounded-2xl p-6 text-sm text-muted-foreground">
        اختر سجلًا من القائمة لعرض التفاصيل الكاملة للقرار أو الصفقة.
      </div>
    );
  }

  const details = log.contractDetails;
  const showOptionDetails = log.tradeMode !== "futures" && Boolean(log.optionSide || details?.ticker || details?.expiry || details?.strike || details?.delta || details?.iv || details?.openInterest || details?.volume);
  return (
    <div className="bg-card border border-border rounded-2xl p-6 space-y-4 sticky top-4">
      <div>
        <h2 className="text-lg font-bold">تفاصيل السجل</h2>
        <p className="text-xs text-muted-foreground mt-1 ltr-nums">{new Date(log.createdAt).toLocaleString("ar-SA")}</p>
      </div>
      <div className="rounded-xl bg-secondary/30 border border-border/50 p-4">
        <p className="text-sm leading-7 whitespace-pre-wrap break-words">{log.message}</p>
      </div>
      <div className="rounded-xl border border-border/50 p-4">
        <DetailRow label="المستوى" value={levelAr[log.level] ?? log.level} />
        <DetailRow label="الرمز" value={log.symbol} />
        {showOptionDetails && <DetailRow label="الجهة" value={log.optionSide} />}
        <DetailRow label="الثقة" value={log.confidence} />
        <DetailRow label="القرار" value={log.decision} />
        <DetailRow label="الكمون ms" value={log.latencyMs} />
        <DetailRow label="السبب" value={log.reason} />
        <DetailRow label="Bid" value={log.bid} />
        <DetailRow label="Ask" value={log.ask} />
        <DetailRow label="Premium" value={log.premium} />
      </div>
      {showOptionDetails && (
        <div className="rounded-xl border border-border/50 p-4">
          <h3 className="font-semibold mb-3">Contract Details</h3>
          <DetailRow label="Ticker" value={details?.ticker} />
          <DetailRow label="Expiry" value={details?.expiry} />
          <DetailRow label="Strike" value={details?.strike} />
          <DetailRow label="Option Side" value={details?.optionSide} />
          <DetailRow label="Delta" value={details?.delta} />
          <DetailRow label="IV" value={details?.iv} />
          <DetailRow label="Volume" value={details?.volume} />
          <DetailRow label="Open Interest" value={details?.openInterest} />
          <DetailRow label="Strategy" value={details?.strategy} />
        </div>
      )}
      {log.details && (
        <div className="rounded-xl border border-border/50 p-4">
          <h3 className="font-semibold mb-3">البيانات الخام</h3>
          <pre className="text-xs text-muted-foreground overflow-auto whitespace-pre-wrap break-all ltr-nums">{JSON.stringify(log.details, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

export default function LogsPage() {
  const [level, setLevel] = useState("");
  const [symbol, setSymbol] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const filters = useMemo(() => ({
    limit: 500,
    level: level || undefined,
    symbol: symbol || undefined,
    from: toTimestamp(from),
    to: toTimestamp(to),
  }), [from, level, symbol, to]);

  const { data: logs, refetch } = useBotLogs(filters);
  const { data: lastErrors } = useLastErrors(20);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedLog = useMemo(
    () => logs?.find((item) => item.id === selectedId) ?? logs?.[0] ?? null,
    [logs, selectedId],
  );

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">السجل والإحصائيات التشغيلية</h1>
          <p className="text-sm text-muted-foreground mt-1">عرض كامل للسجلات بدون قص مع فلاتر وتفاصيل وآخر الأخطاء.</p>
        </div>
        <button onClick={refetch} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary text-foreground text-sm hover:bg-accent transition-colors">
          <RefreshCw className="h-4 w-4" /> تحديث
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <select value={level} onChange={(e) => setLevel(e.target.value)} className="rounded-xl border border-border bg-card px-3 py-2 text-sm">
          <option value="">كل المستويات</option>
          <option value="info">INFO</option>
          <option value="warn">WARN</option>
          <option value="error">ERROR</option>
          <option value="trade">TRADE</option>
        </select>
        <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="فلترة حسب الرمز" className="rounded-xl border border-border bg-card px-3 py-2 text-sm" />
        <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} max={to || undefined} className="rounded-xl border border-border bg-card px-3 py-2 text-sm ltr-nums" />
        <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} min={from || undefined} className="rounded-xl border border-border bg-card px-3 py-2 text-sm ltr-nums" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-6">
        <div className="space-y-6">
          {!logs?.length ? (
            <div className="bg-card border border-border rounded-xl py-16 text-center">
              <Bot className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-lg text-muted-foreground">لا توجد سجلات ضمن الفلاتر الحالية</p>
            </div>
          ) : (
            <div className="bg-card border border-border rounded-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border/50 text-sm text-muted-foreground">{logs.length} سجل</div>
              <div className="max-h-[720px] overflow-auto divide-y divide-border/40">
                {logs.map((log) => (
                  <button
                    key={log.id}
                    onClick={() => setSelectedId(log.id)}
                    className={`w-full text-right px-4 py-4 transition-colors hover:bg-secondary/30 ${selectedLog?.id === log.id ? "bg-secondary/40" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`px-2 py-1 rounded-md border text-xs font-medium ${levelColor[log.level] ?? "bg-muted text-foreground border-border"}`}>
                            {levelAr[log.level] ?? log.level}
                          </span>
                          {log.symbol && <span className="text-xs rounded-md bg-secondary px-2 py-1">{log.symbol}</span>}
                          {log.decision && <span className="text-xs rounded-md bg-secondary px-2 py-1">{log.decision}</span>}
                          {log.optionSide && <span className="text-xs rounded-md bg-secondary px-2 py-1">{log.optionSide}</span>}
                        </div>
                        <p className="text-sm leading-7 whitespace-pre-wrap break-words">{log.message}</p>
                        <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground ltr-nums">
                          <span>{new Date(log.createdAt).toLocaleString("ar-SA")}</span>
                          {log.confidence !== null && log.confidence !== undefined && <span>Conf: {log.confidence}</span>}
                          {log.latencyMs !== null && log.latencyMs !== undefined && <span>Latency: {log.latencyMs} ms</span>}
                          {log.premium !== null && log.premium !== undefined && <span>Premium: {log.premium}</span>}
                          {log.bid !== null && log.bid !== undefined && <span>Bid: {log.bid}</span>}
                          {log.ask !== null && log.ask !== undefined && <span>Ask: {log.ask}</span>}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="bg-card border border-border rounded-2xl p-5 space-y-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-400" />
              <h2 className="text-lg font-bold">Last Errors</h2>
            </div>
            {!lastErrors?.length ? (
              <p className="text-sm text-muted-foreground">لا توجد أخطاء حديثة.</p>
            ) : (
              <div className="space-y-3">
                {lastErrors.map((item) => (
                  <div key={item.id} className="rounded-xl border border-red-500/20 bg-red-500/5 p-3">
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground ltr-nums">
                      <span>{item.symbol ?? "—"}</span>
                      <span>{new Date(item.createdAt).toLocaleString("ar-SA")}</span>
                    </div>
                    <p className="text-sm mt-2 whitespace-pre-wrap break-words">{item.message}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <LogDetailCard log={selectedLog} />
      </div>
    </div>
  );
}

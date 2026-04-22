import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type {
  BotStatus,
  Trade,
  BotLog,
  DailyStats,
  OverallStats,
  DailyHistory,
  BotConfig,
  SmartBrainStatsReport,
} from "../../shared/types";

type BotLogFilters = {
  limit?: number;
  level?: string;
  symbol?: string;
  from?: number;
  to?: number;
};

const DEFAULT_POLLING_INTERVAL = 5000;

function buildQuery(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

function usePolling<T>(path: string, interval = DEFAULT_POLLING_INTERVAL) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    api.get<T>(path)
      .then((value) => {
        setData(value);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [path]);

  useEffect(() => {
    refetch();
    const id = setInterval(refetch, interval);
    return () => clearInterval(id);
  }, [refetch, interval]);

  return { data, error, refetch };
}

export function useBotStatus() { return usePolling<BotStatus>("/bot/status"); }
export function useOpenTrades() { return usePolling<Trade[]>("/trades/open"); }
export function useClosedTrades() { return usePolling<Trade[]>("/trades/closed"); }
export function useDailyStats() { return usePolling<DailyStats>("/stats/daily"); }
export function useOverallStats() { return usePolling<OverallStats>("/stats/overall"); }
export function useDailyHistory() { return usePolling<DailyHistory[]>("/stats/history"); }
export function useConfig() { return usePolling<BotConfig>("/config"); }
export function useSmartBrainStats() { return usePolling<SmartBrainStatsReport>("/stats/smart-brain"); }

export function useBotLogs(filters: BotLogFilters = {}) {
  const path = useMemo(() => `/bot/logs${buildQuery({
    limit: filters.limit ?? 100,
    level: filters.level,
    symbol: filters.symbol,
    from: filters.from,
    to: filters.to,
  })}`,
  [filters.limit, filters.level, filters.symbol, filters.from, filters.to]);

  return usePolling<BotLog[]>(path);
}

export function useLastErrors(limit = 20) {
  return usePolling<BotLog[]>(`/bot/last-errors${buildQuery({ limit })}`);
}

export function useBotControl() {
  const start = () => api.post("/bot/start");
  const stop = () => api.post("/bot/stop");
  return { start, stop };
}

export function useCloseTrade() {
  return (tradeId: string, currentPremium?: number) =>
    api.post("/trades/close", { tradeId, currentPremium });
}

export function useUpdateConfig() {
  return (config: Partial<BotConfig>) => api.put("/config", config);
}

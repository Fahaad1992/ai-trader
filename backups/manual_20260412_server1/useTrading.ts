import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import type { BotStatus, Trade, BotLog, DailyStats, OverallStats, DailyHistory, BotConfig } from "../../shared/types";

function usePolling<T>(path: string, interval: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    api.get<T>(path).then(setData).catch(e => setError(e.message));
  }, [path]);

  useEffect(() => {
    refetch();
    const id = setInterval(refetch, interval);
    return () => clearInterval(id);
  }, [refetch, interval]);

  return { data, error, refetch };
}

export function useBotStatus() { return usePolling<BotStatus>("/bot/status", 1000); }
export function useOpenTrades() { return usePolling<Trade[]>("/trades/open", 1000); }
export function useClosedTrades() { return usePolling<Trade[]>("/trades/closed", 5000); }
export function useBotLogs(limit = 50) { return usePolling<BotLog[]>(`/bot/logs?limit=${limit}`, 3000); }
export function useDailyStats() { return usePolling<DailyStats>("/stats/daily", 1000); }
export function useOverallStats() { return usePolling<OverallStats>("/stats/overall", 1000); }
export function useDailyHistory() { return usePolling<DailyHistory[]>("/stats/history", 10000); }
export function useConfig() { return usePolling<BotConfig>("/config", 30000); }

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

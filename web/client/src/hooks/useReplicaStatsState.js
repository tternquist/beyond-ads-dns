import { useEffect, useState } from "react";
import { api } from "../utils/apiClient.js";

/**
 * Per-feature hook for Replica Stats (Multi-Instance) page state.
 * Owns instance stats. Only fetches when sync is enabled as primary.
 */
export function useReplicaStatsState(activeTab, syncStatus) {
  const [instanceStats, setInstanceStats] = useState(null);
  const [instanceStatsError, setInstanceStatsError] = useState("");
  const [instanceStatsUpdatedAt, setInstanceStatsUpdatedAt] = useState(null);

  useEffect(() => {
    if (activeTab !== "replica-stats" || !syncStatus?.enabled || syncStatus?.role !== "primary") {
      return;
    }
    let isMounted = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await api.get("/api/instances/stats", { signal: controller.signal });
        if (!isMounted) return;
        setInstanceStats(data);
        setInstanceStatsError("");
        setInstanceStatsUpdatedAt(new Date());
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setInstanceStatsError(err.message || "Failed to load instance stats");
      }
    };
    load();
    const interval = setInterval(load, 15000);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [activeTab, syncStatus?.enabled, syncStatus?.role]);

  return {
    instanceStats,
    instanceStatsError,
    instanceStatsUpdatedAt,
  };
}

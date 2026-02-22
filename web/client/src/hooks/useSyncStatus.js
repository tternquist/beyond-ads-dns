import { useEffect, useState, useCallback } from "react";
import { api } from "../utils/apiClient.js";

/**
 * Lightweight hook for sync status used by sidebar and isReplica checks.
 * Polls /api/sync/status every 30s. Used at app level for cross-cutting concerns.
 */
export function useSyncStatus() {
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncError, setSyncError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const data = await api.get("/api/sync/status");
      setSyncStatus(data);
      setSyncError("");
    } catch (err) {
      setSyncStatus(null);
      setSyncError(err.message || "Failed to load sync status");
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await api.get("/api/sync/status", { signal: controller.signal });
        if (!isMounted) return;
        setSyncStatus(data);
        setSyncError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setSyncStatus(null);
        setSyncError(err.message || "Failed to load sync status");
      }
    };
    load();
    const interval = setInterval(load, 30000);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, []);

  return { syncStatus, syncError, refresh };
}

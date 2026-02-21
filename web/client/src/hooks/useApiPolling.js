import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "../utils/apiClient.js";

export function useApiPolling(url, { interval = 0, enabled = true, dependencies = [] } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (!enabled || !url) return;
    setLoading(true);
    try {
      const result = await api.get(url);
      if (!mountedRef.current) return;
      setData(result);
      setError("");
      setUpdatedAt(new Date());
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err.message || "Request failed");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [url, enabled]);

  const reload = useCallback(() => {
    load();
  }, [load]);

  useEffect(() => {
    mountedRef.current = true;
    load();
    const timer = interval > 0 ? setInterval(load, interval) : null;
    return () => {
      mountedRef.current = false;
      if (timer) clearInterval(timer);
    };
  }, [load, interval, ...dependencies]);

  return { data, error, loading, updatedAt, reload, setData, setError };
}

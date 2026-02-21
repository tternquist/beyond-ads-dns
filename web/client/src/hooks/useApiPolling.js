import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "../utils/apiClient.js";

export function useApiPolling(url, { interval = 0, enabled = true, dependencies = [] } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const mountedRef = useRef(true);

  const load = useCallback(async (signal) => {
    if (!enabled || !url) return;
    setLoading(true);
    try {
      const result = await api.get(url, { signal });
      if (!mountedRef.current) return;
      setData(result);
      setError("");
      setUpdatedAt(new Date());
    } catch (err) {
      if (err.name === "AbortError") return;
      if (!mountedRef.current) return;
      setError(err.message || "Request failed");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [url, enabled]);

  const reload = useCallback(() => {
    load(null); // reload without abort (user-initiated)
  }, [load]);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    load(controller.signal);
    let timer = null;
    if (interval > 0) {
      const scheduleNext = () => {
        const ms = document.visibilityState === "hidden" ? interval * 5 : interval;
        timer = setTimeout(() => {
          load(controller.signal);
          scheduleNext();
        }, ms);
      };
      scheduleNext();
    }
    return () => {
      mountedRef.current = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [load, interval, ...dependencies]);

  return { data, error, loading, updatedAt, reload, setData, setError };
}

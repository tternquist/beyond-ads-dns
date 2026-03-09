import { useEffect, useState, useMemo } from "react";
import { api } from "../utils/apiClient.js";
import { useToast } from "../context/ToastContext.jsx";
import { useConfirm } from "../context/ConfirmContext.jsx";
import { validateLocalRecordsForm } from "../utils/validation.js";

/**
 * Hook for Local Records page state.
 * Loads and manages local DNS records only.
 */
export function useLocalRecordsState() {
  const { addToast } = useToast();
  const { confirm } = useConfirm();

  const [localRecords, setLocalRecords] = useState([]);
  const [localRecordsError, setLocalRecordsError] = useState("");
  const [localRecordsStatus, setLocalRecordsStatus] = useState("");
  const [localRecordsLoading, setLocalRecordsLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  const localRecordsValidation = useMemo(
    () => validateLocalRecordsForm(localRecords),
    [localRecords]
  );

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await api.get("/api/dns/local-records", {
          signal: controller.signal,
        });
        if (!isMounted) return;
        setLocalRecords(Array.isArray(data.records) ? data.records : []);
        setLocalRecordsError("");
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
        setLocalRecordsError(err.message || "Failed to load local records");
      } finally {
        if (isMounted) setInitialLoading(false);
      }
    };
    load();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, []);

  const updateLocalRecord = (index, field, value) => {
    setLocalRecords((prev) =>
      prev.map((rec, idx) =>
        idx === index ? { ...rec, [field]: value } : rec
      )
    );
  };

  const addLocalRecord = () => {
    setLocalRecords((prev) => [...prev, { name: "", type: "A", value: "" }]);
  };

  const removeLocalRecord = (index) => {
    setLocalRecords((prev) => prev.filter((_, idx) => idx !== index));
  };

  const saveLocalRecords = async () => {
    setLocalRecordsStatus("");
    setLocalRecordsError("");
    const validation = validateLocalRecordsForm(localRecords);
    if (validation.hasErrors) {
      setLocalRecordsError(
        validation.summary || "Please fix validation errors before saving."
      );
      return false;
    }
    try {
      setLocalRecordsLoading(true);
      const data = await api.put("/api/dns/local-records", {
        records: validation.normalizedRecords,
      });
      setLocalRecordsStatus("Saved");
      setLocalRecords(validation.normalizedRecords);
      return true;
    } catch (err) {
      setLocalRecordsError(err.message || "Failed to save local records");
      return false;
    } finally {
      setLocalRecordsLoading(false);
    }
  };

  const applyLocalRecords = async () => {
    const saved = await saveLocalRecords();
    if (!saved) return;
    try {
      setLocalRecordsLoading(true);
      await api.post("/api/dns/local-records/apply");
      setLocalRecordsStatus("Applied");
      addToast("Local records applied successfully", "success");
    } catch (err) {
      setLocalRecordsError(err.message || "Failed to apply local records");
      addToast(err.message || "Failed to apply local records", "error");
    } finally {
      setLocalRecordsLoading(false);
    }
   };

  const confirmApplyLocalRecords = () => {
    confirm({
      title: "Apply local records",
      message: "This will update local DNS records immediately. Continue?",
      confirmLabel: "Apply",
      onConfirm: applyLocalRecords,
    });
  };

  const removeSelectedRecords = (indices) => {
    const sorted = [...indices].sort((a, b) => b - a);
    setLocalRecords((prev) =>
      prev.filter((_, idx) => !sorted.includes(idx))
    );
  };

  return {
    initialLoading,
    localRecords,
    localRecordsError,
    localRecordsStatus,
    localRecordsLoading,
    localRecordsValidation,
    saveLocalRecords,
    confirmApplyLocalRecords,
    updateLocalRecord,
    removeLocalRecord,
    addLocalRecord,
    removeSelectedRecords,
  };
}

import { useEffect, useState } from "react";
import { api } from "../utils/apiClient.js";
import { useConfirm } from "../context/ConfirmContext.jsx";
import { useToast } from "../context/ToastContext.jsx";

/**
 * Per-feature hook for Integrations page state.
 * Owns webhooks data, collapsed sections, restart prompt.
 */
export function useIntegrationsState() {
  const { confirm } = useConfirm();
  const { addToast } = useToast();

  const [webhooksData, setWebhooksData] = useState(null);
  const [webhooksError, setWebhooksError] = useState("");
  const [webhooksLoading, setWebhooksLoading] = useState(false);
  const [webhooksStatus, setWebhooksStatus] = useState("");
  const [webhookTestResult, setWebhookTestResult] = useState(null);
  const [collapsedSections, setCollapsedSections] = useState({});

  const toggleCollapsedSection = (id) => {
    setCollapsedSections((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const load = async () => {
      setWebhooksLoading(true);
      setWebhooksError("");
      try {
        const data = await api.get("/api/webhooks", { signal: controller.signal });
        if (!isMounted) return;
        setWebhooksData(data);
        setWebhooksError("");
      } catch (err) {
        if (!isMounted) return;
        setWebhooksData(null);
        setWebhooksError(err.message || "Failed to load webhooks");
      } finally {
        if (isMounted) setWebhooksLoading(false);
      }
    };
    load();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, []);

  const showRestartRequiredPrompt = (message) => {
    confirm({
      title: "Restart required",
      message: message || "Changes have been saved. Restart the service to apply them. Restart now?",
      confirmLabel: "Restart",
      cancelLabel: "Later",
      variant: "danger",
      onConfirm: async () => {
        await api.post("/api/restart");
      },
    });
  };

  return {
    webhooksData,
    setWebhooksData,
    webhookTestResult,
    setWebhookTestResult,
    webhooksError,
    webhooksStatus,
    setWebhooksStatus,
    setWebhooksError,
    webhooksLoading,
    collapsedSections,
    setCollapsedSections,
    toggleCollapsedSection,
    showRestartRequiredPrompt,
    addToast,
  };
}

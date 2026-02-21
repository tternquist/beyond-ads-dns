import { api } from "../utils/apiClient.js";
import CollapsibleSection from "../components/CollapsibleSection.jsx";
import { SkeletonCard } from "../components/Skeleton.jsx";


export default function IntegrationsPage({
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
  setConfirmState,
  addToast,
  restartService,
}) {
  return (
    <section className="section">
      <div className="section-header">
        <h2>Integrations</h2>
      </div>
      <p className="muted">
        Manage webhooks for block and error events. Webhooks send HTTP POST
        requests to your configured URLs when DNS queries are blocked or result in
        errors. Restart required after saving.
      </p>
      {webhooksError && <div className="error">{webhooksError}</div>}
      {webhooksStatus && <div className="success">{webhooksStatus}</div>}
      {webhooksLoading && !webhooksData ? (
        <SkeletonCard />
      ) : webhooksData ? (
        <div className="integrations-webhooks">
          {[
            {
              key: "on_block",
              label: "Block webhook",
              description:
                "Fires when a DNS query is blocked by the blocklist (ads, trackers, malware).",
            },
            {
              key: "on_error",
              label: "Error webhook",
              description:
                "Fires when a DNS query results in an error (upstream failure, SERVFAIL, invalid query).",
            },
          ].map(({ key, label, description }) => {
            const hook = webhooksData[key] || {};
            const targetTypes = webhooksData.targets || [];
            const hookTargets = Array.isArray(hook.targets) ? hook.targets : [];
            return (
              <CollapsibleSection
                key={key}
                id={`webhook-${key}`}
                title={label}
                defaultCollapsed={false}
                collapsedSections={collapsedSections}
                onToggle={setCollapsedSections}
              >
                <p className="muted" style={{ marginTop: 0 }}>
                  {description}
                </p>
                <div className="integrations-form">
                  <div className="form-row">
                    <label>
                      <input
                        type="checkbox"
                        checked={hook.enabled ?? false}
                        onChange={(e) => {
                          setWebhooksData((prev) => ({
                            ...prev,
                            [key]: { ...prev[key], enabled: e.target.checked },
                          }));
                        }}
                      />
                      <span>Enable webhook</span>
                    </label>
                  </div>
                  <div
                    className="form-row"
                    style={{
                      display: "flex",
                      gap: "1rem",
                      flexWrap: "wrap",
                      alignItems: "flex-end",
                    }}
                  >
                    <label>
                      Rate limit (max messages in timeframe, default for new
                      targets)
                      <div
                        style={{
                          display: "flex",
                          gap: "0.5rem",
                          alignItems: "center",
                          marginTop: "0.25rem",
                        }}
                      >
                        <input
                          type="number"
                          className="input"
                          min={-1}
                          max={10000}
                          style={{ width: 100 }}
                          value={hook.rate_limit_max_messages ?? 60}
                          onChange={(e) =>
                            setWebhooksData((prev) => ({
                              ...prev,
                              [key]: {
                                ...prev[key],
                                rate_limit_max_messages:
                                  e.target.value === ""
                                    ? 60
                                    : Number(e.target.value),
                              },
                            }))
                          }
                          placeholder="60"
                        />
                        <span className="muted">per</span>
                        <input
                          type="text"
                          className="input"
                          style={{ width: 100 }}
                          value={hook.rate_limit_timeframe ?? "1m"}
                          onChange={(e) =>
                            setWebhooksData((prev) => ({
                              ...prev,
                              [key]: {
                                ...prev[key],
                                rate_limit_timeframe:
                                  e.target.value || "1m",
                              },
                            }))
                          }
                          placeholder="1m"
                          list="timeframe-suggestions"
                        />
                        <datalist id="timeframe-suggestions">
                          <option value="30s" />
                          <option value="1m" />
                          <option value="5m" />
                          <option value="15m" />
                          <option value="1h" />
                        </datalist>
                      </div>
                    </label>
                    <span className="muted" style={{ fontSize: 12 }}>
                      Use -1 for unlimited. Timeframe: 30s, 1m, 5m, 1h, etc.
                    </span>
                  </div>
                  <div className="form-row">
                    <label>
                      Targets (each target gets its own URL, format, and context)
                    </label>
                    <div className="webhook-targets-list">
                      {hookTargets.map((tgt, idx) => (
                        <div key={idx} className="webhook-target-card">
                          <div className="form-row">
                            <label>
                              URL <span className="required">*</span>
                              <input
                                type="url"
                                className="input"
                                value={tgt.url || ""}
                                onChange={(e) => {
                                  const next = [...hookTargets];
                                  next[idx] = { ...next[idx], url: e.target.value };
                                  setWebhooksData((prev) => ({
                                    ...prev,
                                    [key]: { ...prev[key], targets: next },
                                  }));
                                }}
                                placeholder="https://example.com/webhook"
                              />
                            </label>
                          </div>
                          <div className="form-row">
                            <label>
                              Format
                              <select
                                className="input"
                                value={tgt.target || "default"}
                                onChange={(e) => {
                                  const next = [...hookTargets];
                                  next[idx] = {
                                    ...next[idx],
                                    target: e.target.value,
                                  };
                                  setWebhooksData((prev) => ({
                                    ...prev,
                                    [key]: { ...prev[key], targets: next },
                                  }));
                                }}
                              >
                                {targetTypes.map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>
                          <div className="form-row">
                            <label>
                              Context (optional metadata for this target)
                            </label>
                            <div className="context-items">
                              {Object.entries(tgt.context || {}).map(
                                ([k, v]) => (
                                  <div key={k} className="context-item">
                                    <input
                                      type="text"
                                      className="input"
                                      value={k}
                                      readOnly
                                      style={{ width: 120 }}
                                    />
                                    <span className="context-value">
                                      {Array.isArray(v)
                                        ? v.join(", ")
                                        : String(v)}
                                    </span>
                                    <button
                                      type="button"
                                      className="button"
                                      onClick={() => {
                                        const ctx = { ...(tgt.context || {}) };
                                        delete ctx[k];
                                        const next = [...hookTargets];
                                        next[idx] = {
                                          ...next[idx],
                                          context: ctx,
                                        };
                                        setWebhooksData((prev) => ({
                                          ...prev,
                                          [key]: {
                                            ...prev[key],
                                            targets: next,
                                          },
                                        }));
                                      }}
                                    >
                                      Remove
                                    </button>
                                  </div>
                                )
                              )}
                              <div className="context-add">
                                <input
                                  type="text"
                                  id={`ctx-key-${key}-${idx}`}
                                  className="input"
                                  placeholder="Key (e.g. environment)"
                                  style={{ width: 140 }}
                                />
                                <input
                                  type="text"
                                  id={`ctx-val-${key}-${idx}`}
                                  className="input"
                                  placeholder="Value or comma-separated list"
                                  style={{ width: 180 }}
                                />
                                <button
                                  type="button"
                                  className="button"
                                  onClick={() => {
                                    const keyInput = document.getElementById(
                                      `ctx-key-${key}-${idx}`
                                    );
                                    const valInput = document.getElementById(
                                      `ctx-val-${key}-${idx}`
                                    );
                                    const k = (keyInput?.value || "").trim();
                                    const v = (valInput?.value || "").trim();
                                    if (!k) return;
                                    const parsed = v.includes(",")
                                      ? v
                                          .split(",")
                                          .map((s) => s.trim())
                                          .filter(Boolean)
                                      : v;
                                    const ctx = { ...(tgt.context || {}) };
                                    ctx[k] =
                                      Array.isArray(parsed) && parsed.length > 1
                                        ? parsed
                                        : parsed || "";
                                    const next = [...hookTargets];
                                    next[idx] = {
                                      ...next[idx],
                                      context: ctx,
                                    };
                                    setWebhooksData((prev) => ({
                                      ...prev,
                                      [key]: { ...prev[key], targets: next },
                                    }));
                                    if (keyInput) keyInput.value = "";
                                    if (valInput) valInput.value = "";
                                  }}
                                >
                                  Add
                                </button>
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="button"
                            onClick={() => {
                              const next = hookTargets.filter(
                                (_, i) => i !== idx
                              );
                              setWebhooksData((prev) => ({
                                ...prev,
                                [key]: { ...prev[key], targets: next },
                              }));
                              if (webhookTestResult?.key === key)
                                setWebhookTestResult(null);
                            }}
                          >
                            Remove target
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="button"
                        onClick={() => {
                          const next = [
                            ...hookTargets,
                            { url: "", target: "default", context: {} },
                          ];
                          setWebhooksData((prev) => ({
                            ...prev,
                            [key]: { ...prev[key], targets: next },
                          }));
                        }}
                      >
                        Add target
                      </button>
                    </div>
                  </div>
                  <div className="form-row integrations-actions">
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        setWebhooksData((prev) => ({
                          ...prev,
                          [key]: {
                            enabled: false,
                            targets: [],
                            rate_limit_max_messages: 60,
                            rate_limit_timeframe: "1m",
                          },
                        }));
                        setWebhookTestResult(null);
                      }}
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={async () => {
                        setWebhookTestResult(null);
                        const validTargets = hookTargets.filter((t) =>
                          t?.url?.trim()
                        );
                        if (validTargets.length === 0) {
                          setWebhookTestResult({
                            key,
                            ok: false,
                            error: "Add at least one target with URL",
                          });
                          return;
                        }
                        try {
                          const data = await api.post("/api/webhooks/test", {
                            type: key,
                            targets: validTargets.map((t) => ({
                              url: t.url,
                              target: t.target || "default",
                              context: t.context || {},
                            })),
                          });
                          setWebhookTestResult({
                            key,
                            ok: data.ok,
                            message: data.message,
                            error: data.error,
                            results: data.results,
                          });
                        } catch (err) {
                          setWebhookTestResult({
                            key,
                            ok: false,
                            error: err.message || "Test failed",
                          });
                        }
                      }}
                      disabled={
                        hookTargets.filter((t) => t?.url?.trim()).length === 0
                      }
                    >
                      Test webhook
                    </button>
                    {webhookTestResult?.key === key && (
                      <span
                        className={
                          webhookTestResult.ok ? "success" : "error"
                        }
                      >
                        {webhookTestResult.ok
                          ? webhookTestResult.message
                          : webhookTestResult.error}
                        {webhookTestResult.results?.length > 1 &&
                          webhookTestResult.ok && (
                            <span
                              className="muted"
                              style={{ marginLeft: 8 }}
                            >
                              (
                              {webhookTestResult.results
                                .map((r) => (r.ok ? "✓" : "✗"))
                                .join(" ")}
                              )
                            </span>
                          )}
                      </span>
                    )}
                  </div>
                </div>
              </CollapsibleSection>
            );
          })}
          <div className="integrations-save">
            <button
              type="button"
              className="button button-primary"
              onClick={async () => {
                setWebhooksStatus("");
                setWebhooksError("");
                try {
                  const data = await api.put("/api/webhooks", {
                    on_block: webhooksData.on_block,
                    on_error: webhooksData.on_error,
                  });
                  setWebhooksStatus(data.message || "Saved");
                  addToast(
                    "Webhooks saved. Restart required to apply.",
                    "success"
                  );
                  setConfirmState({
                    open: true,
                    title: "Restart required",
                    message:
                      "Webhooks saved. Restart the DNS service to apply webhook changes.",
                    confirmLabel: "Restart",
                    cancelLabel: "Later",
                    variant: "danger",
                    onConfirm: restartService,
                  });
                } catch (err) {
                  setWebhooksError(err.message || "Failed to save webhooks");
                }
              }}
            >
              Save webhooks
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

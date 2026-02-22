/**
 * Application Logging and Request Logging settings section for the System Settings page.
 * Shown when "Show advanced settings" is enabled.
 */
export default function LoggingSettings({
  systemConfig,
  updateSystemConfig,
}) {
  return (
    <>
      <h3 style={{ marginTop: "2rem" }}>Application Logging</h3>
      <p className="muted" style={{ marginBottom: "0.5rem" }}>
        Log format and level (affects Error Viewer and stdout).
      </p>
      <div className="form-group">
        <label className="field-label">Log level</label>
        <select
          className="input"
          value={systemConfig.logging?.level ?? systemConfig.control?.errors_log_level ?? "warning"}
          onChange={(e) =>
            updateSystemConfig("logging", "level", e.target.value)
          }
          style={{ maxWidth: "120px" }}
        >
          <option value="error">Error</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
          Minimum severity for stdout and Error Viewer. Debug = verbose; Error = critical only. Default: warning.
        </p>
      </div>
      <div className="form-group">
        <label className="field-label">Log format</label>
        <select
          className="input"
          value={systemConfig.logging?.format ?? "text"}
          onChange={(e) =>
            updateSystemConfig("logging", "format", e.target.value)
          }
          style={{ maxWidth: "120px" }}
        >
          <option value="text">Text</option>
          <option value="json">JSON</option>
        </select>
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
          Text = human-readable; JSON = structured for Grafana, Loki, or log aggregators. Default: text.
        </p>
      </div>
      <h3 style={{ marginTop: "2rem" }}>Request Logging</h3>
      <p className="muted" style={{ marginBottom: "0.5rem" }}>
        Log DNS requests to disk for debugging.
      </p>
      <label className="checkbox" style={{ display: "block", marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={systemConfig.request_log?.enabled === true}
          onChange={(e) =>
            updateSystemConfig("request_log", "enabled", e.target.checked)
          }
        />
        {" "}Enable request logging
      </label>
      <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem", marginBottom: "0.5rem" }}>
        Log every DNS request to disk. Use for debugging; can be high volume.
      </p>
      {systemConfig.request_log?.enabled && (
        <>
          <div className="form-group">
            <label className="field-label">Directory</label>
            <input
              className="input"
              type="text"
              value={systemConfig.request_log?.directory ?? "logs"}
              onChange={(e) =>
                updateSystemConfig(
                  "request_log",
                  "directory",
                  e.target.value
                )
              }
              placeholder="logs"
              style={{ maxWidth: "200px" }}
            />
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
              Directory for request log files. Relative to app working directory. Default: logs.
            </p>
          </div>
          <div className="form-group">
            <label className="field-label">Filename prefix</label>
            <input
              className="input"
              type="text"
              value={systemConfig.request_log?.filename_prefix ?? "dns-requests"}
              onChange={(e) =>
                updateSystemConfig(
                  "request_log",
                  "filename_prefix",
                  e.target.value
                )
              }
              placeholder="dns-requests"
              style={{ maxWidth: "200px" }}
            />
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
              Prefix for request log filenames (e.g. dns-requests-2025-02-21.log). Default: dns-requests.
            </p>
          </div>
          <div className="form-group">
            <label className="field-label">Format</label>
            <select
              className="input"
              value={systemConfig.request_log?.format ?? "text"}
              onChange={(e) =>
                updateSystemConfig(
                  "request_log",
                  "format",
                  e.target.value
                )
              }
              style={{ maxWidth: "120px" }}
            >
              <option value="text">Text</option>
              <option value="json">JSON</option>
            </select>
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
              Text = human-readable; JSON = structured with query_id, qname, outcome, latency. Default: text.
            </p>
          </div>
        </>
      )}
    </>
  );
}

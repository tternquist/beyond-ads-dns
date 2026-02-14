import { useState } from "react";
import { stringify as stringifyYaml } from "yaml";

const CONFIG_SECTION_ORDER = [
  "server",
  "control",
  "ui",
  "cache",
  "query_store",
  "upstreams",
  "resolver_strategy",
  "blocklists",
  "local_records",
  "response",
  "safe_search",
  "request_log",
  "client_identification",
  "doh_dot_server",
  "sync",
  "webhooks",
];

function ConfigSection({ title, data, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  if (data === undefined || data === null) return null;
  const isEmpty = typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 0;
  if (isEmpty) return null;

  const isObject = typeof data === "object" && data !== null;
  const isArray = Array.isArray(data);

  return (
    <div className="config-section">
      <button
        type="button"
        className="config-section-header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="config-section-chevron">{open ? "▼" : "▶"}</span>
        <span className="config-section-title">{title}</span>
      </button>
      {open && (
        <div className="config-section-body">
          {isObject && !isArray ? (
            <dl className="config-dl">
              {Object.entries(data).map(([key, value]) => (
                <ConfigValue key={key} label={key} value={value} />
              ))}
            </dl>
          ) : (
            <ConfigValue label="" value={data} />
          )}
        </div>
      )}
    </div>
  );
}

function ConfigValue({ label, value }) {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const allSimple = value.every((v) => typeof v !== "object" || v === null);
    if (allSimple) {
      return (
        <div className="config-row">
          {label && <dt className="config-key">{label}</dt>}
          <dd className="config-value">
            <ul className="config-list">
              {value.map((item, i) => (
                <li key={i}>{formatScalar(item)}</li>
              ))}
            </ul>
          </dd>
        </div>
      );
    }
    return (
      <div className="config-row config-row-nested">
        {label && <dt className="config-key">{label}</dt>}
        <dd className="config-value">
          <div className="config-array">
            {value.map((item, i) =>
              typeof item === "object" && item !== null ? (
                <div key={i} className="config-nested-object">
                  {Object.entries(item).map(([k, v]) => (
                    <ConfigValue key={k} label={k} value={v} />
                  ))}
                </div>
              ) : (
                <div key={i} className="config-array-item">{formatScalar(item)}</div>
              )
            )}
          </div>
        </dd>
      </div>
    );
  }

  if (typeof value === "object") {
    return (
      <div className="config-row config-row-nested">
        {label && <dt className="config-key">{label}</dt>}
        <dd className="config-value">
          <dl className="config-dl config-dl-inline">
            {Object.entries(value).map(([k, v]) => (
              <ConfigValue key={k} label={k} value={v} />
            ))}
          </dl>
        </dd>
      </div>
    );
  }

  return (
    <div className="config-row">
      {label && <dt className="config-key">{label}</dt>}
      <dd className="config-value">{formatScalar(value)}</dd>
    </div>
  );
}

function formatScalar(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function formatSectionKey(key) {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function ConfigViewer({ config }) {
  const [viewMode, setViewMode] = useState("structured"); // "structured" | "yaml" | "json"

  if (!config) return <p className="muted">Loading...</p>;

  return (
    <div className="config-viewer">
      <div className="config-viewer-toolbar">
        <span className="config-viewer-label">View:</span>
        <div className="config-view-mode-buttons">
          {[
            { id: "structured", label: "Structured" },
            { id: "yaml", label: "YAML" },
            { id: "json", label: "JSON" },
          ].map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`button ${viewMode === id ? "primary" : ""}`}
              onClick={() => setViewMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {viewMode === "structured" && (
        <div className="config-sections">
          {CONFIG_SECTION_ORDER.filter((key) => config[key] !== undefined).map((key) => (
            <ConfigSection
              key={key}
              title={formatSectionKey(key)}
              data={config[key]}
              defaultOpen={["blocklists", "upstreams", "server"].includes(key)}
            />
          ))}
          {Object.keys(config)
            .filter((key) => !CONFIG_SECTION_ORDER.includes(key))
            .map((key) => (
              <ConfigSection
                key={key}
                title={formatSectionKey(key)}
                data={config[key]}
              />
            ))}
        </div>
      )}

      {viewMode === "yaml" && (
        <pre className="code-block config-raw">
          {stringifyYaml(config, { lineWidth: 0, defaultStringType: "PLAIN" })}
        </pre>
      )}

      {viewMode === "json" && (
        <pre className="code-block config-raw">
          {JSON.stringify(config, null, 2)}
        </pre>
      )}
    </div>
  );
}

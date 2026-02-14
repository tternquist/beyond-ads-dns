import { useEffect, useState } from "react";
import { parse as parseYAML } from "yaml";
import { getStoredTheme, setTheme } from "./theme.js";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Legend,
  AreaChart,
  Area,
} from "recharts";

const REFRESH_OPTIONS = [
  { label: "5s", value: 5000 },
  { label: "15s", value: 15000 },
  { label: "30s", value: 30000 },
  { label: "1m", value: 60000 },
  { label: "Pause", value: 0 },
];
const REFRESH_MS = 5000;
const QUERY_WINDOW_OPTIONS = [
  { label: "15 min", value: 15 },
  { label: "1 hour", value: 60 },
  { label: "6 hours", value: 360 },
  { label: "24 hours", value: 1440 },
];
const BLOCKLIST_REFRESH_DEFAULT = "6h";
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const BLOCKLIST_PRESETS = [
  {
    id: "strict",
    label: "Strict",
    description: "Maximum blocking (ads, trackers, malware). Best for power users.",
    sources: [
      { name: "hagezi-pro-plus", url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/pro.plus.txt" },
    ],
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "Good balance for most users. Recommended for families.",
    sources: [
      { name: "hagezi-pro", url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/pro.txt" },
    ],
  },
  {
    id: "minimal",
    label: "Minimal",
    description: "Light blocking, fewer false positives. Good for getting started.",
    sources: [
      { name: "hagezi-light", url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/light.txt" },
    ],
  },
];
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "queries", label: "Queries" },
  { id: "blocklists", label: "Blocklists" },
  { id: "dns", label: "DNS Settings" },
  { id: "sync", label: "Sync" },
  { id: "system", label: "System Settings" },
  { id: "config", label: "Config" },
];
const SUPPORTED_LOCAL_RECORD_TYPES = new Set(["A", "AAAA", "CNAME", "TXT", "PTR"]);
const DURATION_PATTERN = /^(?:(?:\d+(?:\.\d+)?)(?:ns|us|µs|μs|ms|s|m|h))+$/i;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const EMPTY_SYNC_VALIDATION = {
  hasErrors: false,
  summary: "",
  fieldErrors: {
    primaryUrl: "",
    syncToken: "",
    syncInterval: "",
  },
  normalized: {
    primaryUrl: "",
    syncToken: "",
    syncInterval: "",
  },
};

function formatNumber(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  return value.toLocaleString();
}

/** Parse UTC timestamp from API (ClickHouse) and format as local time. */
function formatUtcToLocalTime(ts) {
  if (ts == null) return "";
  let date;
  if (typeof ts === "number") {
    date = new Date(ts);
  } else {
    const str = String(ts).trim();
    // ClickHouse returns "YYYY-MM-DD HH:MM:SS" without Z - JS parses as local. Force UTC.
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(str) && !/[Zz]$|[+-]\d{2}:?\d{2}$/.test(str)) {
      date = new Date(str.replace(" ", "T") + "Z");
    } else {
      date = new Date(ts);
    }
  }
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

/** Parse UTC timestamp from API (ClickHouse) and format as full local date+time. */
function formatUtcToLocalDateTime(ts) {
  if (ts == null) return "";
  let date;
  if (typeof ts === "number") {
    date = new Date(ts);
  } else {
    const str = String(ts).trim();
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(str) && !/[Zz]$|[+-]\d{2}:?\d{2}$/.test(str)) {
      date = new Date(str.replace(" ", "T") + "Z");
    } else {
      date = new Date(ts);
    }
  }
  return date.toLocaleString([], {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

function formatPercent(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  return `${(value * 100).toFixed(2)}%`;
}

function isValidDuration(value) {
  const raw = String(value || "").trim();
  if (!raw || !DURATION_PATTERN.test(raw)) {
    return false;
  }
  return /[1-9]/.test(raw);
}

function isValidHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return false;
  }
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidDnsName(value) {
  const normalized = String(value || "").trim().replace(/\.$/, "");
  if (!normalized || normalized.length > 253) {
    return false;
  }
  const labels = normalized.split(".");
  return labels.every((label) => DNS_LABEL_PATTERN.test(label));
}

function isValidIPv4(value) {
  const raw = String(value || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false;
    }
    const num = Number(part);
    return num >= 0 && num <= 255;
  });
}

function isValidIPv6(value) {
  const raw = String(value || "").trim();
  if (!raw || !raw.includes(":")) {
    return false;
  }
  try {
    new URL(`http://[${raw}]`);
    return true;
  } catch {
    return false;
  }
}

function validateUpstreamAddress(address) {
  const raw = String(address || "").trim();
  if (!raw) {
    return "Address is required.";
  }

  // DoT: tls://host:port (e.g. tls://1.1.1.1:853)
  if (raw.startsWith("tls://")) {
    const hostPort = raw.slice(6);
    const ipv6Match = hostPort.match(/^\[([^\]]+)\]:(\d{1,5})$/);
    if (ipv6Match) {
      if (!isValidIPv6(ipv6Match[1])) {
        return "DoT: IPv6 must be valid (example: tls://[2606:4700:4700::1111]:853).";
      }
      const port = Number(ipv6Match[2]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return "Port must be between 1 and 65535.";
      }
    } else {
      const hostPortMatch = hostPort.match(/^([^:]+):(\d{1,5})$/);
      if (!hostPortMatch) {
        return "DoT: use tls://host:port (example: tls://1.1.1.1:853).";
      }
      const host = hostPortMatch[1];
      const port = Number(hostPortMatch[2]);
      const normalizedHost = host.toLowerCase();
      if (
        !isValidIPv4(host) &&
        !isValidDnsName(host) &&
        normalizedHost !== "localhost"
      ) {
        return "DoT: host must be IPv4, IPv6 in brackets, or valid hostname.";
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return "Port must be between 1 and 65535.";
      }
    }
    return "";
  }

  // DoH: https://host/path (e.g. https://cloudflare-dns.com/dns-query)
  if (raw.startsWith("https://")) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "https:") {
        return "DoH: URL must use https://.";
      }
      if (!parsed.hostname) {
        return "DoH: hostname is required.";
      }
      if (!parsed.pathname || parsed.pathname === "/") {
        return "DoH: path is required (example: /dns-query).";
      }
      return "";
    } catch {
      return "DoH: use valid HTTPS URL (example: https://cloudflare-dns.com/dns-query).";
    }
  }

  // Plain DNS: host:port
  let host = "";
  let portString = "";
  const ipv6Match = raw.match(/^\[([^\]]+)\]:(\d{1,5})$/);
  if (ipv6Match) {
    host = ipv6Match[1];
    portString = ipv6Match[2];
    if (!isValidIPv6(host)) {
      return "IPv6 must be valid and wrapped in brackets (example: [2606:4700:4700::1111]:53).";
    }
  } else {
    const hostPortMatch = raw.match(/^([^:]+):(\d{1,5})$/);
    if (!hostPortMatch) {
      return "Use host:port (example: 1.1.1.1:53), tls://host:853 for DoT, or https://host/dns-query for DoH.";
    }
    host = hostPortMatch[1];
    portString = hostPortMatch[2];
    const normalizedHost = host.toLowerCase();
    if (
      !isValidIPv4(host) &&
      !isValidDnsName(host) &&
      normalizedHost !== "localhost"
    ) {
      return "Host must be IPv4, bracketed IPv6, localhost, or a valid hostname.";
    }
  }

  const port = Number(portString);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "Port must be between 1 and 65535.";
  }

  return "";
}

function getFirstRowError(rowErrors) {
  for (const rowError of rowErrors) {
    for (const message of Object.values(rowError || {})) {
      if (message) {
        return message;
      }
    }
  }
  return "";
}

function getRowErrorText(rowError) {
  return Object.values(rowError || {})
    .filter(Boolean)
    .join(" ");
}

function validateBlocklistForm({ refreshInterval, sources }) {
  const fieldErrors = { refreshInterval: "" };
  const rowErrors = [];
  const normalizedSources = [];
  const seen = new Set();

  const normalizedRefreshInterval = String(refreshInterval || "").trim();
  if (!isValidDuration(normalizedRefreshInterval)) {
    fieldErrors.refreshInterval =
      "Refresh interval must be a positive duration (example: 30s, 5m, 1h).";
  }

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index] || {};
    const name = String(source.name || "").trim();
    const url = String(source.url || "").trim();
    const touched = Boolean(name || url);
    const rowError = {};

    if (!touched) {
      rowErrors.push(rowError);
      continue;
    }

    if (!url) {
      rowError.url = "Source URL is required.";
    } else if (!isValidHttpUrl(url)) {
      rowError.url = "Source URL must start with http:// or https://.";
    } else {
      const key = url.toLowerCase();
      if (seen.has(key)) {
        rowError.url = "Duplicate source URL.";
      } else {
        seen.add(key);
      }
    }

    if (!rowError.url) {
      normalizedSources.push({
        name: name || url,
        url,
      });
    }

    rowErrors.push(rowError);
  }

  const generalErrors = [];
  if (normalizedSources.length === 0) {
    generalErrors.push("At least one valid blocklist source URL is required.");
  }

  const hasErrors =
    Boolean(fieldErrors.refreshInterval) ||
    rowErrors.some((rowError) => Object.keys(rowError).length > 0) ||
    generalErrors.length > 0;

  const summary =
    fieldErrors.refreshInterval || getFirstRowError(rowErrors) || generalErrors[0] || "";

  return {
    hasErrors,
    summary,
    fieldErrors,
    rowErrors,
    generalErrors,
    normalizedRefreshInterval,
    normalizedSources,
  };
}

const HHMM_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function validateScheduledPauseForm({ enabled, start, end, days }) {
  const fieldErrors = { start: "", end: "", days: "" };
  if (!enabled) {
    return { hasErrors: false, fieldErrors, summary: "" };
  }
  const startStr = String(start || "").trim();
  const endStr = String(end || "").trim();
  if (!HHMM_PATTERN.test(startStr)) {
    fieldErrors.start = "Must be HH:MM (e.g. 09:00)";
  }
  if (!HHMM_PATTERN.test(endStr)) {
    fieldErrors.end = "Must be HH:MM (e.g. 17:00)";
  }
  if (HHMM_PATTERN.test(startStr) && HHMM_PATTERN.test(endStr)) {
    const [sh, sm] = startStr.split(":").map(Number);
    const [eh, em] = endStr.split(":").map(Number);
    if (sh > eh || (sh === eh && sm >= em)) {
      fieldErrors.end = "End must be after start";
    }
  }
  const daysArr = Array.isArray(days) ? days : [];
  for (const d of daysArr) {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      fieldErrors.days = "Days must be 0-6 (0=Sun, 6=Sat)";
      break;
    }
  }
  const hasErrors = Boolean(fieldErrors.start || fieldErrors.end || fieldErrors.days);
  const summary = fieldErrors.start || fieldErrors.end || fieldErrors.days || "";
  return { hasErrors, fieldErrors, summary };
}

function validateUpstreamsForm(upstreams) {
  const rowErrors = [];
  const generalErrors = [];
  const normalizedUpstreams = [];
  const seen = new Set();

  for (let index = 0; index < upstreams.length; index += 1) {
    const upstream = upstreams[index] || {};
    const name = String(upstream.name || "").trim();
    const address = String(upstream.address || "").trim();
    const protocol = String(upstream.protocol || "udp")
      .trim()
      .toLowerCase();
    const touched = Boolean(name || address);
    const rowError = {};

    if (!touched) {
      rowErrors.push(rowError);
      continue;
    }

    if (!address) {
      rowError.address = "Address is required.";
    } else {
      const addressError = validateUpstreamAddress(address);
      if (addressError) {
        rowError.address = addressError;
      }
    }

    const addrLower = (address || "").toLowerCase();
    if (addrLower.startsWith("tls://")) {
      if (protocol !== "tls") {
        rowError.protocol = "Use protocol DoT for tls:// addresses.";
      }
    } else if (addrLower.startsWith("https://")) {
      if (protocol !== "https") {
        rowError.protocol = "Use protocol DoH for https:// addresses.";
      }
    } else {
      if (protocol !== "udp" && protocol !== "tcp") {
        rowError.protocol = "Use UDP or TCP for plain host:port addresses.";
      }
    }

    // Auto-set protocol from address when using DoT/DoH
    let effectiveProtocol = protocol;
    if (addrLower.startsWith("tls://")) {
      effectiveProtocol = "tls";
    } else if (addrLower.startsWith("https://")) {
      effectiveProtocol = "https";
    }

    if (!rowError.address && !rowError.protocol) {
      const duplicateKey = `${address.toLowerCase()}|${effectiveProtocol}`;
      if (seen.has(duplicateKey)) {
        rowError.address = "Duplicate upstream address/protocol.";
      } else {
        seen.add(duplicateKey);
        normalizedUpstreams.push({
          name: name || "upstream",
          address,
          protocol: effectiveProtocol,
        });
      }
    }

    rowErrors.push(rowError);
  }

  if (normalizedUpstreams.length === 0) {
    generalErrors.push("At least one valid upstream with an address is required.");
  }

  const hasErrors =
    rowErrors.some((rowError) => Object.keys(rowError).length > 0) ||
    generalErrors.length > 0;
  const summary = getFirstRowError(rowErrors) || generalErrors[0] || "";

  return {
    hasErrors,
    summary,
    rowErrors,
    generalErrors,
    normalizedUpstreams,
  };
}

function validateLocalRecordsForm(records) {
  const rowErrors = [];
  const normalizedRecords = [];
  const seen = new Set();

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] || {};
    const name = String(record.name || "").trim().toLowerCase();
    const type = String(record.type || "A").trim().toUpperCase() || "A";
    const value = String(record.value || "").trim();
    const touched = Boolean(name || value);
    const rowError = {};

    if (!touched) {
      rowErrors.push(rowError);
      continue;
    }

    if (!name) {
      rowError.name = "Name is required.";
    } else if (!isValidDnsName(name)) {
      rowError.name = "Name must be a valid DNS name.";
    }

    if (!SUPPORTED_LOCAL_RECORD_TYPES.has(type)) {
      rowError.type = "Type must be A, AAAA, CNAME, TXT, or PTR.";
    }

    if (!value) {
      rowError.value = "Value is required.";
    } else if (type === "A" && !isValidIPv4(value)) {
      rowError.value = "A records must use a valid IPv4 address.";
    } else if (type === "AAAA" && !isValidIPv6(value)) {
      rowError.value = "AAAA records must use a valid IPv6 address.";
    } else if ((type === "CNAME" || type === "PTR") && !isValidDnsName(value)) {
      rowError.value = `${type} records must point to a valid hostname.`;
    }

    if (!rowError.name && !rowError.type && !rowError.value) {
      const duplicateKey = `${name}:${type}`;
      if (seen.has(duplicateKey)) {
        rowError.name = `Duplicate record: ${name} ${type}.`;
      } else {
        seen.add(duplicateKey);
        normalizedRecords.push({ name, type, value });
      }
    }

    rowErrors.push(rowError);
  }

  const hasErrors = rowErrors.some((rowError) => Object.keys(rowError).length > 0);
  const summary = getFirstRowError(rowErrors);

  return {
    hasErrors,
    summary,
    rowErrors,
    normalizedRecords,
  };
}

function validateReplicaSyncSettings({
  primaryUrl,
  syncToken,
  syncInterval,
  requireToken,
}) {
  const normalized = {
    primaryUrl: String(primaryUrl || "").trim(),
    syncToken: String(syncToken || "").trim(),
    syncInterval: String(syncInterval || "").trim(),
  };
  const fieldErrors = {
    primaryUrl: "",
    syncToken: "",
    syncInterval: "",
  };

  if (!normalized.primaryUrl) {
    fieldErrors.primaryUrl = "Primary URL is required.";
  } else if (!isValidHttpUrl(normalized.primaryUrl)) {
    fieldErrors.primaryUrl = "Primary URL must start with http:// or https://.";
  }

  if (!normalized.syncInterval) {
    fieldErrors.syncInterval = "Sync interval is required.";
  } else if (!isValidDuration(normalized.syncInterval)) {
    fieldErrors.syncInterval =
      "Sync interval must be a positive duration (example: 30s, 5m, 1h).";
  }

  if (requireToken && !normalized.syncToken) {
    fieldErrors.syncToken = "Sync token is required for replica mode.";
  }

  const summary =
    fieldErrors.primaryUrl || fieldErrors.syncToken || fieldErrors.syncInterval || "";
  const hasErrors = Boolean(summary);

  return {
    hasErrors,
    summary,
    fieldErrors,
    normalized,
  };
}

function validateResponseForm({ blocked, blockedTtl }) {
  const normalizedBlocked = String(blocked ?? "nxdomain").trim().toLowerCase();
  const normalizedBlockedTtl = String(blockedTtl ?? "1h").trim();
  const fieldErrors = { blocked: "", blockedTtl: "" };

  if (normalizedBlocked !== "nxdomain") {
    if (!isValidIPv4(normalizedBlocked) && !isValidIPv6(normalizedBlocked)) {
      fieldErrors.blocked = "Must be nxdomain or a valid IPv4/IPv6 address.";
    }
  }

  if (!isValidDuration(normalizedBlockedTtl)) {
    fieldErrors.blockedTtl =
      "Blocked TTL must be a positive duration (example: 30s, 1h).";
  }

  const hasErrors = Boolean(fieldErrors.blocked || fieldErrors.blockedTtl);
  const summary = fieldErrors.blocked || fieldErrors.blockedTtl;

  return {
    hasErrors,
    summary,
    fieldErrors,
    normalized: {
      blocked: normalizedBlocked === "nxdomain" ? "nxdomain" : normalizedBlocked,
      blockedTtl: normalizedBlockedTtl,
    },
  };
}

function Tooltip({ children, content }) {
  if (!content) return children;
  return (
    <span className="tooltip-trigger">
      {children}
      <span className="tooltip-icon" aria-hidden>ⓘ</span>
      <span className="tooltip-content" role="tooltip">{content}</span>
    </span>
  );
}

const OUTCOME_TO_FILTER = {
  Cached: "cached",
  Local: "local",
  Forwarded: "upstream",
  Blocked: "blocked",
  "Upstream error": "upstream_error",
  Invalid: "invalid",
  Other: null, // no direct filter for "other"
};

function CollapsibleSection({ id, title, children, collapsed, onToggle, badges }) {
  const isCollapsed = collapsed ?? false;
  return (
    <section className="section collapsible-section">
      <div
        className="collapsible-header"
        onClick={() => onToggle?.(id)}
        aria-expanded={!isCollapsed}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <h2>{title}</h2>
          {badges}
        </div>
        <span className={`collapsible-chevron ${isCollapsed ? "collapsed" : ""}`}>▼</span>
      </div>
      <div className={`collapsible-content ${isCollapsed ? "collapsed" : ""}`}>
        {!isCollapsed && <div style={{ marginTop: "16px" }}>{children}</div>}
      </div>
    </section>
  );
}

function StatCard({ label, value, subtext, tooltip, drillDownOutcome, onDrillDown }) {
  const canDrillDown = drillDownOutcome && onDrillDown;
  return (
    <div
      className={`card ${canDrillDown ? "card-clickable" : ""}`}
      onClick={canDrillDown ? () => onDrillDown(drillDownOutcome) : undefined}
      role={canDrillDown ? "button" : undefined}
      tabIndex={canDrillDown ? 0 : undefined}
      onKeyDown={
        canDrillDown
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onDrillDown(drillDownOutcome);
              }
            }
          : undefined
      }
    >
      <div className="card-label">
        <Tooltip content={tooltip}>
          <span>{label}</span>
        </Tooltip>
      </div>
      <div className="card-value">{value}</div>
      {subtext && <div className="card-subtext">{subtext}</div>}
      {canDrillDown && (
        <div className="card-drilldown" title="View in Queries">
          View details →
        </div>
      )}
    </div>
  );
}

const METRIC_TOOLTIPS = {
  "Cached": "Queries answered from cache without contacting upstream servers. High cache rate improves performance.",
  "Local": "Queries answered from local/static records (e.g. custom DNS entries).",
  "Forwarded": "Queries sent to upstream DNS servers (e.g. Cloudflare, Google) for resolution.",
  "Blocked": "Queries blocked by blocklists (ads, trackers, malware). This is the primary protection metric.",
  "Upstream error": "Queries that failed due to upstream server errors. Investigate if this is non-zero.",
  "Invalid": "Malformed or invalid queries that could not be processed.",
  "Other": "Queries with outcomes not in the standard categories.",
  "Avg": "Average response time in milliseconds. Lower is better.",
  "P50": "Median (50th percentile) response time. Half of queries complete faster than this.",
  "P95": "95th percentile response time. 95% of queries complete faster than this.",
  "P99": "99th percentile response time. Useful for spotting tail latency.",
  "Min": "Fastest query response time in the window.",
  "Max": "Slowest query response time in the window.",
};

const STATUS_LABELS = {
  cached: "Cached",
  local: "Local",
  safe_search: "Safe Search",
  upstream: "Forwarded",
  blocked: "Blocked",
  upstream_error: "Upstream error",
  invalid: "Invalid",
};

const OUTCOME_COLORS = {
  cached: "#22c55e",
  local: "#3b82f6",
  safe_search: "#06b6d4",
  upstream: "#8b5cf6",
  blocked: "#ef4444",
  upstream_error: "#f59e0b",
  invalid: "#6b7280",
  other: "#9ca3af",
};

const UPSTREAM_COLORS = [
  "#3b82f6",
  "#8b5cf6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#06b6d4",
  "#ec4899",
  "#6366f1",
];

function DonutChart({ data, total, size = 160, colorPalette }) {
  const filtered = (data || []).filter((d) => d.count > 0);
  if (!filtered.length || total === 0) return null;
  const strokeWidth = size * 0.2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const segments = filtered.map(({ key, count, label }, idx) => {
    const pct = count / total;
    const dashLength = pct * circumference;
    const color = colorPalette
      ? colorPalette[idx % colorPalette.length]
      : (OUTCOME_COLORS[key] || "#9ca3af");
    const segment = { key, count, label, color, dashLength, offset };
    offset += dashLength;
    return segment;
  });
  return (
    <div className="donut-chart-container">
      <div className="donut-chart-wrapper">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="#1f2430"
            strokeWidth={strokeWidth}
          />
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            {segments.map(({ key, color, dashLength, offset: segOffset }) => (
              <circle
                key={key}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeDasharray={`${dashLength} ${circumference}`}
                strokeDashoffset={-segOffset}
                strokeLinecap="round"
              />
            ))}
          </g>
        </svg>
      </div>
      <div className="donut-chart-legend">
        {segments.map(({ key, label, count, color }) => (
          <div key={key} className="donut-legend-item">
            <span className="donut-legend-dot" style={{ background: color }} />
            <span className="donut-legend-label">{label}</span>
            <span className="donut-legend-value">
              {count.toLocaleString()} ({((count / total) * 100).toFixed(1)}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FilterInput({ value, onChange, placeholder, options = [] }) {
  const [showDropdown, setShowDropdown] = useState(false);

  const handleSelect = (selectedValue) => {
    onChange(selectedValue);
    setShowDropdown(false);
  };

  const handleInputChange = (e) => {
    onChange(e.target.value);
  };

  const handleInputFocus = () => {
    if (options.length > 0) {
      setShowDropdown(true);
    }
  };

  const handleInputBlur = () => {
    setTimeout(() => setShowDropdown(false), 200);
  };

  return (
    <div className="filter-input-wrapper">
      <input
        className="input filter-input"
        placeholder={placeholder}
        value={value}
        onChange={handleInputChange}
        onFocus={handleInputFocus}
        onBlur={handleInputBlur}
      />
      {showDropdown && options.length > 0 && (
        <div className="filter-dropdown">
          {options.map((option, index) => (
            <button
              key={index}
              className="filter-dropdown-item"
              onClick={() => handleSelect(option.value)}
              type="button"
            >
              <span className="filter-dropdown-value">{option.value || "-"}</span>
              <span className="filter-dropdown-count">
                {(option.count || 0).toLocaleString()}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [themePreference, setThemePreference] = useState(() => getStoredTheme());
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const [queryRows, setQueryRows] = useState([]);
  const [queryEnabled, setQueryEnabled] = useState(false);
  const [queryError, setQueryError] = useState("");
  const [queryTotal, setQueryTotal] = useState(0);
  const [queryPage, setQueryPage] = useState(1);
  const [queryPageSize, setQueryPageSize] = useState(25);
  const [querySortBy, setQuerySortBy] = useState("ts");
  const [querySortDir, setQuerySortDir] = useState("desc");
  const [filterQName, setFilterQName] = useState("");
  const [filterOutcome, setFilterOutcome] = useState("");
  const [filterRcode, setFilterRcode] = useState("");
  const [filterClient, setFilterClient] = useState("");
  const [filterQtype, setFilterQtype] = useState("");
  const [filterProtocol, setFilterProtocol] = useState("");
  const [filterSinceMinutes, setFilterSinceMinutes] = useState("");
  const [filterMinLatency, setFilterMinLatency] = useState("");
  const [filterMaxLatency, setFilterMaxLatency] = useState("");
  const [querySummary, setQuerySummary] = useState(null);
  const [queryLatency, setQueryLatency] = useState(null);
  const [querySummaryError, setQuerySummaryError] = useState("");
  const [queryLatencyError, setQueryLatencyError] = useState("");
  const [timeSeries, setTimeSeries] = useState(null);
  const [timeSeriesError, setTimeSeriesError] = useState("");
  const [upstreamStats, setUpstreamStats] = useState(null);
  const [upstreamStatsError, setUpstreamStatsError] = useState("");
  const [queryWindowMinutes, setQueryWindowMinutes] = useState(
    QUERY_WINDOW_OPTIONS[1].value
  );
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(REFRESH_MS);
  const [collapsedSections, setCollapsedSections] = useState({});
  const [filterOptions, setFilterOptions] = useState(null);
  const [filterOptionsError, setFilterOptionsError] = useState("");
  const [blocklistSources, setBlocklistSources] = useState([]);
  const [allowlist, setAllowlist] = useState([]);
  const [denylist, setDenylist] = useState([]);
  const [refreshInterval, setRefreshInterval] = useState(
    BLOCKLIST_REFRESH_DEFAULT
  );
  const [blocklistStatus, setBlocklistStatus] = useState("");
  const [blocklistError, setBlocklistError] = useState("");
  const [blocklistLoading, setBlocklistLoading] = useState(false);
  const [blocklistStats, setBlocklistStats] = useState(null);
  const [blocklistStatsError, setBlocklistStatsError] = useState("");
  const [scheduledPause, setScheduledPause] = useState({
    enabled: false,
    start: "09:00",
    end: "17:00",
    days: [1, 2, 3, 4, 5],
  });
  const [healthCheck, setHealthCheck] = useState({
    enabled: false,
    fail_on_any: true,
  });
  const [healthCheckResults, setHealthCheckResults] = useState(null);
  const [healthCheckLoading, setHealthCheckLoading] = useState(false);
  const [showBlocklistRecommendations, setShowBlocklistRecommendations] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [refreshStats, setRefreshStats] = useState(null);
  const [refreshStatsError, setRefreshStatsError] = useState("");
  const [activeConfig, setActiveConfig] = useState(null);
  const [configError, setConfigError] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [importError, setImportError] = useState("");
  const [restartLoading, setRestartLoading] = useState(false);
  const [restartError, setRestartError] = useState("");
  const [hostname, setHostname] = useState("");
  const [appInfo, setAppInfo] = useState(null);
  const [pauseStatus, setPauseStatus] = useState(null);
  const [pauseError, setPauseError] = useState("");
  const [pauseLoading, setPauseLoading] = useState(false);
  const [cacheStats, setCacheStats] = useState(null);
  const [cacheStatsError, setCacheStatsError] = useState("");
  const [authEnabled, setAuthEnabled] = useState(false);
  const [localRecords, setLocalRecords] = useState([]);
  const [localRecordsError, setLocalRecordsError] = useState("");
  const [localRecordsStatus, setLocalRecordsStatus] = useState("");
  const [localRecordsLoading, setLocalRecordsLoading] = useState(false);
  const [upstreams, setUpstreams] = useState([]);
  const [resolverStrategy, setResolverStrategy] = useState("failover");
  const [upstreamsError, setUpstreamsError] = useState("");
  const [upstreamsStatus, setUpstreamsStatus] = useState("");
  const [upstreamsLoading, setUpstreamsLoading] = useState(false);
  const [responseBlocked, setResponseBlocked] = useState("nxdomain");
  const [responseBlockedTtl, setResponseBlockedTtl] = useState("1h");
  const [responseError, setResponseError] = useState("");
  const [safeSearchEnabled, setSafeSearchEnabled] = useState(false);
  const [safeSearchGoogle, setSafeSearchGoogle] = useState(true);
  const [safeSearchBing, setSafeSearchBing] = useState(true);
  const [safeSearchStatus, setSafeSearchStatus] = useState("");
  const [safeSearchError, setSafeSearchError] = useState("");
  const [safeSearchLoading, setSafeSearchLoading] = useState(false);
  const [responseStatus, setResponseStatus] = useState("");
  const [responseLoading, setResponseLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncError, setSyncError] = useState("");
  const [syncLoading, setSyncLoading] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [createdToken, setCreatedToken] = useState(null);
  const [syncSettingsPrimaryUrl, setSyncSettingsPrimaryUrl] = useState("");
  const [syncSettingsToken, setSyncSettingsToken] = useState("");
  const [syncSettingsInterval, setSyncSettingsInterval] = useState("60s");
  const [syncSettingsStatus, setSyncSettingsStatus] = useState("");
  const [syncSettingsError, setSyncSettingsError] = useState("");
  const [syncConfigRole, setSyncConfigRole] = useState("primary");
  const [syncConfigLoading, setSyncConfigLoading] = useState(false);
  const [syncConfigStatus, setSyncConfigStatus] = useState("");
  const [syncConfigError, setSyncConfigError] = useState("");
  const [systemConfig, setSystemConfig] = useState(null);
  const [systemConfigError, setSystemConfigError] = useState("");
  const [systemConfigStatus, setSystemConfigStatus] = useState("");
  const [systemConfigLoading, setSystemConfigLoading] = useState(false);

  const isReplica = syncStatus?.role === "replica" && syncStatus?.enabled;
  const blocklistValidation = validateBlocklistForm({
    refreshInterval,
    sources: blocklistSources,
  });
  const scheduledPauseValidation = validateScheduledPauseForm({
    enabled: scheduledPause.enabled,
    start: scheduledPause.start,
    end: scheduledPause.end,
    days: scheduledPause.days,
  });
  const upstreamValidation = validateUpstreamsForm(upstreams);
  const localRecordsValidation = validateLocalRecordsForm(localRecords);
  const responseValidation = validateResponseForm({
    blocked: responseBlocked,
    blockedTtl: responseBlockedTtl,
  });
  const syncEnableReplicaValidation =
    syncConfigRole === "replica"
      ? validateReplicaSyncSettings({
          primaryUrl: syncSettingsPrimaryUrl,
          syncToken: syncSettingsToken,
          syncInterval: syncSettingsInterval,
          requireToken: true,
        })
      : EMPTY_SYNC_VALIDATION;
  const syncSettingsValidation = validateReplicaSyncSettings({
    primaryUrl: syncSettingsPrimaryUrl,
    syncToken: syncSettingsToken,
    syncInterval: syncSettingsInterval,
    requireToken: false,
  });

  const logout = async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } finally {
      window.location.reload();
    }
  };

  useEffect(() => {
    fetch("/api/auth/status", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setAuthEnabled(d.authEnabled ?? false))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let isMounted = true;
    const load = async () => {
      try {
        const response = await fetch("/api/sync/status");
        if (!response.ok) throw new Error(`Sync status failed: ${response.status}`);
        const data = await response.json();
        if (!isMounted) return;
        setSyncStatus(data);
        setSyncError("");
      } catch (err) {
        if (!isMounted) return;
        setSyncStatus(null);
        setSyncError(err.message || "Failed to load sync status");
      }
    };
    load();
    const interval = setInterval(load, 30000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const load = async () => {
      try {
        const response = await fetch("/api/redis/summary");
        if (!response.ok) {
          throw new Error(`Request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setStats(data);
        setUpdatedAt(new Date());
        setError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setError(err.message || "Failed to load stats");
      }
    };
    load();
    const interval = refreshIntervalMs > 0 ? setInterval(load, refreshIntervalMs) : null;
    return () => {
      isMounted = false;
      if (interval) clearInterval(interval);
    };
  }, [queryWindowMinutes, refreshIntervalMs]);

  useEffect(() => {
    let isMounted = true;
    const loadQueries = async () => {
      try {
        const params = buildQueryParams({
          queryPage,
          queryPageSize,
          querySortBy,
          querySortDir,
          filterQName,
          filterOutcome,
          filterRcode,
          filterClient,
          filterQtype,
          filterProtocol,
          filterSinceMinutes,
          filterMinLatency,
          filterMaxLatency,
        });
        const response = await fetch(`/api/queries/recent?${params}`);
        if (!response.ok) {
          throw new Error(`Query request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setQueryEnabled(Boolean(data.enabled));
        setQueryRows(Array.isArray(data.rows) ? data.rows : []);
        setQueryTotal(Number(data.total || 0));
        setQueryError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setQueryError(err.message || "Failed to load queries");
      }
    };
    loadQueries();
    const interval = setInterval(loadQueries, 15000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [
    queryPage,
    queryPageSize,
    querySortBy,
    querySortDir,
    filterQName,
    filterOutcome,
    filterRcode,
    filterClient,
    filterQtype,
    filterProtocol,
    filterSinceMinutes,
    filterMinLatency,
    filterMaxLatency,
  ]);

  useEffect(() => {
    let isMounted = true;
    const loadBlocklists = async () => {
      try {
        setBlocklistLoading(true);
        const response = await fetch("/api/blocklists");
        if (!response.ok) {
          throw new Error(`Blocklists request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setBlocklistSources(Array.isArray(data.sources) ? data.sources : []);
        setAllowlist(Array.isArray(data.allowlist) ? data.allowlist : []);
        setDenylist(Array.isArray(data.denylist) ? data.denylist : []);
        setRefreshInterval(data.refreshInterval || BLOCKLIST_REFRESH_DEFAULT);
        const sp = data.scheduled_pause;
        setScheduledPause(
          sp && typeof sp.enabled === "boolean"
            ? {
                enabled: sp.enabled,
                start: sp.start || "09:00",
                end: sp.end || "17:00",
                days: Array.isArray(sp.days) ? [...sp.days] : [1, 2, 3, 4, 5],
              }
            : { enabled: false, start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] }
        );
        const hc = data.health_check;
        setHealthCheck(
          hc && typeof hc.enabled === "boolean"
            ? { enabled: hc.enabled, fail_on_any: hc.fail_on_any !== false }
            : { enabled: false, fail_on_any: true }
        );
        setBlocklistError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setBlocklistError(err.message || "Failed to load blocklists");
      } finally {
        if (isMounted) {
          setBlocklistLoading(false);
        }
      }
    };
    loadBlocklists();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const loadConfig = async () => {
      try {
        const response = await fetch("/api/config");
        if (!response.ok) {
          throw new Error(`Config request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setActiveConfig(data);
        setConfigError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setConfigError(err.message || "Failed to load config");
      }
    };
    loadConfig();
    const interval = setInterval(loadConfig, 30000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const loadRefreshStats = async () => {
      try {
        const response = await fetch("/api/cache/refresh/stats");
        if (!response.ok) {
          throw new Error(`Refresh stats failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setRefreshStats(data);
        setRefreshStatsError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setRefreshStatsError(err.message || "Failed to load refresh stats");
      }
    };
    loadRefreshStats();
    const interval = setInterval(loadRefreshStats, 15000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const loadStats = async () => {
      try {
        const response = await fetch("/api/blocklists/stats");
        if (!response.ok) {
          throw new Error(`Blocklist stats failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setBlocklistStats(data);
        setBlocklistStatsError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setBlocklistStatsError(err.message || "Failed to load blocklist stats");
      }
    };
    loadStats();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const loadSummary = async () => {
      try {
        const response = await fetch(
          `/api/queries/summary?window_minutes=${queryWindowMinutes}`
        );
        if (!response.ok) {
          throw new Error(`Summary request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setQueryEnabled(Boolean(data.enabled));
        setQuerySummary(data);
        setQuerySummaryError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setQuerySummaryError(err.message || "Failed to load query summary");
      }
    };
    loadSummary();
    const interval = setInterval(loadSummary, 15000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [queryWindowMinutes]);

  const bucketMinutes = queryWindowMinutes <= 15 ? 1 : queryWindowMinutes <= 60 ? 5 : queryWindowMinutes <= 360 ? 15 : 60;

  useEffect(() => {
    let isMounted = true;
    const loadTimeSeries = async () => {
      try {
        const response = await fetch(
          `/api/queries/time-series?window_minutes=${queryWindowMinutes}&bucket_minutes=${bucketMinutes}`
        );
        if (!response.ok) throw new Error("Time-series request failed");
        const data = await response.json();
        if (!isMounted) return;
        setTimeSeries(data);
        setTimeSeriesError("");
      } catch (err) {
        if (!isMounted) return;
        setTimeSeriesError(err.message || "Failed to load time-series");
      }
    };
    loadTimeSeries();
    const interval = setInterval(loadTimeSeries, 15000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [queryWindowMinutes, bucketMinutes]);

  useEffect(() => {
    let isMounted = true;
    const loadLatency = async () => {
      try {
        const response = await fetch(
          `/api/queries/latency?window_minutes=${queryWindowMinutes}`
        );
        if (!response.ok) {
          throw new Error(`Latency request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setQueryEnabled(Boolean(data.enabled));
        setQueryLatency(data);
        setQueryLatencyError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setQueryLatencyError(err.message || "Failed to load latency stats");
      }
    };
    loadLatency();
    const interval = setInterval(loadLatency, 15000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [queryWindowMinutes]);

  useEffect(() => {
    let isMounted = true;
    const loadUpstreamStats = async () => {
      try {
        const response = await fetch(
          `/api/queries/upstream-stats?window_minutes=${queryWindowMinutes}`
        );
        if (!response.ok) {
          throw new Error(`Upstream stats failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setUpstreamStats(data);
        setUpstreamStatsError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setUpstreamStatsError(err.message || "Failed to load upstream stats");
      }
    };
    loadUpstreamStats();
    const interval = setInterval(loadUpstreamStats, 15000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [queryWindowMinutes]);

  useEffect(() => {
    let isMounted = true;
    const loadFilterOptions = async () => {
      try {
        const response = await fetch(
          `/api/queries/filter-options?window_minutes=${queryWindowMinutes}`
        );
        if (!response.ok) {
          throw new Error(`Filter options failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setFilterOptions(data.options || {});
        setFilterOptionsError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setFilterOptionsError(err.message || "Failed to load filter options");
      }
    };
    loadFilterOptions();
    const interval = setInterval(loadFilterOptions, 30000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [queryWindowMinutes]);

  useEffect(() => {
    let isMounted = true;
    const loadInfo = async () => {
      try {
        const response = await fetch("/api/info");
        if (!response.ok) {
          throw new Error(`Info request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setHostname(data.hostname || "");
        setAppInfo(data);
      } catch (err) {
        if (!isMounted) {
          return;
        }
        // Silent fail - hostname is optional
        console.warn("Failed to load hostname:", err);
      }
    };
    loadInfo();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const loadPauseStatus = async () => {
      try {
        const response = await fetch("/api/blocklists/pause/status");
        if (!response.ok) {
          throw new Error(`Pause status failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setPauseStatus(data);
        setPauseError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setPauseError(err.message || "Failed to load pause status");
      }
    };
    loadPauseStatus();
    const interval = setInterval(loadPauseStatus, 5000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const loadCacheStats = async () => {
      try {
        const response = await fetch("/api/cache/stats");
        if (!response.ok) {
          throw new Error(`Cache stats failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setCacheStats(data);
        setCacheStatsError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setCacheStatsError(err.message || "Failed to load cache stats");
      }
    };
    loadCacheStats();
    const interval = refreshIntervalMs > 0 ? setInterval(loadCacheStats, refreshIntervalMs) : null;
    return () => {
      isMounted = false;
      if (interval) clearInterval(interval);
    };
  }, [refreshIntervalMs]);

  useEffect(() => {
    if (activeTab === "sync" && syncStatus?.role === "replica") {
      setSyncSettingsPrimaryUrl(syncStatus.primary_url || "");
      setSyncSettingsToken(""); // Don't pre-fill token for security
      setSyncSettingsInterval(syncStatus.sync_interval || "60s");
    }
  }, [activeTab, syncStatus]);

  useEffect(() => {
    if (activeTab !== "system") return;
    let isMounted = true;
    const load = async () => {
      try {
        const response = await fetch("/api/system/config");
        if (!response.ok) throw new Error(`Request failed: ${response.status}`);
        const data = await response.json();
        if (!isMounted) return;
        setSystemConfig(data);
        setSystemConfigError("");
      } catch (err) {
        if (!isMounted) return;
        setSystemConfigError(err.message || "Failed to load system config");
      }
    };
    load();
    return () => { isMounted = false; };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "dns") return;
    let isMounted = true;
    const loadLocalRecords = async () => {
      try {
        const response = await fetch("/api/dns/local-records");
        if (!response.ok) {
          throw new Error(`Local records request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setLocalRecords(Array.isArray(data.records) ? data.records : []);
        setLocalRecordsError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setLocalRecordsError(err.message || "Failed to load local records");
      }
    };
    const loadUpstreams = async () => {
      try {
        const response = await fetch("/api/dns/upstreams");
        if (!response.ok) {
          throw new Error(`Upstreams request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setUpstreams(Array.isArray(data.upstreams) ? data.upstreams : []);
        setResolverStrategy(data.resolver_strategy || "failover");
        setUpstreamsError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setUpstreamsError(err.message || "Failed to load upstreams");
      }
    };
    const loadResponse = async () => {
      try {
        const response = await fetch("/api/dns/response");
        if (!response.ok) {
          throw new Error(`Response config request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setResponseBlocked(data.blocked || "nxdomain");
        setResponseBlockedTtl(data.blocked_ttl || "1h");
        setResponseError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setResponseError(err.message || "Failed to load response config");
      }
    };
    const loadSafeSearch = async () => {
      try {
        const response = await fetch("/api/dns/safe-search");
        if (!response.ok) {
          throw new Error(`Safe search request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!isMounted) {
          return;
        }
        setSafeSearchEnabled(data.enabled ?? false);
        setSafeSearchGoogle(data.google !== false);
        setSafeSearchBing(data.bing !== false);
        setSafeSearchError("");
      } catch (err) {
        if (!isMounted) {
          return;
        }
        setSafeSearchError(err.message || "Failed to load safe search config");
      }
    };
    loadLocalRecords();
    loadUpstreams();
    loadResponse();
    loadSafeSearch();
    return () => {
      isMounted = false;
    };
  }, [activeTab]);

  const statusRows = querySummary?.statuses || [];
  const statusTotal = querySummary?.total || 0;
  const statusMap = statusRows.reduce((acc, row) => {
    acc[row.outcome] = row.count;
    return acc;
  }, {});
  const statusOrder = ["cached", "local", "upstream", "safe_search", "blocked", "upstream_error", "invalid"];
  const statusCards = statusOrder.map((key) => ({
    key,
    label: STATUS_LABELS[key] || key,
    count: statusMap[key] || 0,
  }));
  const otherCount = statusTotal - statusCards.reduce((sum, row) => sum + row.count, 0);
  if (otherCount > 0) {
    statusCards.push({ key: "other", label: "Other", count: otherCount });
  }

  const totalPages = Math.max(1, Math.ceil(queryTotal / queryPageSize));
  const canPrev = queryPage > 1;
  const canNext = queryPage < totalPages;

  const setFilter = (setter, value) => {
    setter(value);
    setQueryPage(1);
  };

  const toggleSort = (field) => {
    if (querySortBy === field) {
      setQuerySortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setQuerySortBy(field);
      setQuerySortDir("desc");
    }
  };

  const drillDownToQueries = (outcome) => {
    setActiveTab("queries");
    setFilterOutcome(outcome);
    setQueryPage(1);
  };

  const toggleSection = (id) => {
    setCollapsedSections((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const exportCsv = () => {
    const params = buildQueryParams({
      queryPage: 1,
      queryPageSize: Math.min(queryPageSize, 5000),
      querySortBy,
      querySortDir,
      filterQName,
      filterOutcome,
      filterRcode,
      filterClient,
      filterQtype,
      filterProtocol,
      filterSinceMinutes,
      filterMinLatency,
      filterMaxLatency,
    });
    window.location.href = `/api/queries/export?${params}`;
  };

  const updateSource = (index, field, value) => {
    setBlocklistSources((prev) =>
      prev.map((source, idx) =>
        idx === index ? { ...source, [field]: value } : source
      )
    );
  };

  const addSource = () => {
    setBlocklistSources((prev) => [...prev, { name: "", url: "" }]);
  };

  const removeSource = (index) => {
    setBlocklistSources((prev) => prev.filter((_, idx) => idx !== index));
  };

  const addDomain = (setter, value) => {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      return;
    }
    setter((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
  };

  const removeDomain = (setter, domain) => {
    setter((prev) => prev.filter((item) => item !== domain));
  };

  const saveBlocklists = async () => {
    setBlocklistStatus("");
    setBlocklistError("");
    const validation = validateBlocklistForm({
      refreshInterval,
      sources: blocklistSources,
    });
    if (validation.hasErrors) {
      setBlocklistError(validation.summary || "Please fix validation errors before saving.");
      return false;
    }
    if (scheduledPauseValidation.hasErrors) {
      setBlocklistError(scheduledPauseValidation.summary || "Please fix scheduled pause validation.");
      return false;
    }
    try {
      setBlocklistLoading(true);
      const body = {
        refreshInterval: validation.normalizedRefreshInterval,
        sources: validation.normalizedSources,
        allowlist,
        denylist,
        scheduled_pause: scheduledPause.enabled
          ? {
              enabled: true,
              start: String(scheduledPause.start || "09:00").trim(),
              end: String(scheduledPause.end || "17:00").trim(),
              days: Array.isArray(scheduledPause.days) ? scheduledPause.days : [],
            }
          : { enabled: false },
        health_check: {
          enabled: healthCheck.enabled,
          fail_on_any: healthCheck.fail_on_any,
        },
      };
      const response = await fetch("/api/blocklists", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Save failed: ${response.status}`);
      }
      setBlocklistStatus("Saved");
      return true;
    } catch (err) {
      setBlocklistError(err.message || "Failed to save blocklists");
      return false;
    } finally {
      setBlocklistLoading(false);
    }
  };

  const applyBlocklists = async () => {
    const saved = await saveBlocklists();
    if (!saved) {
      return;
    }
    try {
      setBlocklistLoading(true);
      const response = await fetch("/api/blocklists/apply", {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Apply failed: ${response.status}`);
      }
      setBlocklistStatus("Applied");
      const statsResponse = await fetch("/api/blocklists/stats");
      if (statsResponse.ok) {
        const data = await statsResponse.json();
        setBlocklistStats(data);
      }
    } catch (err) {
      setBlocklistError(err.message || "Failed to apply blocklists");
    } finally {
      setBlocklistLoading(false);
    }
  };

  const exportConfig = () => {
    window.location.href = "/api/config/export";
  };

  const pauseBlocking = async (minutes) => {
    setPauseLoading(true);
    setPauseError("");
    try {
      const response = await fetch("/api/blocklists/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duration_minutes: minutes }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Pause failed: ${response.status}`);
      }
      const data = await response.json();
      setPauseStatus(data);
    } catch (err) {
      setPauseError(err.message || "Failed to pause blocking");
    } finally {
      setPauseLoading(false);
    }
  };

  const resumeBlocking = async () => {
    setPauseLoading(true);
    setPauseError("");
    try {
      const response = await fetch("/api/blocklists/resume", {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Resume failed: ${response.status}`);
      }
      const data = await response.json();
      setPauseStatus(data);
    } catch (err) {
      setPauseError(err.message || "Failed to resume blocking");
    } finally {
      setPauseLoading(false);
    }
  };

  const checkBlocklistHealth = async () => {
    setHealthCheckLoading(true);
    setHealthCheckResults(null);
    try {
      const response = await fetch("/api/blocklists/health");
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }
      const data = await response.json();
      setHealthCheckResults(data);
    } catch (err) {
      setHealthCheckResults({ error: err.message || "Failed to check blocklist health" });
    } finally {
      setHealthCheckLoading(false);
    }
  };

  const toggleScheduledPauseDay = (day) => {
    setScheduledPause((prev) => {
      const days = Array.isArray(prev.days) ? [...prev.days] : [];
      const idx = days.indexOf(day);
      if (idx >= 0) {
        days.splice(idx, 1);
      } else {
        days.push(day);
        days.sort((a, b) => a - b);
      }
      return { ...prev, days };
    });
  };

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
      const response = await fetch("/api/dns/local-records", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          records: validation.normalizedRecords,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Save failed: ${response.status}`);
      }
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
      const response = await fetch("/api/dns/local-records/apply", {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Apply failed: ${response.status}`);
      }
      setLocalRecordsStatus("Applied");
    } catch (err) {
      setLocalRecordsError(err.message || "Failed to apply local records");
    } finally {
      setLocalRecordsLoading(false);
    }
  };

  const RESOLVER_STRATEGY_OPTIONS = [
    { value: "failover", label: "Failover", desc: "Try upstreams in order, use next on failure" },
    { value: "load_balance", label: "Load Balance", desc: "Round-robin across all upstreams" },
    { value: "weighted", label: "Weighted (latency)", desc: "Prefer faster upstreams by response time" },
  ];

  const updateUpstream = (index, field, value) => {
    setUpstreams((prev) =>
      prev.map((u, idx) => {
        if (idx !== index) return u;
        const next = { ...u, [field]: value };
        // Auto-set protocol when address is DoT or DoH
        if (field === "address") {
          const addr = String(value || "").trim().toLowerCase();
          if (addr.startsWith("tls://")) next.protocol = "tls";
          else if (addr.startsWith("https://")) next.protocol = "https";
        }
        return next;
      })
    );
  };

  const addUpstream = () => {
    setUpstreams((prev) => [...prev, { name: "", address: "", protocol: "udp" }]);
  };

  const removeUpstream = (index) => {
    setUpstreams((prev) => prev.filter((_, idx) => idx !== index));
  };

  const saveUpstreams = async () => {
    setUpstreamsStatus("");
    setUpstreamsError("");
    const validation = validateUpstreamsForm(upstreams);
    if (validation.hasErrors) {
      setUpstreamsError(
        validation.summary || "Please fix validation errors before saving."
      );
      return false;
    }
    try {
      setUpstreamsLoading(true);
      const response = await fetch("/api/dns/upstreams", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upstreams: validation.normalizedUpstreams,
          resolver_strategy: resolverStrategy,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Save failed: ${response.status}`);
      }
      setUpstreamsStatus("Saved");
      setUpstreams(validation.normalizedUpstreams);
      return true;
    } catch (err) {
      setUpstreamsError(err.message || "Failed to save upstreams");
      return false;
    } finally {
      setUpstreamsLoading(false);
    }
  };

  const applyUpstreams = async () => {
    const saved = await saveUpstreams();
    if (!saved) return;
    try {
      setUpstreamsLoading(true);
      const response = await fetch("/api/dns/upstreams/apply", {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Apply failed: ${response.status}`);
      }
      setUpstreamsStatus("Applied");
    } catch (err) {
      setUpstreamsError(err.message || "Failed to apply upstreams");
    } finally {
      setUpstreamsLoading(false);
    }
  };

  const saveResponse = async () => {
    setResponseStatus("");
    setResponseError("");
    const validation = validateResponseForm({
      blocked: responseBlocked,
      blockedTtl: responseBlockedTtl,
    });
    if (validation.hasErrors) {
      setResponseError(
        validation.summary || "Please fix validation errors before saving."
      );
      return false;
    }
    try {
      setResponseLoading(true);
      const response = await fetch("/api/dns/response", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blocked: validation.normalized.blocked,
          blocked_ttl: validation.normalized.blockedTtl,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Save failed: ${response.status}`);
      }
      setResponseStatus("Saved");
      setResponseBlocked(validation.normalized.blocked);
      setResponseBlockedTtl(validation.normalized.blockedTtl);
      return true;
    } catch (err) {
      setResponseError(err.message || "Failed to save response config");
      return false;
    } finally {
      setResponseLoading(false);
    }
  };

  const applyResponse = async () => {
    const saved = await saveResponse();
    if (!saved) return;
    try {
      setResponseLoading(true);
      const response = await fetch("/api/dns/response/apply", {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Apply failed: ${response.status}`);
      }
      setResponseStatus("Applied");
    } catch (err) {
      setResponseError(err.message || "Failed to apply response config");
    } finally {
      setResponseLoading(false);
    }
  };

  const saveSafeSearch = async () => {
    setSafeSearchStatus("");
    setSafeSearchError("");
    try {
      setSafeSearchLoading(true);
      const response = await fetch("/api/dns/safe-search", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: safeSearchEnabled,
          google: safeSearchGoogle,
          bing: safeSearchBing,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Save failed: ${response.status}`);
      }
      setSafeSearchStatus("Saved");
      return true;
    } catch (err) {
      setSafeSearchError(err.message || "Failed to save safe search config");
      return false;
    } finally {
      setSafeSearchLoading(false);
    }
  };

  const applySafeSearch = async () => {
    const saved = await saveSafeSearch();
    if (!saved) return;
    try {
      setSafeSearchLoading(true);
      const response = await fetch("/api/dns/safe-search/apply", {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Apply failed: ${response.status}`);
      }
      setSafeSearchStatus("Applied");
    } catch (err) {
      setSafeSearchError(err.message || "Failed to apply safe search config");
    } finally {
      setSafeSearchLoading(false);
    }
  };

  const createSyncToken = async () => {
    setSyncLoading(true);
    setSyncError("");
    setCreatedToken(null);
    try {
      const response = await fetch("/api/sync/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTokenName || "Replica" }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Create failed: ${response.status}`);
      }
      const data = await response.json();
      setCreatedToken(data.token);
      setNewTokenName("");
      const statusRes = await fetch("/api/sync/status");
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        setSyncStatus(statusData);
      }
    } catch (err) {
      setSyncError(err.message || "Failed to create token");
    } finally {
      setSyncLoading(false);
    }
  };

  const revokeSyncToken = async (index) => {
    setSyncLoading(true);
    setSyncError("");
    try {
      const response = await fetch(`/api/sync/tokens/${index}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Revoke failed: ${response.status}`);
      }
      const statusRes = await fetch("/api/sync/status");
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        setSyncStatus(statusData);
      }
    } catch (err) {
      setSyncError(err.message || "Failed to revoke token");
    } finally {
      setSyncLoading(false);
    }
  };

  const saveSyncSettings = async () => {
    setSyncSettingsStatus("");
    setSyncSettingsError("");
    const validation = validateReplicaSyncSettings({
      primaryUrl: syncSettingsPrimaryUrl,
      syncToken: syncSettingsToken,
      syncInterval: syncSettingsInterval,
      requireToken: false,
    });
    if (validation.hasErrors) {
      setSyncSettingsError(
        validation.summary || "Please fix validation errors before saving."
      );
      return;
    }
    const body = {
      primary_url: validation.normalized.primaryUrl,
      sync_interval: validation.normalized.syncInterval,
    };
    if (validation.normalized.syncToken) {
      body.sync_token = validation.normalized.syncToken;
    }
    try {
      const response = await fetch("/api/sync/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Save failed: ${response.status}`);
      }
      const data = await response.json();
      setSyncSettingsStatus(data.message || "Saved");
      const statusRes = await fetch("/api/sync/status");
      if (statusRes.ok) setSyncStatus(await statusRes.json());
    } catch (err) {
      setSyncSettingsError(err.message || "Failed to save sync settings");
    }
  };

  const saveSyncConfig = async (enabled, role, replicaSettings = null) => {
    setSyncConfigStatus("");
    setSyncConfigError("");
    const body = { enabled, role };
    if (enabled && role === "replica") {
      const validation = validateReplicaSyncSettings({
        primaryUrl: replicaSettings?.primary_url,
        syncToken: replicaSettings?.sync_token,
        syncInterval: replicaSettings?.sync_interval,
        requireToken: true,
      });
      if (validation.hasErrors) {
        setSyncConfigError(
          validation.summary || "Please fix validation errors before saving."
        );
        return;
      }
      body.primary_url = validation.normalized.primaryUrl;
      body.sync_token = validation.normalized.syncToken;
      body.sync_interval = validation.normalized.syncInterval;
    }

    try {
      setSyncConfigLoading(true);
      const response = await fetch("/api/sync/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed");
      setSyncConfigStatus(data.message || "Saved");
      const statusRes = await fetch("/api/sync/status");
      if (statusRes.ok) setSyncStatus(await statusRes.json());
    } catch (err) {
      setSyncConfigError(err.message || "Failed to save sync config");
    } finally {
      setSyncConfigLoading(false);
    }
  };

  const disableSync = async () => {
    if (!confirm("Disable sync? Replicas will stop receiving config updates.")) return;
    await saveSyncConfig(false, syncStatus?.role || "primary");
  };

  const importConfig = async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    
    setImportStatus("");
    setImportError("");
    
    try {
      const text = await file.text();
      const parsed = parseYAML(text);
      
      const response = await fetch("/api/config/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Import failed: ${response.status}`);
      }
      
      setImportStatus("Config imported successfully. Restart the application to apply changes.");
      
      // Reload config display
      const configResponse = await fetch("/api/config");
      if (configResponse.ok) {
        const data = await configResponse.json();
        setActiveConfig(data);
      }
    } catch (err) {
      setImportError(err.message || "Failed to import config");
    }
    
    // Reset file input
    event.target.value = "";
  };

  const restartService = async () => {
    setRestartError("");
    setRestartLoading(true);
    try {
      const response = await fetch("/api/restart", { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Restart failed: ${response.status}`);
      }
      setImportStatus("Service is restarting. The page will reconnect when it is back.");
      // Server will exit; connection may drop. No need to setRestartLoading(false).
    } catch (err) {
      setRestartError(err.message || "Failed to restart service");
      setRestartLoading(false);
    }
  };

  const updateSystemConfig = (section, field, value) => {
    setSystemConfig((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      next[section] = { ...(next[section] || {}), [field]: value };
      return next;
    });
  };

  const saveSystemConfig = async () => {
    setSystemConfigStatus("");
    setSystemConfigError("");
    if (!systemConfig) return;
    try {
      setSystemConfigLoading(true);
      const response = await fetch("/api/system/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(systemConfig),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Save failed: ${response.status}`);
      }
      const data = await response.json();
      setSystemConfigStatus(data.message || "Saved. Restart the service to apply changes.");
    } catch (err) {
      setSystemConfigError(err.message || "Failed to save system config");
    } finally {
      setSystemConfigLoading(false);
    }
  };

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Beyond Ads DNS Metrics</h1>
          <div className="subtitle">
            {hostname && (
              <span>Environment: <strong>{hostname}</strong></span>
            )}
            {appInfo && (
              <>
                {hostname && <span> • </span>}
                <span>App memory: <strong>{appInfo.memoryUsage || "-"}</strong></span>
                <span> • </span>
                <span>Build: <strong>{appInfo.buildTimestamp ? new Date(appInfo.buildTimestamp).toLocaleString() : "-"}</strong></span>
              </>
            )}
          </div>
        </div>
        <div className="header-actions">
          <label className="select" title="Theme">
            <select
              value={themePreference}
              onChange={(e) => {
                const v = e.target.value;
                setTheme(v);
                setThemePreference(v);
              }}
              aria-label="Theme"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">System</option>
            </select>
          </label>
          {authEnabled && (
            <button type="button" className="button logout-button" onClick={logout}>
              Log out
            </button>
          )}
          <div className="refresh">
          <label className="select">
            Refresh
            <select
              value={refreshIntervalMs}
              onChange={(e) => setRefreshIntervalMs(Number(e.target.value))}
            >
              {REFRESH_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <span className="updated">
            {updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "Loading"}
          </span>
          </div>
        </div>
      </header>

      <div className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      {activeTab === "overview" && (
      <CollapsibleSection
        id="blocking"
        title="Blocking Control"
        collapsed={collapsedSections.blocking}
        onToggle={toggleSection}
        badges={
          <>
            <span className={`badge ${pauseStatus?.paused ? "paused" : "active"}`}>
              {pauseStatus?.paused ? "Paused" : "Active"}
            </span>
            {isReplica && <span className="badge muted">Per instance</span>}
          </>
        }
      >
        {pauseError && <div className="error">{pauseError}</div>}
        {pauseStatus?.paused ? (
          <div>
            <p className="status">
              Blocking is paused until {new Date(pauseStatus.until).toLocaleString()}
              {isReplica && " (this instance only)"}
            </p>
            <button
              className="button primary"
              onClick={resumeBlocking}
              disabled={pauseLoading}
            >
              Resume Blocking
            </button>
          </div>
        ) : (
          <div>
            <p className="muted">
              Blocking is active. Pause for:
              {isReplica && " (applies to this instance only)"}
            </p>
            <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
              <button
                className="button"
                onClick={() => pauseBlocking(1)}
                disabled={pauseLoading}
              >
                1 min
              </button>
              <button
                className="button"
                onClick={() => pauseBlocking(5)}
                disabled={pauseLoading}
              >
                5 min
              </button>
              <button
                className="button"
                onClick={() => pauseBlocking(30)}
                disabled={pauseLoading}
              >
                30 min
              </button>
              <button
                className="button"
                onClick={() => pauseBlocking(60)}
                disabled={pauseLoading}
              >
                1 hour
              </button>
            </div>
          </div>
        )}
      </CollapsibleSection>
      )}

      {activeTab === "overview" && (
      <CollapsibleSection
        id="queries"
        title="Query Statistics"
        collapsed={collapsedSections.queries}
        onToggle={toggleSection}
        badges={
          <label className="select">
            Window
            <select
              value={queryWindowMinutes}
              onChange={(event) => setQueryWindowMinutes(Number(event.target.value))}
            >
              {QUERY_WINDOW_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        }
      >
        {querySummaryError && <div className="error">{querySummaryError}</div>}
        {!queryEnabled ? (
          <p className="muted">Query store is disabled.</p>
        ) : (
          <>
            <DonutChart data={statusCards} total={statusTotal} />
            {timeSeries?.enabled && timeSeries.buckets?.length > 0 && (
              <div className="chart-container">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                  <h3 style={{ margin: 0, fontSize: "14px", color: "#9aa4b2" }}>Request volume over time (local time)</h3>
                  <span className="qps-indicator" title="Current QPS from latest bucket">
                    {(() => {
                      const buckets = timeSeries.buckets;
                      const last = buckets?.[buckets.length - 1];
                      const qps = last && bucketMinutes > 0 ? (last.total / (bucketMinutes * 60)).toFixed(1) : "-";
                      return <>{qps} QPS</>;
                    })()}
                  </span>
                </div>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={timeSeries.buckets.map((b) => ({
                      ...b,
                      time: formatUtcToLocalTime(b.ts),
                      rate: bucketMinutes > 0 ? b.total / (bucketMinutes * 60) : 0,
                    }))}
                    margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="gradientTotal" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2563eb" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#2563eb" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" />
                    <YAxis />
                    <RechartsTooltip
                      contentStyle={{ background: "#1f2430", border: "1px solid #2a3140", borderRadius: "8px" }}
                      labelStyle={{ color: "#fff" }}
                      formatter={(value) => [value?.toFixed(1) ?? value, "QPS"]}
                      labelFormatter={(v) => `Time: ${v}`}
                    />
                    <Area type="monotone" dataKey="rate" stroke="#2563eb" fill="url(#gradientTotal)" name="Queries/sec" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        )}
      </CollapsibleSection>
      )}

      {activeTab === "overview" && (
      <CollapsibleSection
        id="upstream"
        title="Upstream Server Distribution"
        collapsed={collapsedSections.upstream}
        onToggle={toggleSection}
      >
        {upstreamStatsError && <div className="error">{upstreamStatsError}</div>}
        {!queryEnabled ? (
          <p className="muted">Query store is disabled.</p>
        ) : !upstreamStats?.enabled ? (
          <p className="muted">Upstream stats unavailable.</p>
        ) : upstreamStats.upstreams?.length === 0 ? (
          <p className="muted">No upstream queries in the selected window.</p>
        ) : (
          <>
            <p className="muted">
              Distribution of forwarded queries (outcome=upstream, servfail) in the last{" "}
              {queryWindowMinutes >= 60 ? `${queryWindowMinutes / 60} hour${queryWindowMinutes / 60 > 1 ? "s" : ""}` : `${queryWindowMinutes} min`}.
            </p>
            <DonutChart
              data={(upstreamStats.upstreams || []).map((row) => ({
                key: row.address || "(unknown)",
                count: row.count,
                label: row.address || "(unknown)",
              }))}
              total={upstreamStats.total || 0}
              colorPalette={UPSTREAM_COLORS}
            />
          </>
        )}
      </CollapsibleSection>
      )}

      {activeTab === "overview" && (
      <CollapsibleSection
        id="response"
        title="Response Time"
        collapsed={collapsedSections.response}
        onToggle={toggleSection}
      >
        {queryLatencyError && <div className="error">{queryLatencyError}</div>}
        {!queryEnabled ? (
          <p className="muted">Query store is disabled.</p>
        ) : (
          <>
            {timeSeries?.enabled && timeSeries.latencyBuckets?.length > 0 && (
              <div className="chart-container">
                <h3 style={{ margin: "0 0 12px", fontSize: "14px", color: "#9aa4b2" }}>Latency over time (local time, ms)</h3>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={timeSeries.latencyBuckets.map((b) => ({
                      ...b,
                      time: formatUtcToLocalTime(b.ts),
                    }))}
                    margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" />
                    <YAxis />
                    <RechartsTooltip
                      contentStyle={{ background: "#1f2430", border: "1px solid #2a3140", borderRadius: "8px" }}
                      labelStyle={{ color: "#fff" }}
                      formatter={(value) => [value != null ? value.toFixed(2) : "-", "ms"]}
                      labelFormatter={(v) => `Time: ${v}`}
                    />
                    <Legend />
                    <Line type="monotone" dataKey="avgMs" stroke="#3b82f6" name="Avg" dot={false} strokeWidth={2} />
                    <Line type="monotone" dataKey="p50Ms" stroke="#22c55e" name="P50" dot={false} strokeWidth={2} />
                    <Line type="monotone" dataKey="p95Ms" stroke="#f59e0b" name="P95" dot={false} strokeWidth={2} />
                    <Line type="monotone" dataKey="p99Ms" stroke="#ef4444" name="P99" dot={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        )}
      </CollapsibleSection>
      )}

      {activeTab === "overview" && (
      <CollapsibleSection
        id="cache"
        title="L0 / L1 Cache"
        collapsed={collapsedSections.cache}
        onToggle={toggleSection}
      >
        {cacheStatsError && <div className="error">{cacheStatsError}</div>}
        <table className="cache-summary-table">
          <thead>
            <tr>
              <th>Layer</th>
              <th>Metric</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr><td className="cache-layer" rowSpan="4">L0 (LRU)</td><td>Entries</td><td>{formatNumber(cacheStats?.lru?.entries)} / {formatNumber(cacheStats?.lru?.max_entries)}</td></tr>
            <tr><td>Fresh</td><td>{formatNumber(cacheStats?.lru?.fresh)}</td></tr>
            <tr><td>Stale</td><td>{formatNumber(cacheStats?.lru?.stale)}</td></tr>
            <tr><td>Expired</td><td>{formatNumber(cacheStats?.lru?.expired)}</td></tr>
            <tr><td className="cache-layer" rowSpan="4">L1 (Redis)</td><td>Hit rate</td><td>{cacheStats?.hit_rate != null ? `${cacheStats.hit_rate.toFixed(2)}%` : "-"}</td></tr>
            <tr><td>Requests</td><td>{formatNumber(cacheStats?.hits != null && cacheStats?.misses != null ? cacheStats.hits + cacheStats.misses : null)}</td></tr>
            <tr><td>Evicted</td><td>{formatNumber(stats?.evictedKeys)}</td></tr>
            <tr><td>Memory</td><td>{stats?.usedMemoryHuman || "-"}</td></tr>
            <tr><td className="cache-layer" rowSpan="3">Keyspace</td><td>DNS keys</td><td>{formatNumber(stats?.keyspace?.dnsKeys)}</td></tr>
            <tr><td>Metadata</td><td>{formatNumber(stats?.keyspace?.dnsmetaKeys)}</td></tr>
            <tr><td>Other</td><td>{formatNumber(stats?.keyspace?.otherKeys)}</td></tr>
          </tbody>
        </table>
      </CollapsibleSection>
      )}

      {activeTab === "overview" && (
      <CollapsibleSection
        id="refresh"
        title="Refresh Sweeper (24h)"
        collapsed={collapsedSections.refresh}
        onToggle={toggleSection}
      >
        {refreshStatsError && <div className="error">{refreshStatsError}</div>}
        <table className="cache-summary-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Last sweep</td>
              <td>{formatNumber(refreshStats?.last_sweep_count)}</td>
            </tr>
            <tr>
              <td>Last sweep time</td>
              <td>
                {refreshStats?.last_sweep_time
                  ? new Date(refreshStats.last_sweep_time).toLocaleTimeString()
                  : "-"}
              </td>
            </tr>
            <tr>
              <td>Avg per sweep</td>
              <td>
                {refreshStats?.average_per_sweep_24h !== undefined
                  ? refreshStats.average_per_sweep_24h.toFixed(2)
                  : "-"}
              </td>
            </tr>
            <tr>
              <td>Std dev per sweep</td>
              <td>
                {refreshStats?.std_dev_per_sweep_24h !== undefined
                  ? refreshStats.std_dev_per_sweep_24h.toFixed(2)
                  : "-"}
              </td>
            </tr>
            <tr>
              <td>Sweeps (window)</td>
              <td>
                {formatNumber(refreshStats?.sweeps_24h)}
                {refreshStats?.batch_stats_window_sec
                  ? ` (${Math.round(refreshStats.batch_stats_window_sec / 60)}m)`
                  : ""}
              </td>
            </tr>
            <tr>
              <td>Refreshed (window)</td>
              <td>{formatNumber(refreshStats?.refreshed_24h)}</td>
            </tr>
            <tr>
              <td>Batch size</td>
              <td>{formatNumber(refreshStats?.batch_size)}</td>
            </tr>
          </tbody>
        </table>
      </CollapsibleSection>
      )}

      {activeTab === "queries" && (
      <section className="section">
        <h2>Recent Queries</h2>
        {queryError && <div className="error">{queryError}</div>}
        {!queryEnabled ? (
          <p className="muted">Query store is disabled.</p>
        ) : (
          <div className="table">
            <div className="table-filters">
              <FilterInput
                placeholder="QName contains"
                value={filterQName}
                onChange={(value) => setFilter(setFilterQName, value)}
                options={filterOptions?.qname || []}
              />
              <FilterInput
                placeholder="Outcome"
                value={filterOutcome}
                onChange={(value) => setFilter(setFilterOutcome, value)}
                options={filterOptions?.outcome || []}
              />
              <FilterInput
                placeholder="RCode"
                value={filterRcode}
                onChange={(value) => setFilter(setFilterRcode, value)}
                options={filterOptions?.rcode || []}
              />
              <FilterInput
                placeholder="Client"
                value={filterClient}
                onChange={(value) => setFilter(setFilterClient, value)}
                options={filterOptions?.client_ip || []}
              />
              <FilterInput
                placeholder="QType"
                value={filterQtype}
                onChange={(value) => setFilter(setFilterQtype, value)}
                options={filterOptions?.qtype || []}
              />
              <FilterInput
                placeholder="Protocol"
                value={filterProtocol}
                onChange={(value) => setFilter(setFilterProtocol, value)}
                options={filterOptions?.protocol || []}
              />
              <input
                className="input"
                placeholder="Since minutes"
                value={filterSinceMinutes}
                onChange={(event) =>
                  setFilter(setFilterSinceMinutes, event.target.value)
                }
              />
              <input
                className="input"
                placeholder="Min latency ms"
                value={filterMinLatency}
                onChange={(event) =>
                  setFilter(setFilterMinLatency, event.target.value)
                }
              />
              <input
                className="input"
                placeholder="Max latency ms"
                value={filterMaxLatency}
                onChange={(event) =>
                  setFilter(setFilterMaxLatency, event.target.value)
                }
              />
            </div>
            <div className="table-header">
              <button className="table-sort" onClick={() => toggleSort("ts")}>
                Time {querySortBy === "ts" ? (querySortDir === "asc" ? "↑" : "↓") : ""}
              </button>
              <button
                className="table-sort"
                onClick={() => toggleSort("client_ip")}
              >
                Client{" "}
                {querySortBy === "client_ip"
                  ? querySortDir === "asc"
                    ? "↑"
                    : "↓"
                  : ""}
              </button>
              <button className="table-sort" onClick={() => toggleSort("qname")}>
                QName{" "}
                {querySortBy === "qname" ? (querySortDir === "asc" ? "↑" : "↓") : ""}
              </button>
              <button className="table-sort" onClick={() => toggleSort("qtype")}>
                Type{" "}
                {querySortBy === "qtype" ? (querySortDir === "asc" ? "↑" : "↓") : ""}
              </button>
              <button
                className="table-sort"
                onClick={() => toggleSort("outcome")}
              >
                Outcome{" "}
                {querySortBy === "outcome"
                  ? querySortDir === "asc"
                    ? "↑"
                    : "↓"
                  : ""}
              </button>
              <button className="table-sort" onClick={() => toggleSort("rcode")}>
                RCode{" "}
                {querySortBy === "rcode" ? (querySortDir === "asc" ? "↑" : "↓") : ""}
              </button>
              <button
                className="table-sort"
                onClick={() => toggleSort("duration_ms")}
              >
                Duration{" "}
                {querySortBy === "duration_ms"
                  ? querySortDir === "asc"
                    ? "↑"
                    : "↓"
                  : ""}
              </button>
            </div>
            {queryRows.length === 0 && (
              <div className="table-row muted">No recent queries.</div>
            )}
            {queryRows.map((row, index) => (
              <div className="table-row" key={`${row.ts}-${index}`}>
                <span>{formatUtcToLocalDateTime(row.ts)}</span>
                <span>
                  {row.client_name
                    ? `${row.client_name} (${row.client_ip || ""})`
                    : row.client_ip || "-"}
                </span>
                <span className="mono">{row.qname || "-"}</span>
                <span>{row.qtype || "-"}</span>
                <span>{row.outcome || "-"}</span>
                <span>{row.rcode || "-"}</span>
                <span>{row.duration_ms != null ? `${Number(row.duration_ms).toFixed(2)} ms` : "-"}</span>
              </div>
            ))}
            <div className="table-footer">
              <span>
                Page {queryPage} of {totalPages} • {formatNumber(queryTotal)} total
              </span>
              <div className="pagination">
                <label className="select">
                  Page size
                  <select
                    value={queryPageSize}
                    onChange={(event) => {
                      setQueryPageSize(Number(event.target.value));
                      setQueryPage(1);
                    }}
                  >
                    {[10, 25, 50, 100].map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button"
                  onClick={() => setQueryPage((prev) => Math.max(1, prev - 1))}
                  disabled={!canPrev}
                >
                  Prev
                </button>
                <button
                  className="button"
                  onClick={() =>
                    setQueryPage((prev) => Math.min(totalPages, prev + 1))
                  }
                  disabled={!canNext}
                >
                  Next
                </button>
                <button className="button primary" onClick={exportCsv}>
                  Export CSV
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
      )}

      {activeTab === "blocklists" && (
      <section className="section">
        <div className="section-header">
          <h2>Blocklist Management</h2>
          {isReplica ? (
            <span className="badge muted">Synced from primary</span>
          ) : (
          <div className="actions">
            <button
              className="button"
              onClick={saveBlocklists}
              disabled={
                blocklistLoading ||
                blocklistValidation.hasErrors ||
                scheduledPauseValidation.hasErrors
              }
            >
              Save
            </button>
            <button
              className="button primary"
              onClick={applyBlocklists}
              disabled={
                blocklistLoading ||
                blocklistValidation.hasErrors ||
                scheduledPauseValidation.hasErrors
              }
            >
              Apply changes
            </button>
          </div>
          )}
        </div>
        {isReplica && <p className="muted">Blocklists are managed by the primary instance.</p>}
        {blocklistLoading && <p className="muted">Loading…</p>}
        {blocklistStatus && <p className="status">{blocklistStatus}</p>}
        {blocklistError && <div className="error">{blocklistError}</div>}
        {blocklistStatsError && <div className="error">{blocklistStatsError}</div>}

        <div className="grid">
          <StatCard
            label="Blocked domains"
            value={
              blocklistStats
                ? formatNumber(blocklistStats.blocked + blocklistStats.deny)
                : "-"
            }
            subtext="lists + manual blocks"
          />
          <StatCard
            label="List entries"
            value={formatNumber(blocklistStats?.blocked)}
          />
          <StatCard
            label="Manual blocks"
            value={formatNumber(blocklistStats?.deny)}
          />
          <StatCard
            label="Allowlist"
            value={formatNumber(blocklistStats?.allow)}
          />
        </div>

        <div className="form-group">
          <label className="field-label">Refresh interval</label>
          <input
            className={`input ${
              blocklistValidation.fieldErrors.refreshInterval ? "input-invalid" : ""
            }`}
            value={refreshInterval}
            onChange={(event) => setRefreshInterval(event.target.value)}
          />
          {blocklistValidation.fieldErrors.refreshInterval && (
            <div className="field-error">
              {blocklistValidation.fieldErrors.refreshInterval}
            </div>
          )}
        </div>

        <div className="form-group">
          <label className="field-label">Blocklist sources</label>
          {(blocklistSources.length === 0 || showBlocklistRecommendations) && (
            <div className="blocklist-recommendations">
              <p className="muted" style={{ marginBottom: 12 }}>
                {blocklistSources.length === 0
                  ? "Choose a preset to get started, or add your own sources below."
                  : "Apply a preset to replace your current sources, or add your own below."}
              </p>
              <div className="grid" style={{ marginBottom: 16 }}>
                {BLOCKLIST_PRESETS.map((preset) => (
                  <div
                    key={preset.id}
                    className="card card-clickable"
                    onClick={() => {
                      setBlocklistSources(preset.sources.map((s) => ({ ...s })));
                      setShowBlocklistRecommendations(false);
                    }}
                  >
                    <div className="card-label">{preset.label}</div>
                    <div className="card-value" style={{ fontSize: 16 }}>{preset.sources.length} list(s)</div>
                    <div className="card-subtext">{preset.description}</div>
                  </div>
                ))}
              </div>
              {blocklistSources.length > 0 && (
                <button
                  className="button"
                  onClick={() => setShowBlocklistRecommendations(false)}
                >
                  Hide recommendations
                </button>
              )}
            </div>
          )}
          {blocklistSources.length > 0 && !showBlocklistRecommendations && (
            <button
              className="button"
              onClick={() => setShowBlocklistRecommendations(true)}
              style={{ marginBottom: 12 }}
            >
              Show recommendations
            </button>
          )}
          <div className="list">
            {blocklistSources.map((source, index) => (
              <div key={`${source.url}-${index}`}>
                <div className="list-row">
                  <input
                    className="input"
                    placeholder="Name"
                    value={source.name || ""}
                    onChange={(event) =>
                      updateSource(index, "name", event.target.value)
                    }
                  />
                  <input
                    className={`input ${
                      blocklistValidation.rowErrors[index]?.url ? "input-invalid" : ""
                    }`}
                    placeholder="URL"
                    value={source.url || ""}
                    onChange={(event) =>
                      updateSource(index, "url", event.target.value)
                    }
                  />
                  <button
                    className="icon-button"
                    onClick={() => removeSource(index)}
                  >
                    Remove
                  </button>
                </div>
                {getRowErrorText(blocklistValidation.rowErrors[index]) && (
                  <div className="field-error">
                    {getRowErrorText(blocklistValidation.rowErrors[index])}
                  </div>
                )}
              </div>
            ))}
          </div>
          {blocklistValidation.generalErrors.map((message) => (
            <div key={message} className="field-error">
              {message}
            </div>
          ))}
          <button className="button" onClick={addSource}>
            Add blocklist
          </button>
        </div>

        <div className="grid">
          <div className="form-group">
            <label className="field-label">Allowlist (exceptions)</label>
            <DomainEditor
              items={allowlist}
              onAdd={(value) => addDomain(setAllowlist, value)}
              onRemove={(value) => removeDomain(setAllowlist, value)}
            />
          </div>
          <div className="form-group">
            <label className="field-label">Manual blocklist</label>
            <DomainEditor
              items={denylist}
              onAdd={(value) => addDomain(setDenylist, value)}
              onRemove={(value) => removeDomain(setDenylist, value)}
            />
          </div>
        </div>

        <div className="form-group">
          <label className="field-label">Scheduled pause</label>
          <p className="muted" style={{ marginTop: 0, marginBottom: 8 }}>
            Don&apos;t block during specific hours (e.g. work hours). Useful for allowing work tools.
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={scheduledPause.enabled}
              onChange={(e) =>
                setScheduledPause((prev) => ({ ...prev, enabled: e.target.checked }))
              }
            />
            Enable scheduled pause
          </label>
          {scheduledPause.enabled && (
            <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
              <div>
                <label className="field-label" style={{ fontSize: 12 }}>Start</label>
                <input
                  className={`input ${scheduledPauseValidation.fieldErrors.start ? "input-invalid" : ""}`}
                  type="text"
                  placeholder="09:00"
                  value={scheduledPause.start}
                  onChange={(e) => setScheduledPause((prev) => ({ ...prev, start: e.target.value }))}
                  style={{ width: 80 }}
                />
                {scheduledPauseValidation.fieldErrors.start && (
                  <div className="field-error">{scheduledPauseValidation.fieldErrors.start}</div>
                )}
              </div>
              <div>
                <label className="field-label" style={{ fontSize: 12 }}>End</label>
                <input
                  className={`input ${scheduledPauseValidation.fieldErrors.end ? "input-invalid" : ""}`}
                  type="text"
                  placeholder="17:00"
                  value={scheduledPause.end}
                  onChange={(e) => setScheduledPause((prev) => ({ ...prev, end: e.target.value }))}
                  style={{ width: 80 }}
                />
                {scheduledPauseValidation.fieldErrors.end && (
                  <div className="field-error">{scheduledPauseValidation.fieldErrors.end}</div>
                )}
              </div>
              <div>
                <label className="field-label" style={{ fontSize: 12 }}>Days (0=Sun, 6=Sat)</label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                  {DAY_LABELS.map((label, i) => (
                    <label key={i} className="checkbox" style={{ marginRight: 4 }}>
                      <input
                        type="checkbox"
                        checked={scheduledPause.days?.includes(i) ?? false}
                        onChange={() => toggleScheduledPauseDay(i)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                {scheduledPauseValidation.fieldErrors.days && (
                  <div className="field-error">{scheduledPauseValidation.fieldErrors.days}</div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="form-group">
          <label className="field-label">Blocklist health check</label>
          <p className="muted" style={{ marginTop: 0, marginBottom: 8 }}>
            Validate blocklist URLs before apply. When enabled, apply can fail if sources are unreachable.
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={healthCheck.enabled}
              onChange={(e) =>
                setHealthCheck((prev) => ({ ...prev, enabled: e.target.checked }))
              }
            />
            Validate blocklist URLs before apply
          </label>
          {healthCheck.enabled && (
            <label className="checkbox" style={{ display: "block", marginTop: 8 }}>
              <input
                type="checkbox"
                checked={healthCheck.fail_on_any}
                onChange={(e) =>
                  setHealthCheck((prev) => ({ ...prev, fail_on_any: e.target.checked }))
                }
              />
              Fail apply if any source fails
            </label>
          )}
          <div style={{ marginTop: 12 }}>
            <button
              className="button"
              onClick={checkBlocklistHealth}
              disabled={healthCheckLoading}
            >
              {healthCheckLoading ? "Checking…" : "Check health now"}
            </button>
          </div>
          {healthCheckResults && (
            <div style={{ marginTop: 12 }}>
              {healthCheckResults.error ? (
                <div className="error">{healthCheckResults.error}</div>
              ) : (
                <div className="table-container">
                  <div className="table-header">
                    <span>Source</span>
                    <span>URL</span>
                    <span>Status</span>
                  </div>
                  {(healthCheckResults.sources || []).map((s, i) => (
                    <div key={i} className="table-row">
                      <span>{s.name || "-"}</span>
                      <span className="mono" style={{ fontSize: 12 }}>{s.url || "-"}</span>
                      <span>
                        {s.ok ? (
                          <span className="badge active">OK</span>
                        ) : (
                          <span className="badge paused" title={s.error}>{s.error || "Failed"}</span>
                        )}
                      </span>
                    </div>
                  ))}
                  {(!healthCheckResults.sources || healthCheckResults.sources.length === 0) && (
                    <div className="table-row muted">No sources to check</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
      )}

      {activeTab === "dns" && (
      <>
      <section className="section">
        <div className="section-header">
          <h2>Upstream Resolvers</h2>
          {isReplica ? (
            <span className="badge muted">Synced from primary</span>
          ) : (
          <div className="actions">
            <button
              className="button"
              onClick={saveUpstreams}
              disabled={upstreamsLoading || upstreamValidation.hasErrors}
            >
              Save
            </button>
            <button
              className="button primary"
              onClick={applyUpstreams}
              disabled={upstreamsLoading || upstreamValidation.hasErrors}
            >
              Apply changes
            </button>
          </div>
          )}
        </div>
        {isReplica && <p className="muted">DNS settings are managed by the primary instance.</p>}
        <p className="muted">
          Configure upstream DNS resolvers and how queries are distributed. Changes take effect immediately when applied.
        </p>
        {upstreamsStatus && <p className="status">{upstreamsStatus}</p>}
        {upstreamsError && <div className="error">{upstreamsError}</div>}

        <div className="form-group">
          <label className="field-label">Resolver strategy</label>
          <select
            className="input"
            value={resolverStrategy}
            onChange={(e) => setResolverStrategy(e.target.value)}
            style={{ maxWidth: "280px" }}
          >
            {RESOLVER_STRATEGY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label} – {opt.desc}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label className="field-label">Upstream servers</label>
          <div className="list">
            {upstreams.map((u, index) => (
              <div key={index}>
                <div className="list-row">
                  <input
                    className="input"
                    placeholder="Name (e.g. cloudflare)"
                    value={u.name || ""}
                    onChange={(e) => updateUpstream(index, "name", e.target.value)}
                    style={{ minWidth: "100px" }}
                  />
                  <input
                    className={`input ${
                      upstreamValidation.rowErrors[index]?.address ? "input-invalid" : ""
                    }`}
                    placeholder="1.1.1.1:53, tls://host:853, or https://host/dns-query"
                    value={u.address || ""}
                    onChange={(e) => updateUpstream(index, "address", e.target.value)}
                    style={{ minWidth: "180px" }}
                  />
                  <select
                    className={`input ${
                      upstreamValidation.rowErrors[index]?.protocol ? "input-invalid" : ""
                    }`}
                    value={u.protocol || "udp"}
                    onChange={(e) => updateUpstream(index, "protocol", e.target.value)}
                    style={{ minWidth: "80px" }}
                  >
                    <option value="udp">UDP</option>
                    <option value="tcp">TCP</option>
                    <option value="tls">DoT</option>
                    <option value="https">DoH</option>
                  </select>
                  <button
                    className="icon-button"
                    onClick={() => removeUpstream(index)}
                  >
                    Remove
                  </button>
                </div>
                {getRowErrorText(upstreamValidation.rowErrors[index]) && (
                  <div className="field-error">
                    {getRowErrorText(upstreamValidation.rowErrors[index])}
                  </div>
                )}
              </div>
            ))}
          </div>
          {upstreamValidation.generalErrors.map((message) => (
            <div key={message} className="field-error">
              {message}
            </div>
          ))}
          <button className="button" onClick={addUpstream}>
            Add upstream
          </button>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <h2>Local DNS Records</h2>
          {!isReplica && (
          <div className="actions">
            <button
              className="button"
              onClick={saveLocalRecords}
              disabled={localRecordsLoading || localRecordsValidation.hasErrors}
            >
              Save
            </button>
            <button
              className="button primary"
              onClick={applyLocalRecords}
              disabled={localRecordsLoading || localRecordsValidation.hasErrors}
            >
              Apply changes
            </button>
          </div>
          )}
        </div>
        <p className="muted">
          Local records are returned immediately without upstream lookup. They work even when the internet is down.
        </p>
        {localRecordsStatus && <p className="status">{localRecordsStatus}</p>}
        {localRecordsError && <div className="error">{localRecordsError}</div>}

        <div className="form-group">
          <label className="field-label">Records</label>
          <div className="list">
            {localRecords.map((rec, index) => (
              <div key={index}>
                <div className="list-row">
                  <input
                    className={`input ${
                      localRecordsValidation.rowErrors[index]?.name
                        ? "input-invalid"
                        : ""
                    }`}
                    placeholder="Name (e.g. router.local)"
                    value={rec.name || ""}
                    onChange={(e) => updateLocalRecord(index, "name", e.target.value)}
                  />
                  <select
                    className={`input ${
                      localRecordsValidation.rowErrors[index]?.type
                        ? "input-invalid"
                        : ""
                    }`}
                    value={rec.type || "A"}
                    onChange={(e) => updateLocalRecord(index, "type", e.target.value)}
                  >
                    <option value="A">A</option>
                    <option value="AAAA">AAAA</option>
                    <option value="CNAME">CNAME</option>
                    <option value="TXT">TXT</option>
                    <option value="PTR">PTR</option>
                  </select>
                  <input
                    className={`input ${
                      localRecordsValidation.rowErrors[index]?.value
                        ? "input-invalid"
                        : ""
                    }`}
                    placeholder="Value (IP or hostname)"
                    value={rec.value || ""}
                    onChange={(e) => updateLocalRecord(index, "value", e.target.value)}
                  />
                  <button
                    className="icon-button"
                    onClick={() => removeLocalRecord(index)}
                  >
                    Remove
                  </button>
                </div>
                {getRowErrorText(localRecordsValidation.rowErrors[index]) && (
                  <div className="field-error">
                    {getRowErrorText(localRecordsValidation.rowErrors[index])}
                  </div>
                )}
              </div>
            ))}
          </div>
          <button className="button" onClick={addLocalRecord}>
            Add record
          </button>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <h2>Blocked Response</h2>
          {isReplica ? (
            <span className="badge muted">Synced from primary</span>
          ) : (
          <div className="actions">
            <button
              className="button"
              onClick={saveResponse}
              disabled={responseLoading || responseValidation.hasErrors}
            >
              Save
            </button>
            <button
              className="button primary"
              onClick={applyResponse}
              disabled={responseLoading || responseValidation.hasErrors}
            >
              Apply changes
            </button>
          </div>
          )}
        </div>
        {isReplica && <p className="muted">Response config is managed by the primary instance.</p>}
        <p className="muted">
          How to respond when a domain is blocked. Use nxdomain (NXDOMAIN) or an IP address (e.g. 0.0.0.0) to sinkhole.
        </p>
        {responseStatus && <p className="status">{responseStatus}</p>}
        {responseError && <div className="error">{responseError}</div>}

        <div className="form-group">
          <label className="field-label">Response type</label>
          <input
            className={`input ${
              responseValidation.fieldErrors.blocked ? "input-invalid" : ""
            }`}
            placeholder="nxdomain or 0.0.0.0"
            value={responseBlocked}
            onChange={(e) => setResponseBlocked(e.target.value)}
            style={{ maxWidth: "200px" }}
          />
          {responseValidation.fieldErrors.blocked && (
            <div className="field-error">
              {responseValidation.fieldErrors.blocked}
            </div>
          )}
        </div>
        <div className="form-group">
          <label className="field-label">Blocked TTL</label>
          <input
            className={`input ${
              responseValidation.fieldErrors.blockedTtl ? "input-invalid" : ""
            }`}
            placeholder="1h"
            value={responseBlockedTtl}
            onChange={(e) => setResponseBlockedTtl(e.target.value)}
            style={{ maxWidth: "120px" }}
          />
          {responseValidation.fieldErrors.blockedTtl && (
            <div className="field-error">
              {responseValidation.fieldErrors.blockedTtl}
            </div>
          )}
        </div>

        <div className="form-group" style={{ marginTop: 32 }}>
          <div className="section-header">
            <h2 style={{ margin: 0 }}>Safe Search</h2>
            {isReplica ? (
              <span className="badge muted">Synced from primary</span>
            ) : (
            <div className="actions">
              <button
                className="button"
                onClick={saveSafeSearch}
                disabled={safeSearchLoading}
              >
                Save
              </button>
              <button
                className="button primary"
                onClick={applySafeSearch}
                disabled={safeSearchLoading}
              >
                Apply changes
              </button>
            </div>
            )}
          </div>
          <p className="muted" style={{ marginTop: 8, marginBottom: 12 }}>
            Force safe search for Google and Bing. Redirects search queries to family-friendly results.
          </p>
          {safeSearchStatus && <p className="status">{safeSearchStatus}</p>}
          {safeSearchError && <div className="error">{safeSearchError}</div>}
          {!isReplica && (
            <>
              <label className="checkbox" style={{ display: "block", marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={safeSearchEnabled}
                  onChange={(e) => setSafeSearchEnabled(e.target.checked)}
                />
                Enable safe search
              </label>
              {safeSearchEnabled && (
                <div style={{ marginLeft: 20 }}>
                  <label className="checkbox" style={{ display: "block", marginBottom: 8 }}>
                    <input
                      type="checkbox"
                      checked={safeSearchGoogle}
                      onChange={(e) => setSafeSearchGoogle(e.target.checked)}
                    />
                    Google (forcesafesearch.google.com)
                  </label>
                  <label className="checkbox" style={{ display: "block" }}>
                    <input
                      type="checkbox"
                      checked={safeSearchBing}
                      onChange={(e) => setSafeSearchBing(e.target.checked)}
                    />
                    Bing (strict.bing.com)
                  </label>
                </div>
              )}
            </>
          )}
        </div>
      </section>
      </>
      )}

      {activeTab === "sync" && (
      <section className="section">
        <div className="section-header">
          <h2>Instance Sync</h2>
          {syncStatus?.enabled && (
            <span className={`badge ${syncStatus.role === "primary" ? "primary" : "muted"}`}>
              {syncStatus.role === "primary" ? "Primary" : "Replica"}
            </span>
          )}
        </div>
        {syncError && <div className="error">{syncError}</div>}
        {!syncStatus ? (
          <p className="muted">Loading sync status...</p>
        ) : !syncStatus.enabled ? (
          <>
            <h3>Enable Sync</h3>
            <p className="muted">Keep multiple instances in sync: one primary (source of truth) and replicas that pull config from it.</p>
            <div className="form-group">
              <label className="field-label">Role</label>
              <select
                className="input"
                value={syncConfigRole}
                onChange={(e) => setSyncConfigRole(e.target.value)}
                style={{ maxWidth: "280px" }}
              >
                <option value="primary">Primary — source of truth for DNS config</option>
                <option value="replica">Replica — pulls config from primary</option>
              </select>
            </div>
            {syncConfigRole === "replica" && (
              <>
                <div className="form-group">
                  <label className="field-label">Primary URL</label>
                  <input
                    className={`input ${
                      syncEnableReplicaValidation.fieldErrors.primaryUrl
                        ? "input-invalid"
                        : ""
                    }`}
                    placeholder="http://primary-host:8081"
                    value={syncSettingsPrimaryUrl}
                    onChange={(e) => setSyncSettingsPrimaryUrl(e.target.value)}
                  />
                  {syncEnableReplicaValidation.fieldErrors.primaryUrl && (
                    <div className="field-error">
                      {syncEnableReplicaValidation.fieldErrors.primaryUrl}
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label className="field-label">Sync token</label>
                  <input
                    className={`input ${
                      syncEnableReplicaValidation.fieldErrors.syncToken
                        ? "input-invalid"
                        : ""
                    }`}
                    type="password"
                    placeholder="Token from primary"
                    value={syncSettingsToken}
                    onChange={(e) => setSyncSettingsToken(e.target.value)}
                  />
                  {syncEnableReplicaValidation.fieldErrors.syncToken && (
                    <div className="field-error">
                      {syncEnableReplicaValidation.fieldErrors.syncToken}
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label className="field-label">Sync interval</label>
                  <input
                    className={`input ${
                      syncEnableReplicaValidation.fieldErrors.syncInterval
                        ? "input-invalid"
                        : ""
                    }`}
                    placeholder="60s"
                    value={syncSettingsInterval}
                    onChange={(e) => setSyncSettingsInterval(e.target.value)}
                  />
                  {syncEnableReplicaValidation.fieldErrors.syncInterval && (
                    <div className="field-error">
                      {syncEnableReplicaValidation.fieldErrors.syncInterval}
                    </div>
                  )}
                </div>
              </>
            )}
            <button
              className="button primary"
              onClick={() => saveSyncConfig(true, syncConfigRole, syncConfigRole === "replica" ? {
                primary_url: syncSettingsPrimaryUrl,
                sync_token: syncSettingsToken,
                sync_interval: syncSettingsInterval || "60s",
              } : null)}
              disabled={
                syncConfigLoading ||
                (syncConfigRole === "replica" && syncEnableReplicaValidation.hasErrors)
              }
            >
              {syncConfigLoading ? "Saving..." : "Enable sync"}
            </button>
            {syncConfigStatus && <p className="status">{syncConfigStatus}</p>}
            {syncConfigError && <div className="error">{syncConfigError}</div>}
          </>
        ) : syncStatus.role === "primary" ? (
          <>
            <h3>Sync Tokens</h3>
            <p className="muted">Create tokens for replicas to authenticate when pulling config.</p>
            <div className="form-group" style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <input
                className="input"
                placeholder="Token name (e.g. Replica A)"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                style={{ maxWidth: "200px" }}
              />
              <button className="button primary" onClick={createSyncToken} disabled={syncLoading}>
                Create token
              </button>
            </div>
            {createdToken && (
              <div className="status" style={{ marginTop: "12px", padding: "12px", background: "#f0f0f0", borderRadius: "4px" }}>
                <strong>New token (copy now, it will not be shown again):</strong>
                <pre style={{ margin: "8px 0 0", wordBreak: "break-all" }}>{createdToken}</pre>
              </div>
            )}
            <div className="form-group" style={{ marginTop: "24px" }}>
              <label className="field-label">Active tokens</label>
              {syncStatus.tokens?.length === 0 ? (
                <p className="muted">No tokens yet. Create one above.</p>
              ) : (
                <div className="list">
                  {syncStatus.tokens?.map((t) => (
                    <div key={t.index} className="list-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                      <span>
                        {t.name || "Unnamed"} — {t.id}
                        {t.last_used && (
                          <span className="muted" style={{ marginLeft: "8px", fontSize: "0.9em" }}>
                            (last pulled: {new Date(t.last_used).toLocaleString()})
                          </span>
                        )}
                      </span>
                      <button
                        className="icon-button"
                        onClick={() => revokeSyncToken(t.index)}
                        disabled={syncLoading}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="form-group" style={{ marginTop: "24px", paddingTop: "16px", borderTop: "1px solid #eee" }}>
              <button className="button" onClick={disableSync} disabled={syncConfigLoading}>
                Disable sync
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>Replica Settings</h3>
            <p className="muted">Configure connection to primary. Restart the application after saving.</p>
            {syncStatus.last_pulled_at && (
              <div className="card" style={{ marginBottom: "16px" }}>
                <div className="card-label">Sync status</div>
                <div className="card-value">Last pulled: {new Date(syncStatus.last_pulled_at).toLocaleString()}</div>
              </div>
            )}
            <div className="form-group">
              <label className="field-label">Primary URL</label>
              <input
                className={`input ${
                  syncSettingsValidation.fieldErrors.primaryUrl ? "input-invalid" : ""
                }`}
                placeholder="http://primary-host:8081"
                value={syncSettingsPrimaryUrl}
                onChange={(e) => setSyncSettingsPrimaryUrl(e.target.value)}
              />
              {syncSettingsValidation.fieldErrors.primaryUrl && (
                <div className="field-error">
                  {syncSettingsValidation.fieldErrors.primaryUrl}
                </div>
              )}
            </div>
            <div className="form-group">
              <label className="field-label">Sync token</label>
              <input
                className={`input ${
                  syncSettingsValidation.fieldErrors.syncToken ? "input-invalid" : ""
                }`}
                type="password"
                placeholder="Token from primary"
                value={syncSettingsToken}
                onChange={(e) => setSyncSettingsToken(e.target.value)}
              />
              {syncSettingsValidation.fieldErrors.syncToken && (
                <div className="field-error">
                  {syncSettingsValidation.fieldErrors.syncToken}
                </div>
              )}
            </div>
            <div className="form-group">
              <label className="field-label">Sync interval</label>
              <input
                className={`input ${
                  syncSettingsValidation.fieldErrors.syncInterval ? "input-invalid" : ""
                }`}
                placeholder="60s"
                value={syncSettingsInterval}
                onChange={(e) => setSyncSettingsInterval(e.target.value)}
              />
              {syncSettingsValidation.fieldErrors.syncInterval && (
                <div className="field-error">
                  {syncSettingsValidation.fieldErrors.syncInterval}
                </div>
              )}
            </div>
            <button
              className="button primary"
              onClick={saveSyncSettings}
              disabled={syncSettingsValidation.hasErrors}
            >
              Save settings
            </button>
            {syncSettingsStatus && <p className="status">{syncSettingsStatus}</p>}
            {syncSettingsError && <div className="error">{syncSettingsError}</div>}
            <div className="form-group" style={{ marginTop: "24px", paddingTop: "16px", borderTop: "1px solid #eee" }}>
              <button className="button" onClick={disableSync} disabled={syncConfigLoading}>
                Disable sync
              </button>
            </div>
          </>
        )}
      </section>
      )}

      {activeTab === "system" && (
      <section className="section">
        <div className="section-header">
          <h2>System Settings</h2>
          <div className="actions">
            <button
              className="button primary"
              onClick={saveSystemConfig}
              disabled={systemConfigLoading || !systemConfig}
            >
              {systemConfigLoading ? "Saving..." : "Save"}
            </button>
            <button
              className="button"
              onClick={restartService}
              disabled={restartLoading}
            >
              {restartLoading ? "Restarting..." : "Restart service"}
            </button>
          </div>
        </div>
        <p className="muted">
          These settings require a restart to take effect. Changes are saved to the config file.
        </p>
        {systemConfigStatus && <p className="status">{systemConfigStatus}</p>}
        {systemConfigError && <div className="error">{systemConfigError}</div>}
        {!systemConfig ? (
          <p className="muted">Loading...</p>
        ) : (
          <>
            <h3>Server</h3>
            <div className="form-group">
              <label className="field-label">Listen addresses (comma-separated)</label>
              <input
                className="input"
                value={systemConfig.server?.listen || ""}
                onChange={(e) => updateSystemConfig("server", "listen", e.target.value)}
                placeholder="0.0.0.0:53"
              />
            </div>
            <div className="form-group">
              <label className="field-label">Read timeout</label>
              <input
                className="input"
                value={systemConfig.server?.read_timeout || ""}
                onChange={(e) => updateSystemConfig("server", "read_timeout", e.target.value)}
                placeholder="5s"
                style={{ maxWidth: "120px" }}
              />
            </div>
            <div className="form-group">
              <label className="field-label">Write timeout</label>
              <input
                className="input"
                value={systemConfig.server?.write_timeout || ""}
                onChange={(e) => updateSystemConfig("server", "write_timeout", e.target.value)}
                placeholder="5s"
                style={{ maxWidth: "120px" }}
              />
            </div>

            <h3>Cache (Redis)</h3>
            <div className="form-group">
              <label className="field-label">Redis address</label>
              <input
                className="input"
                value={systemConfig.cache?.redis_address || ""}
                onChange={(e) => updateSystemConfig("cache", "redis_address", e.target.value)}
                placeholder="redis:6379"
              />
            </div>
            <div className="form-group">
              <label className="field-label">Min TTL</label>
              <input
                className="input"
                value={systemConfig.cache?.min_ttl || ""}
                onChange={(e) => updateSystemConfig("cache", "min_ttl", e.target.value)}
                placeholder="300s"
                style={{ maxWidth: "120px" }}
              />
            </div>
            <div className="form-group">
              <label className="field-label">Max TTL</label>
              <input
                className="input"
                value={systemConfig.cache?.max_ttl || ""}
                onChange={(e) => updateSystemConfig("cache", "max_ttl", e.target.value)}
                placeholder="1h"
                style={{ maxWidth: "120px" }}
              />
            </div>

            <h3>Query Store (ClickHouse)</h3>
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              Query store settings (including flush intervals) are not replicated via sync; each instance uses its own.
            </p>
            <div className="form-group">
              <label className="field-label">
                <input
                  type="checkbox"
                  checked={systemConfig.query_store?.enabled !== false}
                  onChange={(e) => updateSystemConfig("query_store", "enabled", e.target.checked)}
                />
                {" "}Enabled
              </label>
            </div>
            <div className="form-group">
              <label className="field-label">Address</label>
              <input
                className="input"
                value={systemConfig.query_store?.address || ""}
                onChange={(e) => updateSystemConfig("query_store", "address", e.target.value)}
                placeholder="http://clickhouse:8123"
              />
            </div>
            <div className="form-group">
              <label className="field-label">Database</label>
              <input
                className="input"
                value={systemConfig.query_store?.database || ""}
                onChange={(e) => updateSystemConfig("query_store", "database", e.target.value)}
                placeholder="beyond_ads"
                style={{ maxWidth: "200px" }}
              />
            </div>
            <div className="form-group">
              <label className="field-label">Table</label>
              <input
                className="input"
                value={systemConfig.query_store?.table || ""}
                onChange={(e) => updateSystemConfig("query_store", "table", e.target.value)}
                placeholder="dns_queries"
                style={{ maxWidth: "200px" }}
              />
            </div>
            <div className="form-group">
              <label className="field-label">Flush to store interval</label>
              <input
                className="input"
                value={systemConfig.query_store?.flush_to_store_interval || "5s"}
                onChange={(e) => updateSystemConfig("query_store", "flush_to_store_interval", e.target.value || "5s")}
                placeholder="5s"
                style={{ maxWidth: "120px" }}
                title="How often the app sends buffered events to ClickHouse (e.g. 5m, 1m, 30s). Not replicated via sync."
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                How often the app sends buffered query events to ClickHouse.
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Flush to disk interval</label>
              <input
                className="input"
                value={systemConfig.query_store?.flush_to_disk_interval || "5s"}
                onChange={(e) => updateSystemConfig("query_store", "flush_to_disk_interval", e.target.value || "5s")}
                placeholder="5s"
                style={{ maxWidth: "120px" }}
                title="How often ClickHouse flushes async inserts to disk (e.g. 5m, 1m, 30s). Not replicated via sync."
              />
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                How often ClickHouse flushes buffered inserts to disk (async_insert_busy_timeout_ms).
              </p>
            </div>
            <div className="form-group">
              <label className="field-label">Retention days</label>
              <input
                className="input"
                type="number"
                min={1}
                value={systemConfig.query_store?.retention_days ?? 7}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  updateSystemConfig("query_store", "retention_days", Number.isNaN(v) || v < 1 ? 7 : v);
                }}
                style={{ maxWidth: "80px" }}
              />
            </div>

            <h3>Client Identification</h3>
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              Map client IPs to friendly names for per-device analytics. Enables &quot;Which device queries X?&quot; in query logs.
            </p>
            <div className="form-group">
              <label className="field-label">
                <input
                  type="checkbox"
                  checked={systemConfig.client_identification?.enabled === true}
                  onChange={(e) => updateSystemConfig("client_identification", "enabled", e.target.checked)}
                />
                {" "}Enabled
              </label>
            </div>
            <div className="form-group">
              <label className="field-label">Client mappings (IP → name)</label>
              {(systemConfig.client_identification?.clients || []).map((c, i) => (
                <div key={i} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", alignItems: "center" }}>
                  <input
                    className="input"
                    placeholder="IP (e.g. 192.168.1.10)"
                    value={c.ip || ""}
                    onChange={(e) => {
                      const clients = [...(systemConfig.client_identification?.clients || [])];
                      clients[i] = { ...clients[i], ip: e.target.value };
                      updateSystemConfig("client_identification", "clients", clients);
                    }}
                    style={{ flex: 1, maxWidth: "180px" }}
                  />
                  <span>→</span>
                  <input
                    className="input"
                    placeholder="Name (e.g. kids-phone)"
                    value={c.name || ""}
                    onChange={(e) => {
                      const clients = [...(systemConfig.client_identification?.clients || [])];
                      clients[i] = { ...clients[i], name: e.target.value };
                      updateSystemConfig("client_identification", "clients", clients);
                    }}
                    style={{ flex: 1, maxWidth: "180px" }}
                  />
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      const clients = (systemConfig.client_identification?.clients || []).filter((_, j) => j !== i);
                      updateSystemConfig("client_identification", "clients", clients);
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button"
                onClick={() => {
                  const clients = [...(systemConfig.client_identification?.clients || []), { ip: "", name: "" }];
                  updateSystemConfig("client_identification", "clients", clients);
                }}
              >
                Add client
              </button>
            </div>

            <h3>Control API</h3>
            <div className="form-group">
              <label className="field-label">
                <input
                  type="checkbox"
                  checked={systemConfig.control?.enabled !== false}
                  onChange={(e) => updateSystemConfig("control", "enabled", e.target.checked)}
                />
                {" "}Enabled
              </label>
            </div>
            <div className="form-group">
              <label className="field-label">Listen address</label>
              <input
                className="input"
                value={systemConfig.control?.listen || ""}
                onChange={(e) => updateSystemConfig("control", "listen", e.target.value)}
                placeholder="0.0.0.0:8081"
              />
            </div>

            <h3>UI</h3>
            <div className="form-group">
              <label className="field-label">Hostname (displayed in header)</label>
              <input
                className="input"
                value={systemConfig.ui?.hostname || ""}
                onChange={(e) => updateSystemConfig("ui", "hostname", e.target.value)}
                placeholder="Leave empty for system hostname"
              />
            </div>
          </>
        )}
      </section>
      )}

      {activeTab === "config" && (
      <section className="section">
        <div className="section-header">
          <h2>Active Configuration</h2>
          <div className="actions">
            <label className="button">
              Import
              <input
                type="file"
                accept=".yaml,.yml"
                onChange={importConfig}
                style={{ display: "none" }}
              />
            </label>
            <button className="button primary" onClick={exportConfig}>
              Export
            </button>
            <button
              className="button"
              onClick={restartService}
              disabled={restartLoading}
            >
              {restartLoading ? "Restarting..." : "Restart service"}
            </button>
          </div>
        </div>
        {configError && <div className="error">{configError}</div>}
        {importStatus && <p className="status">{importStatus}</p>}
        {importError && <div className="error">{importError}</div>}
        {restartError && <div className="error">{restartError}</div>}
        <pre className="code-block">
          {activeConfig ? JSON.stringify(activeConfig, null, 2) : "Loading..."}
        </pre>
      </section>
      )}
    </div>
  );
}

function DomainEditor({ items, onAdd, onRemove }) {
  const [value, setValue] = useState("");
  return (
    <div className="domain-editor">
      <div className="domain-input">
        <input
          className="input"
          placeholder="example.com"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          className="button"
          onClick={() => {
            onAdd(value);
            setValue("");
          }}
        >
          Add
        </button>
      </div>
      <div className="tags">
        {items.length === 0 && <span className="muted">None</span>}
        {items.map((item) => (
          <span key={item} className="tag">
            {item}
            <button className="tag-remove" onClick={() => onRemove(item)}>
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

function buildQueryParams({
  queryPage,
  queryPageSize,
  querySortBy,
  querySortDir,
  filterQName,
  filterOutcome,
  filterRcode,
  filterClient,
  filterQtype,
  filterProtocol,
  filterSinceMinutes,
  filterMinLatency,
  filterMaxLatency,
}) {
  const params = new URLSearchParams({
    page: String(queryPage),
    page_size: String(queryPageSize),
    sort_by: querySortBy,
    sort_dir: querySortDir,
  });
  if (filterQName) params.set("qname", filterQName);
  if (filterOutcome) params.set("outcome", filterOutcome);
  if (filterRcode) params.set("rcode", filterRcode);
  if (filterClient) params.set("client_ip", filterClient);
  if (filterQtype) params.set("qtype", filterQtype);
  if (filterProtocol) params.set("protocol", filterProtocol);
  if (filterSinceMinutes) params.set("since_minutes", filterSinceMinutes);
  if (filterMinLatency) params.set("min_duration_ms", filterMinLatency);
  if (filterMaxLatency) params.set("max_duration_ms", filterMaxLatency);
  return params;
}

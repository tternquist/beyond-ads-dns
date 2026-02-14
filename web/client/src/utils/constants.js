export const REFRESH_OPTIONS = [
  { label: "5s", value: 5000 },
  { label: "15s", value: 15000 },
  { label: "30s", value: 30000 },
  { label: "1m", value: 60000 },
  { label: "Pause", value: 0 },
];
export const REFRESH_MS = 5000;
export const QUERY_WINDOW_OPTIONS = [
  { label: "15 min", value: 15 },
  { label: "1 hour", value: 60 },
  { label: "6 hours", value: 360 },
  { label: "24 hours", value: 1440 },
];
export const BLOCKLIST_REFRESH_DEFAULT = "6h";
export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const BLOCKLIST_PRESETS = [
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
export const TABS = [
  { id: "overview", label: "Overview", group: "monitor", icon: "overview" },
  { id: "queries", label: "Queries", group: "monitor", icon: "queries" },
  { id: "blocklists", label: "Blocklists", group: "configure", icon: "blocklists" },
  { id: "dns", label: "DNS Settings", group: "configure", icon: "dns" },
  { id: "sync", label: "Sync", group: "admin", icon: "sync" },
  { id: "system", label: "System Settings", group: "admin", icon: "system" },
  { id: "config", label: "Config", group: "admin", icon: "config" },
];
export const SUPPORTED_LOCAL_RECORD_TYPES = new Set(["A", "AAAA", "CNAME", "TXT", "PTR"]);
export const DURATION_PATTERN = /^(?:(?:\d+(?:\.\d+)?)(?:ns|us|µs|μs|ms|s|m|h))+$/i;
export const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
export const EMPTY_SYNC_VALIDATION = {
  hasErrors: false,
  summary: "",
  fieldErrors: { primaryUrl: "", syncToken: "", syncInterval: "" },
  normalized: { primaryUrl: "", syncToken: "", syncInterval: "" },
};
export const OUTCOME_TO_FILTER = {
  Cached: "cached",
  Local: "local",
  Forwarded: "upstream",
  Blocked: "blocked",
  "Upstream error": "upstream_error",
  Invalid: "invalid",
  Other: null,
};
export const METRIC_TOOLTIPS = {
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
export const STATUS_LABELS = {
  cached: "Cached",
  local: "Local",
  safe_search: "Safe Search",
  upstream: "Forwarded",
  blocked: "Blocked",
  upstream_error: "Upstream error",
  invalid: "Invalid",
};
export const OUTCOME_COLORS = {
  cached: "#22c55e",
  local: "#3b82f6",
  safe_search: "#06b6d4",
  upstream: "#8b5cf6",
  blocked: "#ef4444",
  upstream_error: "#f59e0b",
  invalid: "#6b7280",
  other: "#9ca3af",
};
export const UPSTREAM_COLORS = [
  "#3b82f6", "#8b5cf6", "#22c55e", "#f59e0b",
  "#ef4444", "#06b6d4", "#ec4899", "#6366f1",
];
export const QUERY_FILTER_PRESETS = [
  { id: "blocked", label: "Blocked only", outcome: "blocked", sinceMinutes: "" },
  { id: "last-hour", label: "Last hour", outcome: "", sinceMinutes: "60" },
  { id: "slow", label: "Slow queries (>100ms)", outcome: "", minLatency: "100" },
  { id: "clear", label: "Clear all", outcome: "", sinceMinutes: "", minLatency: "", maxLatency: "" },
];
export const COLLAPSIBLE_STORAGE_KEY = "dns-ui-collapsed-sections";
export const SIDEBAR_COLLAPSED_KEY = "dns-ui-sidebar-collapsed";

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

/**
 * Suggested blocklist sources for quick-add in the UI.
 * Each entry can be added individually to global or group-level blocklists.
 * Categories: strict (max blocking), balanced, minimal (light), malware, family.
 */
export const SUGGESTED_BLOCKLISTS = [
  // Strict — maximum blocking
  {
    name: "Hagezi Pro Plus",
    url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/pro.plus.txt",
    description: "Maximum blocking: ads, trackers, malware. Best for power users.",
    category: "strict",
  },
  {
    name: "OISD Big",
    url: "https://big.oisd.nl/",
    description: "Large curated list. Ads, trackers, telemetry. Well-maintained.",
    category: "strict",
  },
  // Balanced — good for most users
  {
    name: "Hagezi Pro",
    url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/pro.txt",
    description: "Balanced blocking. Recommended for families.",
    category: "balanced",
  },
  {
    name: "OISD Basic",
    url: "https://abp.oisd.nl/",
    description: "Curated list. Ads, trackers. Fewer false positives than Big.",
    category: "balanced",
  },
  // Minimal — light blocking
  {
    name: "Hagezi Light",
    url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/light.txt",
    description: "Light blocking. Good for getting started.",
    category: "minimal",
  },
  // Malware
  {
    name: "URLhaus",
    url: "https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-agh.txt",
    description: "Malware and phishing domains. From abuse.ch.",
    category: "malware",
  },
  // Family / parental
  {
    name: "Hagezi TIF",
    url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/tif.txt",
    description: "Threat Intelligence Feeds. Malware, phishing, C2.",
    category: "malware",
  },
];

/**
 * Blockable consumer services for parental controls.
 * Each service maps to domains that, when blocked, prevent access.
 * Domains use apex form; blocklist blocks domain + all subdomains.
 * Sources: Pi-hole/Diversion lists, hagezi blocklists, service documentation.
 */
export const BLOCKABLE_SERVICES = [
  { id: "tiktok", name: "TikTok", domains: ["tiktok.com", "tiktokv.com", "tiktokcdn.com", "tiktokcdn-us.com", "byteoversea.com", "musically.com", "snssdk.com", "amemv.com", "tiktokapi.com"] },
  { id: "roblox", name: "Roblox", domains: ["roblox.com", "rbxcdn.com", "roblox.cn", "rbx.com"] },
  { id: "youtube", name: "YouTube", domains: ["youtube.com", "googlevideo.com", "ytimg.com", "youtube-nocookie.com", "youtubei.com", "youtubeeducation.com"] },
  { id: "instagram", name: "Instagram", domains: ["instagram.com", "cdninstagram.com", "instagramstatic.com"] },
  { id: "netflix", name: "Netflix", domains: ["netflix.com", "nflxvideo.net", "nflxext.com", "nflxso.net", "nflximg.net", "netflixdnstest.com"] },
  { id: "facebook", name: "Facebook", domains: ["facebook.com", "fbcdn.net", "fb.com", "fbcdn.com"] },
  { id: "snapchat", name: "Snapchat", domains: ["snapchat.com", "sc-cdn.net", "snap-dev.net"] },
  { id: "twitter", name: "X (Twitter)", domains: ["twitter.com", "x.com", "twimg.com", "t.co", "pscp.tv", "periscope.tv"] },
  { id: "discord", name: "Discord", domains: ["discord.com", "discordapp.com", "discord.gg", "discord.media"] },
  { id: "twitch", name: "Twitch", domains: ["twitch.tv", "ttvnw.net", "jtvnw.net", "twitchcdn.net"] },
  { id: "reddit", name: "Reddit", domains: ["reddit.com", "redditmedia.com", "redd.it", "redditstatic.com"] },
  { id: "pinterest", name: "Pinterest", domains: ["pinterest.com", "pinimg.com"] },
  { id: "whatsapp", name: "WhatsApp", domains: ["whatsapp.com", "whatsapp.net"] },
  { id: "telegram", name: "Telegram", domains: ["telegram.org", "t.me", "telegra.ph"] },
  { id: "linkedin", name: "LinkedIn", domains: ["linkedin.com", "licdn.com"] },
  { id: "spotify", name: "Spotify", domains: ["spotify.com", "scdn.co", "spotifycdn.com"] },
  { id: "fortnite", name: "Fortnite", domains: ["fortnite.com", "epicgames.com", "epicgames.dev", "epicgamesstore.com"] },
];
export const TABS = [
  { id: "overview", label: "Overview", group: "monitor", icon: "overview" },
  { id: "queries", label: "Queries", group: "monitor", icon: "queries" },
  { id: "replica-stats", label: "Multi-Instance", group: "monitor", icon: "multiInstance", primaryOnly: true },
  { id: "blocklists", label: "Blocklists", group: "configure", icon: "blocklists" },
  { id: "clients", label: "Clients", group: "configure", icon: "clients" },
  { id: "dns", label: "DNS Settings", group: "configure", icon: "dns" },
  { id: "integrations", label: "Integrations", group: "tools", icon: "integrations" },
  { id: "error-viewer", label: "Error Viewer", group: "tools", icon: "errorViewer" },
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
  Stale: "stale",
  Forwarded: "upstream",
  Blocked: "blocked",
  "Upstream error": "upstream_error",
  Invalid: "invalid",
  Other: null,
};
export const METRIC_TOOLTIPS = {
  "Cached": "Queries answered from cache without contacting upstream servers. High cache rate improves performance.",
  "Local": "Queries answered from local/static records (e.g. custom DNS entries).",
  "Stale": "Queries served from expired cache entries while a refresh is in progress (serve_stale enabled).",
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
  stale: "Stale",
  safe_search: "Safe Search",
  upstream: "Forwarded",
  blocked: "Blocked",
  upstream_error: "Upstream error",
  invalid: "Invalid",
};
export const OUTCOME_COLORS = {
  cached: "#22c55e",
  local: "#3b82f6",
  stale: "#facc15",
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
  { id: "errors", label: "Errors only", outcome: "upstream_error,invalid", sinceMinutes: "" },
  { id: "blocked", label: "Blocked only", outcome: "blocked", sinceMinutes: "" },
  { id: "last-hour", label: "Last hour", outcome: "", sinceMinutes: "60" },
  { id: "slow", label: "Slow queries (>100ms)", outcome: "", minLatency: "100" },
  { id: "clear", label: "Clear all", outcome: "", sinceMinutes: "", minLatency: "", maxLatency: "" },
];
export const COLLAPSIBLE_STORAGE_KEY = "dns-ui-collapsed-sections";
export const SIDEBAR_COLLAPSED_KEY = "dns-ui-sidebar-collapsed";
export const SETTINGS_SHOW_ADVANCED_KEY = "dns-ui-settings-show-advanced";

/**
 * Suggested upstream DNS resolvers for quick-add in the UI.
 * Includes well-known public resolvers for each supported protocol:
 * UDP, TCP (plain DNS), DoT (DNS over TLS), DoH (DNS over HTTPS).
 */
export const SUGGESTED_UPSTREAM_RESOLVERS = [
  // UDP (plain DNS)
  { name: "Cloudflare", address: "1.1.1.1:53", protocol: "udp" },
  { name: "Google", address: "8.8.8.8:53", protocol: "udp" },
  { name: "Quad9", address: "9.9.9.9:53", protocol: "udp" },
  // TCP (plain DNS)
  { name: "Cloudflare", address: "1.1.1.1:53", protocol: "tcp" },
  { name: "Google", address: "8.8.8.8:53", protocol: "tcp" },
  { name: "Quad9", address: "9.9.9.9:53", protocol: "tcp" },
  // DoT (DNS over TLS)
  { name: "Cloudflare", address: "tls://1.1.1.1:853", protocol: "tls" },
  { name: "Google", address: "tls://8.8.8.8:853", protocol: "tls" },
  { name: "Quad9", address: "tls://9.9.9.9:853", protocol: "tls" },
  // DoH (DNS over HTTPS)
  { name: "Cloudflare", address: "https://cloudflare-dns.com/dns-query", protocol: "https" },
  { name: "Google", address: "https://dns.google/dns-query", protocol: "https" },
  { name: "Quad9", address: "https://dns.quad9.net/dns-query", protocol: "https" },
];

/** Trace event labels and descriptions for the Error Viewer UI. */
export const TRACE_EVENT_DESCRIPTIONS = {
  refresh_upstream: {
    label: "Refresh upstream",
    description: "Background refresh requests to upstream DNS",
  },
  query_resolution: {
    label: "Query resolution",
    description: "Full query path: outcome (local, cached, stale, blocked, etc.)",
  },
  upstream_exchange: {
    label: "Upstream exchange",
    description: "Client-initiated upstream queries: selected upstream, retries",
  },
};

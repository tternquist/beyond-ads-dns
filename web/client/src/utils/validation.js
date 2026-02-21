import { DURATION_PATTERN, DNS_LABEL_PATTERN, SUPPORTED_LOCAL_RECORD_TYPES } from "./constants.js";

export function isValidDuration(value) {
  const raw = String(value || "").trim();
  if (!raw || !DURATION_PATTERN.test(raw)) return false;
  return /[1-9]/.test(raw);
}

export function isValidHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function isValidDnsName(value) {
  const normalized = String(value || "").trim().replace(/\.$/, "");
  if (!normalized || normalized.length > 253) return false;
  const labels = normalized.split(".");
  return labels.every((label) => DNS_LABEL_PATTERN.test(label));
}

export function isValidIPv4(value) {
  const raw = String(value || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const num = Number(part);
    return num >= 0 && num <= 255;
  });
}

export function isValidIPv6(value) {
  const raw = String(value || "").trim();
  if (!raw || !raw.includes(":")) return false;
  try {
    new URL(`http://[${raw}]`);
    return true;
  } catch {
    return false;
  }
}

export function validateUpstreamAddress(address) {
  const raw = String(address || "").trim();
  if (!raw) return "Address is required.";
  if (raw.startsWith("tls://")) {
    const hostPort = raw.slice(6);
    const ipv6Match = hostPort.match(/^\[([^\]]+)\]:(\d{1,5})$/);
    if (ipv6Match) {
      if (!isValidIPv6(ipv6Match[1])) return "DoT: IPv6 must be valid (example: tls://[2606:4700:4700::1111]:853).";
      const port = Number(ipv6Match[2]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return "Port must be between 1 and 65535.";
    } else {
      const hostPortMatch = hostPort.match(/^([^:]+):(\d{1,5})$/);
      if (!hostPortMatch) return "DoT: use tls://host:port (example: tls://1.1.1.1:853).";
      const host = hostPortMatch[1];
      const port = Number(hostPortMatch[2]);
      const normalizedHost = host.toLowerCase();
      if (!isValidIPv4(host) && !isValidDnsName(host) && normalizedHost !== "localhost") {
        return "DoT: host must be IPv4, IPv6 in brackets, or valid hostname.";
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) return "Port must be between 1 and 65535.";
    }
    return "";
  }
  if (raw.startsWith("https://")) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "https:") return "DoH: URL must use https://.";
      if (!parsed.hostname) return "DoH: hostname is required.";
      if (!parsed.pathname || parsed.pathname === "/") return "DoH: path is required (example: /dns-query).";
      return "";
    } catch {
      return "DoH: use valid HTTPS URL (example: https://cloudflare-dns.com/dns-query).";
    }
  }
  let host = "";
  let portString = "";
  const ipv6Match = raw.match(/^\[([^\]]+)\]:(\d{1,5})$/);
  if (ipv6Match) {
    host = ipv6Match[1];
    portString = ipv6Match[2];
    if (!isValidIPv6(host)) return "IPv6 must be valid and wrapped in brackets (example: [2606:4700:4700::1111]:53).";
  } else {
    const hostPortMatch = raw.match(/^([^:]+):(\d{1,5})$/);
    if (!hostPortMatch) return "Use host:port (example: 1.1.1.1:53), tls://host:853 for DoT, or https://host/dns-query for DoH.";
    host = hostPortMatch[1];
    portString = hostPortMatch[2];
    const normalizedHost = host.toLowerCase();
    if (!isValidIPv4(host) && !isValidDnsName(host) && normalizedHost !== "localhost") {
      return "Host must be IPv4, bracketed IPv6, localhost, or a valid hostname.";
    }
  }
  const port = Number(portString);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "Port must be between 1 and 65535.";
  return "";
}

function getFirstRowError(rowErrors) {
  for (const rowError of rowErrors) {
    for (const message of Object.values(rowError || {})) {
      if (message) return message;
    }
  }
  return "";
}

export function getRowErrorText(rowError) {
  return Object.values(rowError || {}).filter(Boolean).join(" ");
}

const HHMM_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function validateBlocklistForm({ refreshInterval, sources }) {
  const fieldErrors = { refreshInterval: "" };
  const rowErrors = [];
  const normalizedSources = [];
  const seen = new Set();
  const normalizedRefreshInterval = String(refreshInterval || "").trim();
  if (!isValidDuration(normalizedRefreshInterval)) {
    fieldErrors.refreshInterval = "Refresh interval must be a positive duration (example: 30s, 5m, 1h).";
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
      if (seen.has(key)) rowError.url = "Duplicate source URL.";
      else seen.add(key);
    }
    if (!rowError.url) normalizedSources.push({ name: name || url, url });
    rowErrors.push(rowError);
  }
  const generalErrors = normalizedSources.length === 0
    ? ["At least one valid blocklist source URL is required."]
    : [];
  const hasErrors =
    Boolean(fieldErrors.refreshInterval) ||
    rowErrors.some((r) => Object.keys(r).length > 0) ||
    generalErrors.length > 0;
  const summary = fieldErrors.refreshInterval || getFirstRowError(rowErrors) || generalErrors[0] || "";
  return { hasErrors, summary, fieldErrors, rowErrors, generalErrors, normalizedRefreshInterval, normalizedSources };
}

export function validateScheduledPauseForm({ enabled, start, end, days }) {
  const fieldErrors = { start: "", end: "", days: "" };
  if (!enabled) return { hasErrors: false, fieldErrors, summary: "" };
  const startStr = String(start || "").trim();
  const endStr = String(end || "").trim();
  if (!HHMM_PATTERN.test(startStr)) fieldErrors.start = "Must be HH:MM (e.g. 09:00)";
  if (!HHMM_PATTERN.test(endStr)) fieldErrors.end = "Must be HH:MM (e.g. 17:00)";
  if (HHMM_PATTERN.test(startStr) && HHMM_PATTERN.test(endStr)) {
    const [sh, sm] = startStr.split(":").map(Number);
    const [eh, em] = endStr.split(":").map(Number);
    if (sh > eh || (sh === eh && sm >= em)) fieldErrors.end = "End must be after start";
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

export function validateFamilyTimeForm({ enabled, start, end, days, services }) {
  const fieldErrors = { start: "", end: "", days: "", services: "" };
  if (!enabled) return { hasErrors: false, fieldErrors, summary: "" };
  const startStr = String(start || "").trim();
  const endStr = String(end || "").trim();
  if (!HHMM_PATTERN.test(startStr)) fieldErrors.start = "Must be HH:MM (e.g. 17:00)";
  if (!HHMM_PATTERN.test(endStr)) fieldErrors.end = "Must be HH:MM (e.g. 20:00)";
  if (HHMM_PATTERN.test(startStr) && HHMM_PATTERN.test(endStr)) {
    const [sh, sm] = startStr.split(":").map(Number);
    const [eh, em] = endStr.split(":").map(Number);
    if (sh > eh || (sh === eh && sm >= em)) fieldErrors.end = "End must be after start";
  }
  const daysArr = Array.isArray(days) ? days : [];
  for (const d of daysArr) {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      fieldErrors.days = "Days must be 0-6 (0=Sun, 6=Sat)";
      break;
    }
  }
  const servicesArr = Array.isArray(services) ? services : [];
  if (servicesArr.length === 0) {
    fieldErrors.services = "Select at least one service to block";
  }
  const hasErrors = Boolean(fieldErrors.start || fieldErrors.end || fieldErrors.days || fieldErrors.services);
  const summary = fieldErrors.start || fieldErrors.end || fieldErrors.days || fieldErrors.services || "";
  return { hasErrors, fieldErrors, summary };
}

export function validateUpstreamsForm(upstreams) {
  const rowErrors = [];
  const generalErrors = [];
  const normalizedUpstreams = [];
  const seen = new Set();
  for (let index = 0; index < upstreams.length; index += 1) {
    const upstream = upstreams[index] || {};
    const name = String(upstream.name || "").trim();
    const address = String(upstream.address || "").trim();
    const protocol = String(upstream.protocol || "udp").trim().toLowerCase();
    const touched = Boolean(name || address);
    const rowError = {};
    if (!touched) {
      rowErrors.push(rowError);
      continue;
    }
    if (!address) rowError.address = "Address is required.";
    else {
      const addressError = validateUpstreamAddress(address);
      if (addressError) rowError.address = addressError;
    }
    const addrLower = (address || "").toLowerCase();
    if (addrLower.startsWith("tls://")) {
      if (protocol !== "tls") rowError.protocol = "Use protocol DoT for tls:// addresses.";
    } else if (addrLower.startsWith("https://")) {
      if (protocol !== "https") rowError.protocol = "Use protocol DoH for https:// addresses.";
    } else {
      if (protocol !== "udp" && protocol !== "tcp") rowError.protocol = "Use UDP or TCP for plain host:port addresses.";
    }
    let effectiveProtocol = protocol;
    if (addrLower.startsWith("tls://")) effectiveProtocol = "tls";
    else if (addrLower.startsWith("https://")) effectiveProtocol = "https";
    if (!rowError.address && !rowError.protocol) {
      const duplicateKey = `${address.toLowerCase()}|${effectiveProtocol}`;
      if (seen.has(duplicateKey)) rowError.address = "Duplicate upstream address/protocol.";
      else {
        seen.add(duplicateKey);
        normalizedUpstreams.push({ name: name || "upstream", address, protocol: effectiveProtocol });
      }
    }
    rowErrors.push(rowError);
  }
  if (normalizedUpstreams.length === 0) generalErrors.push("At least one valid upstream with an address is required.");
  const hasErrors = rowErrors.some((r) => Object.keys(r).length > 0) || generalErrors.length > 0;
  const summary = getFirstRowError(rowErrors) || generalErrors[0] || "";
  return { hasErrors, summary, rowErrors, generalErrors, normalizedUpstreams };
}

export function validateLocalRecordsForm(records) {
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
    if (!name) rowError.name = "Name is required.";
    else if (!isValidDnsName(name)) rowError.name = "Name must be a valid DNS name.";
    if (!SUPPORTED_LOCAL_RECORD_TYPES.has(type)) rowError.type = "Type must be A, AAAA, CNAME, TXT, or PTR.";
    if (!value) rowError.value = "Value is required.";
    else if (type === "A" && !isValidIPv4(value)) rowError.value = "A records must use a valid IPv4 address.";
    else if (type === "AAAA" && !isValidIPv6(value)) rowError.value = "AAAA records must use a valid IPv6 address.";
    else if ((type === "CNAME" || type === "PTR") && !isValidDnsName(value)) rowError.value = `${type} records must point to a valid hostname.`;
    if (!rowError.name && !rowError.type && !rowError.value) {
      const duplicateKey = `${name}:${type}`;
      if (seen.has(duplicateKey)) rowError.name = `Duplicate record: ${name} ${type}.`;
      else {
        seen.add(duplicateKey);
        normalizedRecords.push({ name, type, value });
      }
    }
    rowErrors.push(rowError);
  }
  const hasErrors = rowErrors.some((r) => Object.keys(r).length > 0);
  const summary = getFirstRowError(rowErrors);
  return { hasErrors, summary, rowErrors, normalizedRecords };
}

export function validateReplicaSyncSettings({ primaryUrl, syncToken, syncInterval, requireToken }) {
  const normalized = {
    primaryUrl: String(primaryUrl || "").trim(),
    syncToken: String(syncToken || "").trim(),
    syncInterval: String(syncInterval || "").trim(),
  };
  const fieldErrors = { primaryUrl: "", syncToken: "", syncInterval: "" };
  if (!normalized.primaryUrl) fieldErrors.primaryUrl = "Primary URL is required.";
  else if (!isValidHttpUrl(normalized.primaryUrl)) fieldErrors.primaryUrl = "Primary URL must start with http:// or https://.";
  if (!normalized.syncInterval) fieldErrors.syncInterval = "Sync interval is required.";
  else if (!isValidDuration(normalized.syncInterval)) fieldErrors.syncInterval = "Sync interval must be a positive duration (example: 30s, 5m, 1h).";
  if (requireToken && !normalized.syncToken) fieldErrors.syncToken = "Sync token is required for replica mode.";
  const summary = fieldErrors.primaryUrl || fieldErrors.syncToken || fieldErrors.syncInterval || "";
  const hasErrors = Boolean(summary);
  return { hasErrors, summary, fieldErrors, normalized };
}

export function validateResponseForm({ blocked, blockedTtl }) {
  const normalizedBlocked = String(blocked ?? "nxdomain").trim().toLowerCase();
  const normalizedBlockedTtl = String(blockedTtl ?? "1h").trim();
  const fieldErrors = { blocked: "", blockedTtl: "" };
  if (normalizedBlocked !== "nxdomain") {
    if (!isValidIPv4(normalizedBlocked) && !isValidIPv6(normalizedBlocked)) {
      fieldErrors.blocked = "Must be nxdomain or a valid IPv4/IPv6 address.";
    }
  }
  if (!isValidDuration(normalizedBlockedTtl)) {
    fieldErrors.blockedTtl = "Blocked TTL must be a positive duration (example: 30s, 1h).";
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

function isValidListenAddress(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  const match = raw.match(/^([^:]+):(\d{1,5})$/);
  if (!match) return false;
  const host = match[1];
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const hostLower = host.toLowerCase();
  if (hostLower === "localhost" || hostLower === "0.0.0.0" || hostLower === "::") return true;
  if (isValidIPv4(host) || isValidIPv6(host)) return true;
  if (isValidDnsName(host)) return true;
  return false;
}

function positiveInt(value, min = 1) {
  const n = parseInt(String(value || "").trim(), 10);
  return !Number.isNaN(n) && n >= min && Number.isSafeInteger(n);
}

function nonNegativeInt(value) {
  const n = parseInt(String(value || "").trim(), 10);
  return !Number.isNaN(n) && n >= 0 && Number.isSafeInteger(n);
}

function sampleRateInRange(value) {
  const n = parseFloat(String(value || "").trim());
  return !Number.isNaN(n) && n >= 0.01 && n <= 1;
}

/**
 * Validates system config fields for the Settings UI.
 * Returns fieldErrors keyed by "section_field" (e.g. query_store_retention_hours).
 */
export function validateSystemConfig(config) {
  if (!config) return { hasErrors: false, fieldErrors: {}, summary: "" };
  const fieldErrors = {};

  // Query Store
  if (config.query_store?.enabled) {
    const rh = String(config.query_store?.retention_hours ?? "").trim();
    if (rh && !positiveInt(rh)) {
      fieldErrors.query_store_retention_hours = "Must be a positive integer (hours).";
    }
    const maxMb = String(config.query_store?.max_size_mb ?? "").trim();
    if (maxMb !== "" && !nonNegativeInt(maxMb)) {
      fieldErrors.query_store_max_size_mb = "Must be 0 or a positive integer (MB).";
    }
  }
  if (config.query_store?.enabled) {
    const fts = String(config.query_store?.flush_to_store_interval ?? "").trim();
    if (fts && !isValidDuration(fts)) {
      fieldErrors.query_store_flush_to_store_interval = "Must be a positive duration (e.g. 5s, 1m).";
    }
    const ftd = String(config.query_store?.flush_to_disk_interval ?? "").trim();
    if (ftd && !isValidDuration(ftd)) {
      fieldErrors.query_store_flush_to_disk_interval = "Must be a positive duration (e.g. 5s, 1m).";
    }
    const bs = String(config.query_store?.batch_size ?? "").trim();
    if (bs && !positiveInt(bs)) {
      fieldErrors.query_store_batch_size = "Must be a positive integer.";
    }
    const sr = String(config.query_store?.sample_rate ?? "").trim();
    if (sr && !sampleRateInRange(sr)) {
      fieldErrors.query_store_sample_rate = "Must be between 0.01 and 1.0.";
    }
  }

  // Server
  const rpl = String(config.server?.reuse_port_listeners ?? "").trim();
  if (rpl) {
    const n = parseInt(rpl, 10);
    if (Number.isNaN(n) || n < 1 || n > 64) {
      fieldErrors.server_reuse_port_listeners = "Must be between 1 and 64.";
    }
  }
  const rt = String(config.server?.read_timeout ?? "").trim();
  if (rt && !isValidDuration(rt)) {
    fieldErrors.server_read_timeout = "Must be a positive duration (e.g. 5s, 1m).";
  }
  const wt = String(config.server?.write_timeout ?? "").trim();
  if (wt && !isValidDuration(wt)) {
    fieldErrors.server_write_timeout = "Must be a positive duration (e.g. 5s, 1m).";
  }

  // Cache
  const rls = String(config.cache?.redis_lru_size ?? "").trim();
  if (rls && !nonNegativeInt(rls)) {
    fieldErrors.cache_redis_lru_size = "Must be 0 or a positive integer.";
  }
  const minTtl = String(config.cache?.min_ttl ?? "").trim();
  if (minTtl && !isValidDuration(minTtl)) {
    fieldErrors.cache_min_ttl = "Must be a positive duration (e.g. 300s, 1h).";
  }
  const maxTtl = String(config.cache?.max_ttl ?? "").trim();
  if (maxTtl && !isValidDuration(maxTtl)) {
    fieldErrors.cache_max_ttl = "Must be a positive duration (e.g. 1h, 24h).";
  }
  const negTtl = String(config.cache?.negative_ttl ?? "").trim();
  if (negTtl && !isValidDuration(negTtl)) {
    fieldErrors.cache_negative_ttl = "Must be a positive duration (e.g. 5m, 1h).";
  }
  const sfb = String(config.cache?.servfail_backoff ?? "").trim();
  if (sfb && !isValidDuration(sfb)) {
    fieldErrors.cache_servfail_backoff = "Must be a positive duration (e.g. 60s).";
  }
  const mi = String(config.cache?.max_inflight ?? "").trim();
  if (mi && !positiveInt(mi)) {
    fieldErrors.cache_max_inflight = "Must be a positive integer.";
  }
  const mbs = String(config.cache?.max_batch_size ?? "").trim();
  if (mbs && !positiveInt(mbs)) {
    fieldErrors.cache_max_batch_size = "Must be a positive integer.";
  }
  const si = String(config.cache?.sweep_interval ?? "").trim();
  if (si && !isValidDuration(si)) {
    fieldErrors.cache_sweep_interval = "Must be a positive duration (e.g. 15s).";
  }
  const sw = String(config.cache?.sweep_window ?? "").trim();
  if (sw && !isValidDuration(sw)) {
    fieldErrors.cache_sweep_window = "Must be a positive duration (e.g. 1m).";
  }
  const smh = String(config.cache?.sweep_min_hits ?? "").trim();
  if (smh && !nonNegativeInt(smh)) {
    fieldErrors.cache_sweep_min_hits = "Must be 0 or a positive integer.";
  }
  const shw = String(config.cache?.sweep_hit_window ?? "").trim();
  if (shw && !isValidDuration(shw)) {
    fieldErrors.cache_sweep_hit_window = "Must be a positive duration (e.g. 168h).";
  }
  const stTtl = String(config.cache?.stale_ttl ?? "").trim();
  if (stTtl && !isValidDuration(stTtl)) {
    fieldErrors.cache_stale_ttl = "Must be a positive duration (e.g. 1h).";
  }
  const eeTtl = String(config.cache?.expired_entry_ttl ?? "").trim();
  if (eeTtl && !isValidDuration(eeTtl)) {
    fieldErrors.cache_expired_entry_ttl = "Must be a positive duration (e.g. 30s).";
  }

  // Control
  if (config.control?.enabled !== false) {
    const listen = String(config.control?.listen ?? "").trim();
    if (listen && !isValidListenAddress(listen)) {
      fieldErrors.control_listen = "Must be host:port (e.g. 0.0.0.0:8081).";
    }
    const erd = String(config.control?.errors_retention_days ?? "").trim();
    if (erd && !positiveInt(erd)) {
      fieldErrors.control_errors_retention_days = "Must be a positive integer (days).";
    }
  }

  const firstError = Object.values(fieldErrors).find(Boolean);
  const hasErrors = Object.keys(fieldErrors).length > 0;
  const summary = firstError || "";
  return { hasErrors, fieldErrors, summary };
}

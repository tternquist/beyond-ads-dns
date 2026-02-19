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

/**
 * YAML config loading, merging, and writing utilities.
 */
import fsPromises from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export async function readYamlFile(filePath) {
  if (!filePath) {
    return {};
  }
  try {
    const data = await fsPromises.readFile(filePath, "utf8");
    const parsed = YAML.parse(data);
    return parsed || {};
  } catch (err) {
    if (err.code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

export async function readOverrideConfig(overridePath) {
  return readYamlFile(overridePath);
}

export async function writeConfig(configPath, config) {
  await fsPromises.mkdir(path.dirname(configPath), { recursive: true });
  const content = YAML.stringify(config);
  await fsPromises.writeFile(configPath, content, "utf8");
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function mergeDeep(base, override) {
  if (Array.isArray(override)) {
    return override;
  }
  if (!isObject(base) || !isObject(override)) {
    return override ?? base;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    merged[key] = mergeDeep(base[key], value);
  }
  return merged;
}

export async function readMergedConfig(defaultPath, overridePath) {
  const base = await readYamlFile(defaultPath);
  const override = await readYamlFile(overridePath);
  return mergeDeep(base, override);
}

export function redactConfig(config) {
  const copy = structuredClone(config);
  if (copy?.cache?.redis?.password !== undefined) {
    copy.cache.redis.password = "***";
  }
  if (copy?.query_store?.password !== undefined) {
    copy.query_store.password = "***";
  }
  if (copy?.control?.token !== undefined) {
    copy.control.token = "***";
  }
  return copy;
}

export function getConfigDifferences(defaultConfig, overrideConfig) {
  if (!isObject(defaultConfig) || !isObject(overrideConfig)) {
    return overrideConfig;
  }

  const differences = {};

  for (const [key, overrideValue] of Object.entries(overrideConfig)) {
    const defaultValue = defaultConfig[key];

    if (!(key in defaultConfig)) {
      differences[key] = overrideValue;
      continue;
    }

    if (Array.isArray(overrideValue)) {
      if (!arraysEqual(defaultValue, overrideValue)) {
        differences[key] = overrideValue;
      }
      continue;
    }

    if (isObject(overrideValue) && isObject(defaultValue)) {
      const nestedDiff = getConfigDifferences(defaultValue, overrideValue);
      if (Object.keys(nestedDiff).length > 0) {
        differences[key] = nestedDiff;
      }
      continue;
    }

    if (overrideValue !== defaultValue) {
      differences[key] = overrideValue;
    }
  }

  return differences;
}

export function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

export function removePasswordFields(config) {
  if (!isObject(config)) {
    return;
  }

  if (config.cache?.redis?.password !== undefined) {
    delete config.cache.redis.password;
    if (Object.keys(config.cache.redis).length === 0) {
      delete config.cache.redis;
    }
    if (Object.keys(config.cache).length === 0) {
      delete config.cache;
    }
  }

  if (config.query_store?.password !== undefined) {
    delete config.query_store.password;
    if (Object.keys(config.query_store).length === 0) {
      delete config.query_store;
    }
  }

  if (config.control?.token !== undefined) {
    delete config.control.token;
    if (Object.keys(config.control).length === 0) {
      delete config.control;
    }
  }
}

export function removeInstanceSpecificDetails(config) {
  if (!isObject(config)) {
    return;
  }
  if (config.ui?.hostname !== undefined) {
    delete config.ui.hostname;
    if (Object.keys(config.ui).length === 0) {
      delete config.ui;
    }
  }
  if (config.sync !== undefined) {
    delete config.sync;
  }
}

export function parseExclusionList(value) {
  if (Array.isArray(value)) {
    return value.map((s) => String(s || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export function resolveQueryStoreRetentionHours(queryStore) {
  if (queryStore?.retention_hours !== undefined && queryStore.retention_hours !== null && queryStore.retention_hours > 0) {
    return queryStore.retention_hours;
  }
  const days = queryStore?.retention_days;
  if (days !== undefined && days !== null && days > 0) {
    return days * 24;
  }
  return 168;
}

export function applyQueryStoreEnvOverrides(queryStore) {
  let out = { ...queryStore };
  let maxSizeMbFromEnv = false;
  if ((process.env.QUERY_STORE_MAX_SIZE_MB || "").trim()) {
    const n = parseInt(process.env.QUERY_STORE_MAX_SIZE_MB.trim(), 10);
    if (!Number.isNaN(n) && n >= 0) {
      out.max_size_mb = n;
      maxSizeMbFromEnv = true;
    }
  }
  if ((process.env.QUERY_STORE_RETENTION_HOURS || "").trim()) {
    const n = parseInt(process.env.QUERY_STORE_RETENTION_HOURS.trim(), 10);
    if (!Number.isNaN(n) && n > 0) {
      out.retention_hours = n;
    }
  }
  return { queryStore: out, maxSizeMbFromEnv };
}

export function applyRedisEnvOverrides(redis) {
  const env = (k) => (process.env[k] || "").trim();
  const out = { ...redis };
  const addr = env("REDIS_ADDRESS");
  if (addr) {
    out.address = addr;
  } else {
    const url = env("REDIS_URL");
    if (url) {
      try {
        const u = new URL(url);
        if (u.host) out.address = u.host;
      } catch (_) {}
    }
  }
  if (env("REDIS_MODE")) out.mode = env("REDIS_MODE").toLowerCase();
  if (env("REDIS_SENTINEL_ADDRS")) {
    out.sentinel_addrs = env("REDIS_SENTINEL_ADDRS").split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (env("REDIS_MASTER_NAME")) out.master_name = env("REDIS_MASTER_NAME").trim();
  if (env("REDIS_CLUSTER_ADDRS")) {
    out.cluster_addrs = env("REDIS_CLUSTER_ADDRS").split(",").map((s) => s.trim()).filter(Boolean);
  } else if ((out.mode || env("REDIS_MODE")) === "cluster" && (out.address || env("REDIS_ADDRESS"))) {
    const a = out.address || env("REDIS_ADDRESS");
    out.cluster_addrs = a.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

export function normalizeErrorLogLevel(level) {
  const s = String(level || "").toLowerCase().trim();
  const normalized = s === "warn" ? "warning" : s;
  return ["error", "warning", "info", "debug"].includes(normalized) ? normalized : "warning";
}

export function normalizeSources(sources) {
  const result = [];
  const seen = new Set();
  for (const source of sources) {
    const url = String(source?.url || "").trim();
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    const name = String(source?.name || "").trim() || url;
    result.push({ name, url });
  }
  return result;
}

export function normalizeDomains(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const domain = String(value || "").trim().toLowerCase();
    if (!domain || seen.has(domain)) {
      continue;
    }
    seen.add(domain);
    result.push(domain);
  }
  return result;
}

const HHMM_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function validateScheduledPause(input) {
  if (input === null || input === undefined) return null;
  const enabled = input.enabled === true;
  if (!enabled) return null;
  const start = String(input.start || "").trim();
  const end = String(input.end || "").trim();
  if (!HHMM_PATTERN.test(start)) {
    return "scheduled_pause.start must be HH:MM (e.g. 09:00)";
  }
  if (!HHMM_PATTERN.test(end)) {
    return "scheduled_pause.end must be HH:MM (e.g. 17:00)";
  }
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  if (sh > eh || (sh === eh && sm >= em)) {
    return "scheduled_pause.start must be before end (overnight windows like 22:00–06:00 are not supported)";
  }
  const days = Array.isArray(input.days) ? input.days : [];
  for (const d of days) {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      return "scheduled_pause.days must be 0-6 (0=Sun, 6=Sat)";
    }
  }
  return null;
}

export function normalizeScheduledPause(input) {
  if (input === null || input === undefined) return null;
  const enabled = input.enabled === true;
  if (!enabled) {
    return { enabled: false, start: "09:00", end: "17:00", days: [] };
  }
  const start = String(input.start || "09:00").trim();
  const end = String(input.end || "17:00").trim();
  const days = Array.isArray(input.days)
    ? [...new Set(input.days.map((d) => Number(d)).filter((n) => n >= 0 && n <= 6))]
    : [];
  return { enabled: true, start, end, days };
}

export function validateFamilyTime(input) {
  if (input === null || input === undefined) return null;
  const enabled = input.enabled === true;
  if (!enabled) return null;
  const start = String(input.start || "").trim();
  const end = String(input.end || "").trim();
  if (!HHMM_PATTERN.test(start)) {
    return "family_time.start must be HH:MM (e.g. 17:00)";
  }
  if (!HHMM_PATTERN.test(end)) {
    return "family_time.end must be HH:MM (e.g. 20:00)";
  }
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  if (sh > eh || (sh === eh && sm >= em)) {
    return "family_time.start must be before end (overnight windows like 22:00–06:00 are not supported)";
  }
  const days = Array.isArray(input.days) ? input.days : [];
  for (const d of days) {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      return "family_time.days must be 0-6 (0=Sun, 6=Sat)";
    }
  }
  const services = Array.isArray(input.services) ? input.services : [];
  if (services.length === 0 && (!Array.isArray(input.domains) || input.domains.length === 0)) {
    return "family_time requires at least one service or domain to block";
  }
  return null;
}

export function normalizeFamilyTime(input) {
  if (input === null || input === undefined) return null;
  const enabled = input.enabled === true;
  if (!enabled) {
    return { enabled: false, start: "17:00", end: "20:00", days: [], services: [], domains: [] };
  }
  const start = String(input.start || "17:00").trim();
  const end = String(input.end || "20:00").trim();
  const days = Array.isArray(input.days)
    ? [...new Set(input.days.map((d) => Number(d)).filter((n) => n >= 0 && n <= 6))]
    : [];
  const services = Array.isArray(input.services)
    ? [...new Set(input.services.map((s) => String(s).trim().toLowerCase()).filter(Boolean))]
    : [];
  const domains = Array.isArray(input.domains)
    ? [...new Set(input.domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean))]
    : [];
  return { enabled: true, start, end, days, services, domains };
}

function isValidTimezone(tz) {
  if (!tz || !String(tz).trim()) return true;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: String(tz).trim() });
    return true;
  } catch {
    return false;
  }
}

export function validateUsageStatsSchedule(input) {
  if (input === null || input === undefined) return null;
  const enabled = input.enabled === true;
  if (!enabled) return null;
  const time = String(input.schedule_time || "").trim();
  if (!HHMM_PATTERN.test(time)) {
    return "usage_stats_webhook.schedule_time must be HH:MM (e.g. 08:00)";
  }
  const tz = String(input.schedule_timezone || "").trim();
  if (tz && !isValidTimezone(tz)) {
    return "usage_stats_webhook.schedule_timezone must be a valid IANA timezone (e.g. America/New_York)";
  }
  const url = String(input.url || "").trim();
  if (!url) {
    return "usage_stats_webhook.url is required when enabled";
  }
  try {
    new URL(url);
  } catch {
    return "usage_stats_webhook.url must be a valid URL";
  }
  return null;
}

export function normalizeUsageStatsSchedule(input) {
  if (input === null || input === undefined) return null;
  const enabled = input.enabled === true;
  if (!enabled) {
    return { enabled: false, url: "", schedule_time: "08:00", schedule_timezone: "", target: "default" };
  }
  const url = String(input.url || "").trim();
  const scheduleTime = String(input.schedule_time || "08:00").trim();
  const scheduleTimezone = String(input.schedule_timezone || "").trim();
  const target = String(input.target || "default").trim().toLowerCase();
  const validTarget = target === "discord" ? "discord" : "default";
  return {
    enabled: true,
    url,
    schedule_time: HHMM_PATTERN.test(scheduleTime) ? scheduleTime : "08:00",
    schedule_timezone: scheduleTimezone,
    target: validTarget,
  };
}

export function validateHealthCheck(input) {
  if (input === null || input === undefined) return null;
  if (typeof input.enabled !== "boolean" && input.enabled !== undefined) {
    return "health_check.enabled must be a boolean";
  }
  if (typeof input.fail_on_any !== "boolean" && input.fail_on_any !== undefined) {
    return "health_check.fail_on_any must be a boolean";
  }
  return null;
}

export function normalizeHealthCheck(input) {
  if (input === null || input === undefined) return null;
  const enabled = input.enabled === true;
  const failOnAny = input.fail_on_any !== false;
  return { enabled, fail_on_any: failOnAny };
}

export function normalizeLocalRecords(records) {
  const result = [];
  const seen = new Set();
  for (const rec of records) {
    const name = String(rec?.name || "").trim().toLowerCase();
    const type = String(rec?.type || "A").trim().toUpperCase();
    const value = String(rec?.value || "").trim();
    if (!name || !value) {
      continue;
    }
    const key = `${name}:${type}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ name, type, value });
  }
  return result;
}

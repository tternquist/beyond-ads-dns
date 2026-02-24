/**
 * Shared helper utilities used across server modules.
 */

export function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return ["true", "1", "yes", "y"].includes(String(value).toLowerCase());
}

export function formatBytes(bytes) {
  if (bytes == null || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function toNumber(value) {
  const num = Number(value);
  if (Number.isNaN(num)) {
    return 0;
  }
  return num;
}

export function clampNumber(value, fallback, min, max) {
  const num = Number(value);
  if (Number.isNaN(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
}

/**
 * Returns the start of a time window as a string for ClickHouse DateTime.
 * Uses the server's local time to avoid clock skew between web server and ClickHouse.
 * Format: YYYY-MM-DD HH:mm:ss (matches Go's time.Format and ClickHouse DateTime parsing).
 * @param {number} windowMinutes - Window size in minutes
 * @returns {string} Window start timestamp
 */
export function getWindowStartForClickHouse(windowMinutes) {
  const start = new Date(Date.now() - windowMinutes * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const y = start.getFullYear();
  const m = pad(start.getMonth() + 1);
  const d = pad(start.getDate());
  const h = pad(start.getHours());
  const min = pad(start.getMinutes());
  const s = pad(start.getSeconds());
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

/**
 * Validates ClickHouse identifier (database or table name) to prevent SQL injection.
 * Allows alphanumeric and underscore only; max 256 chars.
 * @param {string} value - Identifier to validate
 * @param {string} fallback - Default if invalid
 * @returns {string} Valid identifier
 */
export function validateClickHouseIdentifier(value, fallback) {
  const s = String(value || "").trim();
  if (!s || s.length > 256) return fallback;
  if (!/^[a-zA-Z0-9_]+$/.test(s)) return fallback;
  return s;
}

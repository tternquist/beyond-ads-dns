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

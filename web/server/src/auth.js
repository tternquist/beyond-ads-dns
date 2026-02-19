import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";

let storedHash = null;

function getAdminPasswordFile() {
  return process.env.ADMIN_PASSWORD_FILE || "/app/config-overrides/.admin-password";
}

function getUiPassword() {
  return process.env.UI_PASSWORD || process.env.ADMIN_PASSWORD;
}

function getUiUsername() {
  return (process.env.UI_USERNAME || process.env.ADMIN_USERNAME || "admin").trim();
}

function loadStoredHash() {
  if (storedHash) return storedHash;
  const uiPassword = getUiPassword();
  if (uiPassword) {
    storedHash = bcrypt.hashSync(uiPassword, 10);
    return storedHash;
  }
  try {
    const fullPath = path.isAbsolute(getAdminPasswordFile())
      ? getAdminPasswordFile()
      : path.join(process.cwd(), getAdminPasswordFile());
    if (fs.existsSync(fullPath)) {
      const data = fs.readFileSync(fullPath, "utf8");
      storedHash = data.trim();
      return storedHash;
    }
  } catch (_) {
    // ignore
  }
  return null;
}

export function isAuthEnabled() {
  return loadStoredHash() != null;
}

export function getAdminUsername() {
  return getUiUsername();
}

export function verifyPassword(username, password) {
  const hash = loadStoredHash();
  if (!hash) return false;
  if (username !== getUiUsername()) return false;
  return bcrypt.compareSync(password, hash);
}

/**
 * Whether the password can be changed from the UI.
 * Returns false when password is set via UI_PASSWORD or ADMIN_PASSWORD env.
 */
export function canEditPassword() {
  return !getUiPassword();
}

/**
 * Set admin password by writing bcrypt hash to the password file.
 * Only valid when canEditPassword() is true (not using env).
 * @param {string} newPassword - Plain text password
 * @returns {{ ok: boolean, error?: string }}
 */
export function setAdminPassword(newPassword) {
  if (!canEditPassword()) {
    return { ok: false, error: "Password is configured via environment variable and cannot be changed from the UI" };
  }
  const pwd = String(newPassword || "").trim();
  if (pwd.length < 6) {
    return { ok: false, error: "Password must be at least 6 characters" };
  }
  try {
    const hash = bcrypt.hashSync(pwd, 10);
    const fullPath = path.isAbsolute(getAdminPasswordFile())
      ? getAdminPasswordFile()
      : path.join(process.cwd(), getAdminPasswordFile());
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }
    fs.writeFileSync(fullPath, hash, { mode: 0o600 });
    storedHash = hash;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || "Failed to write password file" };
  }
}

/** Reset cached hash (for testing). */
export function _resetStoredHash() {
  storedHash = null;
}

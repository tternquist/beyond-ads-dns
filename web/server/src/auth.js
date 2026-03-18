import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";

let storedHash = null;
// Set to true once the plaintext env password has been hashed and the env
// vars cleared. Used by canEditPassword() to preserve the "env-based" state
// even after the env vars are removed from process.env.
let _envPasswordWasSet = false;

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
    // Clear plaintext from process.env after hashing to reduce exposure via
    // /proc/<pid>/environ if an attacker can read process memory.
    _envPasswordWasSet = true;
    delete process.env.UI_PASSWORD;
    delete process.env.ADMIN_PASSWORD;
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
  // _envPasswordWasSet is true once loadStoredHash() has hashed an env-based
  // password and cleared the env vars; fall back to live env check before that.
  if (_envPasswordWasSet) return false;
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
    const code = err.code || "";
    if (code === "EACCES" || code === "EROFS" || code === "EPERM") {
      return {
        ok: false,
        error:
          "Password could not be written (permission denied or read-only filesystem). Use `beyond-ads-dns set-admin-password` or set UI_PASSWORD/ADMIN_PASSWORD environment variable.",
      };
    }
    return { ok: false, error: err.message || "Failed to write password file" };
  }
}

/** Reset cached hash (for testing). */
export function _resetStoredHash() {
  storedHash = null;
  _envPasswordWasSet = false;
}

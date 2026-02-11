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

/** Reset cached hash (for testing). */
export function _resetStoredHash() {
  storedHash = null;
}

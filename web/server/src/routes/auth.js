import rateLimit from "express-rate-limit";
import { isAuthEnabled, verifyPassword, getAdminUsername, canEditPassword, setAdminPassword } from "../auth.js";

export function registerAuthRoutes(app) {
  app.get("/api/auth/status", (_req, res) => {
    const authEnabled = isAuthEnabled();
    const editable = canEditPassword();
    res.json({
      authenticated: Boolean(_req.session?.authenticated),
      authEnabled,
      username: authEnabled ? getAdminUsername() : null,
      passwordEditable: editable,
      canSetInitialPassword: !authEnabled && editable,
    });
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many login attempts, please try again later" },
  });

  app.post("/api/auth/login", loginLimiter, (req, res) => {
    if (!isAuthEnabled()) {
      res.json({ ok: true, authenticated: true });
      return;
    }
    const { username, password } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: "Username and password required" });
      return;
    }
    if (!verifyPassword(String(username).trim(), String(password))) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }
    req.session.regenerate((err) => {
      if (err) {
        res.status(500).json({ error: "Session error" });
        return;
      }
      req.session.authenticated = true;
      req.session.save((saveErr) => {
        if (saveErr) {
          res.status(500).json({ error: "Session error" });
          return;
        }
        res.json({ ok: true, authenticated: true });
      });
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        res.status(500).json({ error: "Logout failed" });
        return;
      }
      res.clearCookie("beyond_ads.sid");
      res.json({ ok: true });
    });
  });

  app.post("/api/auth/set-password", (req, res) => {
    const authEnabled = isAuthEnabled();
    if (authEnabled && !req.session?.authenticated) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const { currentPassword, newPassword } = req.body || {};
    const newPwd = String(newPassword ?? "").trim();
    if (!newPwd) {
      res.status(400).json({ error: "New password is required" });
      return;
    }
    if (authEnabled) {
      if (!currentPassword) {
        res.status(400).json({ error: "Current password is required" });
        return;
      }
      if (!verifyPassword(getAdminUsername(), String(currentPassword))) {
        res.status(401).json({ error: "Current password is incorrect" });
        return;
      }
    }
    const result = setAdminPassword(newPwd);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true, message: "Password updated successfully" });
  });
}

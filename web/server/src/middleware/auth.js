/**
 * Auth middleware for protecting API routes.
 */
import { isAuthEnabled } from "../auth.js";

/**
 * Middleware that requires authentication for protected routes.
 * Allows: login POST, status GET, health GET without auth.
 */
export function authMiddleware(req, res, next) {
  if (!isAuthEnabled()) return next();
  if (req.session?.authenticated) return next();
  const p = req.path;
  if ((p === "/api/auth/login" || p === "/auth/login") && req.method === "POST") return next();
  if ((p === "/api/auth/status" || p === "/auth/status") && req.method === "GET") return next();
  if ((p === "/api/health" || p === "/health") && req.method === "GET") return next();
  res.status(401).json({ error: "Unauthorized", requiresAuth: true });
}

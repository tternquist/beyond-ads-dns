import { useState } from "react";
import { getStoredTheme, setTheme } from "./theme.js";
import AppLogo from "./components/AppLogo.jsx";

function getAuthErrorMessage(res, data) {
  if (res.status === 401) {
    return data?.error || "Invalid username or password. Please try again.";
  }
  if (res.status === 429) {
    return "Too many login attempts. Please wait a moment before trying again.";
  }
  if (res.status >= 500) {
    return "Server error. Please try again later.";
  }
  return data?.error || "Login failed. Please try again.";
}

export default function LoginPage({ onLogin, authStatus }) {
  const [themePreference, setThemePreference] = useState(() => getStoredTheme());
  const [username, setUsername] = useState(authStatus?.username || "admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(getAuthErrorMessage(res, data));
        return;
      }
      onLogin();
    } catch (err) {
      setError(err.message || "Connection failed. Please check your network and try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <div className="login-theme-switcher">
        <label className="select" title="Theme">
          <select
            value={themePreference}
            onChange={(e) => {
              const v = e.target.value;
              setTheme(v);
              setThemePreference(v);
            }}
            aria-label="Theme"
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </label>
      </div>
      <div className="login-container">
        <div className="login-logo">
          <AppLogo height={48} showText />
        </div>
        <p className="login-subtitle">Sign in to continue</p>
        <form className="login-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="field-label" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              className="input"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={!!authStatus?.username}
            />
          </div>
          <div className="form-group">
            <label className="field-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              disabled={loading}
            />
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button
            type="submit"
            className="button primary login-button"
            disabled={loading}
            aria-busy={loading}
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import App from "./App.jsx";
import LoginPage from "./LoginPage.jsx";

export default function AuthGate() {
  const [authStatus, setAuthStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  const checkAuth = async () => {
    try {
      const res = await fetch("/api/auth/status", { credentials: "include" });
      const data = await res.json();
      setAuthStatus(data);
    } catch {
      setAuthStatus({ authenticated: false, authEnabled: false });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkAuth();
  }, []);

  if (loading) {
    return (
      <div className="page">
        <div className="login-container">
          <p className="muted">Loading...</p>
        </div>
      </div>
    );
  }

  if (authStatus?.authEnabled && !authStatus?.authenticated) {
    return <LoginPage onLogin={checkAuth} authStatus={authStatus} />;
  }

  return <App />;
}

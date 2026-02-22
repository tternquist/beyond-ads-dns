import { useEffect, useState } from "react";
import { useLocation, useNavigate, NavLink } from "react-router-dom";
import { getStoredTheme, setTheme } from "./theme.js";
import {
  REFRESH_OPTIONS,
  REFRESH_MS,
  TABS,
  SIDEBAR_COLLAPSED_KEY,
} from "./utils/constants.js";
import { api } from "./utils/apiClient.js";
import { setupVisibilityAwarePolling } from "./utils/visibilityAwarePolling.js";
import { AppProvider } from "./context/AppContext.jsx";
import { TabIcon } from "./components/SidebarIcons.jsx";
import AppLogo from "./components/AppLogo.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import OverviewPage from "./pages/OverviewPage.jsx";
import QueriesPage from "./pages/QueriesPage.jsx";
import ReplicaStatsPage from "./pages/ReplicaStatsPage.jsx";
import BlocklistsPage from "./pages/BlocklistsPage.jsx";
import ClientsPage from "./pages/ClientsPage.jsx";
import DnsPage from "./pages/DnsPage.jsx";
import SyncPage from "./pages/SyncPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import IntegrationsPage from "./pages/IntegrationsPage.jsx";
import ErrorViewerPage from "./pages/ErrorViewerPage.jsx";
import ConfigPage from "./pages/ConfigPage.jsx";
import { useSyncStatus } from "./hooks/useSyncStatus.js";
import { useOverviewState } from "./hooks/useOverviewState.js";
import { useReplicaStatsState } from "./hooks/useReplicaStatsState.js";

function loadSidebarCollapsed() {
  try {
    const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (stored === null) return true;
    return JSON.parse(stored);
  } catch {
    return true;
  }
}

function formatUptime(ms) {
  if (ms < 0) return "-";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours % 24 > 0) parts.push(`${hours % 24}h`);
  if (minutes % 60 > 0) parts.push(`${minutes % 60}m`);
  if (seconds % 60 > 0 && hours === 0) parts.push(`${seconds % 60}s`);
  return parts.length ? parts.join(" ") : "0s";
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const pathSegment = location.pathname.replace(/^\//, "").split("/")[0] || "";
  const rawTab = (pathSegment.trim() || "overview").toLowerCase();
  const activeTab = rawTab === "system-settings" ? "system" : rawTab;

  const [themePreference, setThemePreference] = useState(() => getStoredTheme());
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(REFRESH_MS);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed);
  const [hostname, setHostname] = useState("");
  const [appInfo, setAppInfo] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [authEnabled, setAuthEnabled] = useState(false);

  const { syncStatus, syncError, refresh: refreshSyncStatus } = useSyncStatus();
  const overview = useOverviewState(refreshIntervalMs);
  const replicaStats = useReplicaStatsState(activeTab, syncStatus);

  const isReplica = syncStatus?.role === "replica" && syncStatus?.enabled;
  const showRefresh = activeTab === "overview" || activeTab === "queries" || activeTab === "replica-stats";
  const updatedAt = activeTab === "replica-stats" ? replicaStats.instanceStatsUpdatedAt : overview.updatedAt;

  useEffect(() => {
    if (rawTab === "system-settings") {
      navigate("/system", { replace: true });
    }
  }, [rawTab, navigate]);

  useEffect(() => {
    const controller = new AbortController();
    api.get("/api/auth/status", { signal: controller.signal })
      .then((d) => {
        setAuthEnabled(d.authEnabled ?? false);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await api.get("/api/info", { signal: controller.signal });
        if (!isMounted) return;
        setHostname(data.hostname || "");
        setAppInfo(data);
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (!isMounted) return;
      }
    };
    const cleanupPolling = setupVisibilityAwarePolling(load, 60000);
    return () => {
      isMounted = false;
      controller.abort();
      cleanupPolling();
    };
  }, []);

  useEffect(() => {
    if (!appInfo?.startTimestamp) return;
    const cleanupPolling = setupVisibilityAwarePolling(() => setNow(Date.now()), 1000);
    return cleanupPolling;
  }, [appInfo?.startTimestamp]);

  useEffect(() => {
    document.title = hostname ? `Beyond Ads DNS — ${hostname}` : "Beyond Ads DNS";
  }, [hostname]);

  const logout = async () => {
    try {
      await api.post("/api/auth/logout");
    } finally {
      window.location.reload();
    }
  };

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const collapseSidebar = () => {
    if (!sidebarCollapsed) {
      setSidebarCollapsed(true);
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "true");
      } catch {}
    }
  };

  const appContextValue = {
    themePreference,
    setThemePreference,
    refreshIntervalMs,
    setRefreshIntervalMs,
    syncStatus,
    syncError,
    refreshSyncStatus,
    isReplica,
  };

  return (
    <AppProvider value={appContextValue}>
      <div className="app-layout">
        <div
          className={`app-sidebar-backdrop ${sidebarCollapsed ? "hidden" : ""}`}
          aria-hidden="true"
          onClick={toggleSidebar}
        />
        <aside className={`app-sidebar ${sidebarCollapsed ? "app-sidebar--collapsed" : ""}`}>
          <button
            type="button"
            className="app-sidebar-toggle"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!sidebarCollapsed}
          >
            <TabIcon name={sidebarCollapsed ? "chevronRight" : "chevronLeft"} />
          </button>
          <div className="app-sidebar-logo">
            <AppLogo compact={sidebarCollapsed} height={28} showText={!sidebarCollapsed} />
          </div>
          <nav className="app-sidebar-nav" role="navigation" aria-label="Main">
            {["monitor", "configure", "tools", "admin"].map((group) => (
              <div key={group}>
                <div className="app-sidebar-group">
                  {group === "monitor" ? "Monitor" : group === "configure" ? "Configure" : group === "tools" ? "Tools" : "Admin"}
                </div>
                {TABS.filter((t) => t.group === group && (!t.primaryOnly || (syncStatus?.enabled && syncStatus?.role === "primary"))).map((tab) => (
                  <NavLink
                    key={tab.id}
                    to={tab.id === "overview" ? "/" : `/${tab.id}`}
                    className={({ isActive }) => (isActive ? "active" : "")}
                    aria-current={activeTab === tab.id ? "page" : undefined}
                    title={tab.label}
                    onClick={collapseSidebar}
                  >
                    <span className="app-sidebar-icon">
                      <TabIcon name={tab.icon} />
                    </span>
                    <span className="app-sidebar-label">{tab.label}</span>
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <main className="app-main">
          <div className="page">
            {(hostname || appInfo) && (
              <div className="env-banner" aria-label="Environment">
                {hostname && <span className="env-banner-name">{hostname}</span>}
                {appInfo && (
                  <span className="env-banner-build">
                    {hostname && " · "}
                    {appInfo.releaseTag && <span>{appInfo.releaseTag}</span>}
                    {appInfo.releaseTag && " · "}
                    <span>Uptime {appInfo.startTimestamp ? formatUptime(now - new Date(appInfo.startTimestamp).getTime()) : "-"}</span>
                    {appInfo.load1 != null && (
                      <>
                        {" · "}
                        <span>Load {appInfo.load1}</span>
                      </>
                    )}
                    {" · "}
                    <a href="https://github.com/tternquist/beyond-ads-dns/wiki" target="_blank" rel="noopener noreferrer" className="env-banner-link">
                      Wiki ↗
                    </a>
                  </span>
                )}
              </div>
            )}
            <header className={`header ${showRefresh ? "" : "app-header-compact"}`}>
              <div>
                <h1 className="header-title">
                  <AppLogo height={28} showText />
                </h1>
              </div>
              <div className="header-actions">
                {showRefresh && (
                  <div className="refresh">
                    <label className="select">
                      Refresh
                      <select
                        value={refreshIntervalMs}
                        onChange={(e) => setRefreshIntervalMs(Number(e.target.value))}
                        aria-label="Refresh interval"
                      >
                        {REFRESH_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <span className="updated">
                      {updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "Loading"}
                    </span>
                  </div>
                )}
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
                {authEnabled && (
                  <button type="button" className="button logout-button" onClick={logout}>
                    Log out
                  </button>
                )}
              </div>
            </header>

            {(activeTab === "overview" || activeTab === "queries") && overview.error && <div className="error">{overview.error}</div>}

            <ErrorBoundary>
              {activeTab === "overview" && <OverviewPage />}
              {activeTab === "queries" && <QueriesPage />}
              {activeTab === "replica-stats" && <ReplicaStatsPage />}
              {activeTab === "blocklists" && <BlocklistsPage />}
              {activeTab === "clients" && <ClientsPage />}
              {activeTab === "dns" && <DnsPage />}
              {activeTab === "sync" && <SyncPage />}
              {activeTab === "system" && <SettingsPage />}
              {activeTab === "integrations" && <IntegrationsPage />}
              {activeTab === "error-viewer" && <ErrorViewerPage />}
              {activeTab === "config" && <ConfigPage />}
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </AppProvider>
  );
}

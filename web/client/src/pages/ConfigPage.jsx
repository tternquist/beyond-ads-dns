import ConfigViewer from "../components/ConfigViewer.jsx";
import { useConfigState } from "../hooks/useConfigState.js";

export default function ConfigPage() {
  const config = useConfigState();
  const {
    activeConfig,
    configError,
    importStatus,
    importError,
    configExportExcludeInstanceDetails,
    setConfigExportExcludeInstanceDetails,
    restartLoading,
    restartError,
    exportConfig,
    importConfig,
    confirmRestartService,
  } = config;

  return (
    <section className="section">
      <div className="section-header">
        <h2>Active Configuration</h2>
        <div className="actions">
          <label className="button">
            Import
            <input
              type="file"
              accept=".yaml,.yml"
              onChange={importConfig}
              style={{ display: "none" }}
            />
          </label>
          <label className="select" title="Export mode: portable removes hostname and replica config for sharing across instances">
            <select
              value={configExportExcludeInstanceDetails ? "portable" : "exact"}
              onChange={(e) => setConfigExportExcludeInstanceDetails(e.target.value === "portable")}
              aria-label="Export mode"
            >
              <option value="portable">Export: Remove instance details</option>
              <option value="exact">Export: Exact replica</option>
            </select>
          </label>
          <button className="button primary" onClick={exportConfig}>
            Export
          </button>
          <button
            className="button"
            onClick={confirmRestartService}
            disabled={restartLoading}
          >
            {restartLoading ? "Restarting..." : "Restart service"}
          </button>
        </div>
      </div>
      {configError && <div className="error">{configError}</div>}
      {importStatus && <p className="status">{importStatus}</p>}
      {importError && <div className="error">{importError}</div>}
      {restartError && <div className="error">{restartError}</div>}
      <ConfigViewer config={activeConfig} />
    </section>
  );
}

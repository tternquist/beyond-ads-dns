import { SUGGESTED_BLOCKLISTS, BLOCKABLE_SERVICES } from "../utils/constants.js";
import { isServiceBlockedByDenylist } from "../utils/blocklist.js";
import CollapsibleSection from "../components/CollapsibleSection.jsx";
import DomainEditor from "../components/DomainEditor.jsx";
import { SkeletonCard } from "../components/Skeleton.jsx";

export default function ClientsPage({
  isReplica,
  systemConfig,
  systemConfigLoading,
  systemConfigStatus,
  systemConfigError,
  updateSystemConfig,
  saveSystemConfig,
  discoveredClients,
  setDiscoveredClients,
  discoverClientsLoading,
  discoverClientsError,
  onDiscoverClients,
  toggleServiceBlockingForGroup,
}) {
  if (!systemConfig) {
    return (
      <section className="section">
        <h2>Clients & Groups</h2>
        <div className="grid">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </section>
    );
  }

  return (
    <section className="section">
      <div className="section-header">
        <h2>Clients & Groups</h2>
        {isReplica && <span className="badge muted">Groups synced from primary</span>}
        <div className="actions">
          <button
            className="button primary"
            onClick={() => saveSystemConfig({ skipRestartPrompt: true })}
            disabled={systemConfigLoading || !systemConfig}
          >
            {systemConfigLoading ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
      {isReplica && (
        <p className="muted">
          Groups are synced from primary. You can add client IP→name mappings locally for
          per-device analytics on this replica.
        </p>
      )}
      <p className="muted">
        Map client IPs to friendly names and assign them to groups. Used for per-device
        analytics in Queries and for future per-group blocklists (parental controls).
      </p>
      {systemConfigStatus && <p className="status">{systemConfigStatus}</p>}
      {systemConfigError && <div className="error">{systemConfigError}</div>}

      <div className="form-group">
        <label className="field-label">
          <input
            type="checkbox"
            checked={systemConfig.client_identification?.enabled === true}
            onChange={(e) =>
              updateSystemConfig("client_identification", "enabled", e.target.checked)
            }
          />
          {" "}Client identification enabled
        </label>
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0, marginBottom: "0.5rem" }}>
          Map client IP addresses to friendly names. Enables &quot;Which device queries
          X?&quot; in query logs. Applies immediately when saved.
        </p>
      </div>

      <h3>Clients</h3>
      <p className="muted" style={{ marginBottom: "0.5rem" }}>
        Map client IP addresses to friendly names and assign to a group (e.g. Kids, Adults).
      </p>
      <div className="table-wrapper" style={{ marginBottom: "1rem" }}>
        <table className="table clients-table">
          <thead>
            <tr>
              <th>IP address</th>
              <th>Name</th>
              <th>Group</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(systemConfig.client_identification?.clients || []).map((c, i) => (
              <tr key={i} className="clients-table-row">
                <td data-label="IP address">
                  <input
                    className="input"
                    placeholder="192.168.1.10"
                    value={c.ip || ""}
                    onChange={(e) => {
                      const clients = [...(systemConfig.client_identification?.clients || [])];
                      clients[i] = { ...clients[i], ip: e.target.value };
                      updateSystemConfig("client_identification", "clients", clients);
                    }}
                    style={{ width: "100%", minWidth: "120px" }}
                  />
                </td>
                <td data-label="Name">
                  <input
                    className="input"
                    placeholder="e.g. Kids Tablet"
                    value={c.name || ""}
                    onChange={(e) => {
                      const clients = [...(systemConfig.client_identification?.clients || [])];
                      clients[i] = { ...clients[i], name: e.target.value };
                      updateSystemConfig("client_identification", "clients", clients);
                    }}
                    style={{ width: "100%", minWidth: "120px" }}
                  />
                </td>
                <td data-label="Group">
                  <select
                    className="input"
                    value={c.group_id || ""}
                    onChange={(e) => {
                      const clients = [...(systemConfig.client_identification?.clients || [])];
                      clients[i] = { ...clients[i], group_id: e.target.value || undefined };
                      updateSystemConfig("client_identification", "clients", clients);
                    }}
                    style={{ width: "100%", minWidth: "100px" }}
                  >
                    <option value="">Default</option>
                    {(systemConfig.client_groups || []).map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td data-label="">
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      const clients = (systemConfig.client_identification?.clients || []).filter(
                        (_, j) => j !== i
                      );
                      updateSystemConfig("client_identification", "clients", clients);
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="button"
        onClick={() => {
          const clients = [
            ...(systemConfig.client_identification?.clients || []),
            { ip: "", name: "", group_id: "" },
          ];
          updateSystemConfig("client_identification", "clients", clients);
        }}
      >
        Add client
      </button>

      <CollapsibleSection
        title="Discover clients"
        defaultCollapsed={true}
        storageKey="clients-discovery"
      >
        <p className="muted" style={{ marginTop: 0, marginBottom: "0.5rem" }}>
          Find client IPs from recent DNS queries that aren&apos;t yet in your client list.
          Requires query store (ClickHouse) to be enabled.
        </p>
        <button
          type="button"
          className="button"
          onClick={onDiscoverClients}
          disabled={discoverClientsLoading}
        >
          {discoverClientsLoading ? "Discovering..." : "Discover clients"}
        </button>
        {discoverClientsError && (
          <div className="error" style={{ marginTop: "0.5rem" }}>
            {discoverClientsError}
          </div>
        )}
        {discoveredClients && (
          <div style={{ marginTop: "1rem" }}>
            {discoveredClients.length === 0 ? (
              <p className="muted">
                No new clients found. All recent client IPs are already in your list.
              </p>
            ) : (
              <div className="table-wrapper">
                <table className="table discover-clients-table">
                  <thead>
                    <tr>
                      <th>IP address</th>
                      <th>Queries (last 60 min)</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {discoveredClients.map((d, i) => (
                      <tr key={i} className="discover-clients-table-row">
                        <td data-label="IP address">{d.ip}</td>
                        <td data-label="Queries (last 60 min)">
                          {d.query_count?.toLocaleString() ?? "-"}
                        </td>
                        <td data-label="">
                          <button
                            type="button"
                            className="button"
                            onClick={() => {
                              const clients = [
                                ...(systemConfig.client_identification?.clients || []),
                                { ip: d.ip, name: "", group_id: "" },
                              ];
                              updateSystemConfig("client_identification", "clients", clients);
                              setDiscoveredClients((prev) =>
                                prev?.filter((x) => x.ip !== d.ip) ?? []
                              );
                            }}
                          >
                            Add as client
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </CollapsibleSection>

      <h3 style={{ marginTop: "2rem" }}>Groups</h3>
      <p className="muted" style={{ marginBottom: "0.5rem" }}>
        Create groups for organizing clients. Each group can have its own blocklist (inherit
        global or custom). The &quot;default&quot; group is used when a client has no group
        assigned.
      </p>
      {(systemConfig.client_groups || []).map((g, i) => (
        <CollapsibleSection
          key={g.id}
          title={`${g.name}${g.description ? ` — ${g.description}` : ""}`}
          defaultCollapsed={true}
          storageKey={`clients-group-${g.id}`}
        >
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              flexWrap: "wrap",
              alignItems: "flex-start",
              marginBottom: "0.5rem",
            }}
          >
            <div className="form-group" style={{ flex: "1 1 200px" }}>
              <label className="field-label">Name</label>
              <input
                className="input"
                value={g.name || ""}
                onChange={(e) => {
                  const groups = [...(systemConfig.client_groups || [])];
                  groups[i] = { ...groups[i], name: e.target.value };
                  updateSystemConfig("client_groups", null, groups);
                }}
                placeholder="e.g. Kids"
              />
            </div>
            <div className="form-group" style={{ flex: "1 1 200px" }}>
              <label className="field-label">Description</label>
              <input
                className="input"
                value={g.description || ""}
                onChange={(e) => {
                  const groups = [...(systemConfig.client_groups || [])];
                  groups[i] = { ...groups[i], description: e.target.value };
                  updateSystemConfig("client_groups", null, groups);
                }}
                placeholder="Optional"
              />
            </div>
          </div>
          <div className="form-group" style={{ marginTop: "1rem" }}>
            <label className="field-label">Blocklist</label>
            <p className="muted" style={{ marginTop: 0, marginBottom: 8 }}>
              Use the global blocklist or define a custom one for this group (e.g. stricter
              for Kids).
            </p>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={!(g.blocklist?.inherit_global === false)}
                onChange={(e) => {
                  const groups = [...(systemConfig.client_groups || [])];
                  const bl = groups[i].blocklist || {};
                  groups[i] = {
                    ...groups[i],
                    blocklist: {
                      ...bl,
                      inherit_global: e.target.checked ? true : false,
                    },
                  };
                  updateSystemConfig("client_groups", null, groups);
                }}
              />
              Use global blocklist
            </label>
            {g.blocklist?.inherit_global === false && (
              <div style={{ marginTop: 12 }}>
                <div className="form-group">
                  <label className="field-label">Sources</label>
                  <p className="muted" style={{ marginTop: 0, marginBottom: 8 }}>
                    Add suggested blocklists or your own. Group blocklists apply only to
                    clients in this group.
                  </p>
                  <div className="list">
                    {(g.blocklist?.sources || []).map((source, si) => (
                      <div key={si}>
                        <div className="list-row">
                          <input
                            className="input"
                            placeholder="Name"
                            value={source.name || ""}
                            onChange={(e) => {
                              const groups = [...(systemConfig.client_groups || [])];
                              const sources = [...(groups[i].blocklist?.sources || [])];
                              sources[si] = { ...sources[si], name: e.target.value };
                              groups[i] = {
                                ...groups[i],
                                blocklist: { ...groups[i].blocklist, sources },
                              };
                              updateSystemConfig("client_groups", null, groups);
                            }}
                          />
                          <input
                            className="input"
                            placeholder="URL"
                            value={source.url || ""}
                            onChange={(e) => {
                              const groups = [...(systemConfig.client_groups || [])];
                              const sources = [...(groups[i].blocklist?.sources || [])];
                              sources[si] = { ...sources[si], url: e.target.value };
                              groups[i] = {
                                ...groups[i],
                                blocklist: { ...groups[i].blocklist, sources },
                              };
                              updateSystemConfig("client_groups", null, groups);
                            }}
                          />
                          <button
                            className="icon-button"
                            onClick={() => {
                              const groups = [...(systemConfig.client_groups || [])];
                              const sources = (groups[i].blocklist?.sources || []).filter(
                                (_, j) => j !== si
                              );
                              groups[i] = {
                                ...groups[i],
                                blocklist: { ...groups[i].blocklist, sources },
                              };
                              updateSystemConfig("client_groups", null, groups);
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div
                    className="actions"
                    style={{ marginTop: "0.5rem", gap: "0.5rem", flexWrap: "wrap" }}
                  >
                    <button
                      className="button"
                      onClick={() => {
                        const groups = [...(systemConfig.client_groups || [])];
                        const sources = [
                          ...(groups[i].blocklist?.sources || []),
                          { name: "", url: "" },
                        ];
                        groups[i] = {
                          ...groups[i],
                          blocklist: { ...groups[i].blocklist, sources },
                        };
                        updateSystemConfig("client_groups", null, groups);
                      }}
                    >
                      Add source
                    </button>
                    <select
                      className="input"
                      style={{ maxWidth: "280px" }}
                      value=""
                      onChange={(e) => {
                        const idx = parseInt(e.target.value, 10);
                        if (
                          !Number.isNaN(idx) &&
                          idx >= 0 &&
                          idx < SUGGESTED_BLOCKLISTS.length
                        ) {
                          const suggestion = SUGGESTED_BLOCKLISTS[idx];
                          const groups = [...(systemConfig.client_groups || [])];
                          const sources = [
                            ...(groups[i].blocklist?.sources || []),
                            { name: suggestion.name, url: suggestion.url },
                          ];
                          groups[i] = {
                            ...groups[i],
                            blocklist: { ...groups[i].blocklist, sources },
                          };
                          updateSystemConfig("client_groups", null, groups);
                        }
                        e.target.value = "";
                      }}
                    >
                      <option value="">Add suggested blocklist…</option>
                      <optgroup label="Strict (maximum blocking)">
                        {SUGGESTED_BLOCKLISTS.filter((s) => s.category === "strict").map(
                          (s) => (
                            <option
                              key={s.url}
                              value={SUGGESTED_BLOCKLISTS.indexOf(s)}
                            >
                              {s.name} — {s.description}
                            </option>
                          )
                        )}
                      </optgroup>
                      <optgroup label="Balanced">
                        {SUGGESTED_BLOCKLISTS.filter((s) => s.category === "balanced").map(
                          (s) => (
                            <option
                              key={s.url}
                              value={SUGGESTED_BLOCKLISTS.indexOf(s)}
                            >
                              {s.name} — {s.description}
                            </option>
                          )
                        )}
                      </optgroup>
                      <optgroup label="Minimal (light blocking)">
                        {SUGGESTED_BLOCKLISTS.filter((s) => s.category === "minimal").map(
                          (s) => (
                            <option
                              key={s.url}
                              value={SUGGESTED_BLOCKLISTS.indexOf(s)}
                            >
                              {s.name} — {s.description}
                            </option>
                          )
                        )}
                      </optgroup>
                      <optgroup label="Malware & phishing">
                        {SUGGESTED_BLOCKLISTS.filter((s) => s.category === "malware").map(
                          (s) => (
                            <option
                              key={s.url}
                              value={SUGGESTED_BLOCKLISTS.indexOf(s)}
                            >
                              {s.name} — {s.description}
                            </option>
                          )
                        )}
                      </optgroup>
                    </select>
                  </div>
                </div>
                <div className="grid" style={{ marginTop: 12 }}>
                  <div className="form-group">
                    <label className="field-label">Allowlist</label>
                    <DomainEditor
                      items={g.blocklist?.allowlist || []}
                      onAdd={(value) => {
                        const groups = [...(systemConfig.client_groups || [])];
                        const allowlist = [...(groups[i].blocklist?.allowlist || []), value];
                        groups[i] = {
                          ...groups[i],
                          blocklist: { ...groups[i].blocklist, allowlist },
                        };
                        updateSystemConfig("client_groups", null, groups);
                      }}
                      onRemove={(value) => {
                        const groups = [...(systemConfig.client_groups || [])];
                        const allowlist = (groups[i].blocklist?.allowlist || []).filter(
                          (d) => d !== value
                        );
                        groups[i] = {
                          ...groups[i],
                          blocklist: { ...groups[i].blocklist, allowlist },
                        };
                        updateSystemConfig("client_groups", null, groups);
                      }}
                    />
                  </div>
                  <div className="form-group">
                    <label className="field-label">Manual blocklist</label>
                    <DomainEditor
                      items={g.blocklist?.denylist || []}
                      onAdd={(value) => {
                        const groups = [...(systemConfig.client_groups || [])];
                        const denylist = [...(groups[i].blocklist?.denylist || []), value];
                        groups[i] = {
                          ...groups[i],
                          blocklist: { ...groups[i].blocklist, denylist },
                        };
                        updateSystemConfig("client_groups", null, groups);
                      }}
                      onRemove={(value) => {
                        const groups = [...(systemConfig.client_groups || [])];
                        const denylist = (groups[i].blocklist?.denylist || []).filter(
                          (d) => d !== value
                        );
                        groups[i] = {
                          ...groups[i],
                          blocklist: { ...groups[i].blocklist, denylist },
                        };
                        updateSystemConfig("client_groups", null, groups);
                      }}
                    />
                  </div>
                  <div className="form-group" style={{ marginTop: 12 }}>
                    <label className="field-label">Block by service</label>
                    <p className="muted" style={{ marginTop: 0, marginBottom: 8 }}>
                      Block top consumer services for this group. Adds domains to the manual
                      blocklist above.
                    </p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                      {BLOCKABLE_SERVICES.map((svc) => (
                        <label key={svc.id} className="checkbox" style={{ marginRight: 8 }}>
                          <input
                            type="checkbox"
                            checked={isServiceBlockedByDenylist(
                              svc,
                              g.blocklist?.denylist || []
                            )}
                            onChange={(e) =>
                              toggleServiceBlockingForGroup(i, svc, e.target.checked)
                            }
                          />
                          {svc.name}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="form-group" style={{ marginTop: 12 }}>
                    <label className="field-label">Family time (group)</label>
                    <p className="muted" style={{ marginTop: 0, marginBottom: 8 }}>
                      Block selected services during scheduled hours for this group only.
                    </p>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={g.blocklist?.family_time?.enabled === true}
                        onChange={(e) => {
                          const groups = [...(systemConfig.client_groups || [])];
                          const bl = groups[i].blocklist || {};
                          const ft = bl.family_time || {
                            start: "17:00",
                            end: "20:00",
                            days: [0, 1, 2, 3, 4, 5, 6],
                            services: [],
                          };
                          groups[i] = {
                            ...groups[i],
                            blocklist: {
                              ...bl,
                              family_time: { ...ft, enabled: e.target.checked },
                            },
                          };
                          updateSystemConfig("client_groups", null, groups);
                        }}
                      />
                      Enable family time for this group
                    </label>
                    {g.blocklist?.family_time?.enabled && (
                      <div
                        style={{
                          marginTop: 12,
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 12,
                          alignItems: "flex-start",
                        }}
                      >
                        <div>
                          <label className="field-label" style={{ fontSize: 12 }}>
                            Start
                          </label>
                          <input
                            className="input"
                            type="text"
                            placeholder="17:00"
                            value={g.blocklist?.family_time?.start || "17:00"}
                            onChange={(e) => {
                              const groups = [...(systemConfig.client_groups || [])];
                              const bl = groups[i].blocklist || {};
                              const ft = bl.family_time || {
                                start: "17:00",
                                end: "20:00",
                                days: [],
                                services: [],
                              };
                              groups[i] = {
                                ...groups[i],
                                blocklist: {
                                  ...bl,
                                  family_time: { ...ft, start: e.target.value },
                                },
                              };
                              updateSystemConfig("client_groups", null, groups);
                            }}
                            style={{ width: 70 }}
                          />
                        </div>
                        <div>
                          <label className="field-label" style={{ fontSize: 12 }}>
                            End
                          </label>
                          <input
                            className="input"
                            type="text"
                            placeholder="20:00"
                            value={g.blocklist?.family_time?.end || "20:00"}
                            onChange={(e) => {
                              const groups = [...(systemConfig.client_groups || [])];
                              const bl = groups[i].blocklist || {};
                              const ft = bl.family_time || {
                                start: "17:00",
                                end: "20:00",
                                days: [],
                                services: [],
                              };
                              groups[i] = {
                                ...groups[i],
                                blocklist: {
                                  ...bl,
                                  family_time: { ...ft, end: e.target.value },
                                },
                              };
                              updateSystemConfig("client_groups", null, groups);
                            }}
                            style={{ width: 70 }}
                          />
                        </div>
                        <div style={{ flex: "1 1 100%" }}>
                          <label className="field-label" style={{ fontSize: 12 }}>
                            Services
                          </label>
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: "0.5rem",
                              marginTop: 4,
                            }}
                          >
                            {BLOCKABLE_SERVICES.map((svc) => (
                              <label key={svc.id} className="checkbox" style={{ marginRight: 8 }}>
                                <input
                                  type="checkbox"
                                  checked={(g.blocklist?.family_time?.services || []).includes(
                                    svc.id
                                  )}
                                  onChange={(e) => {
                                    const groups = [...(systemConfig.client_groups || [])];
                                    const bl = groups[i].blocklist || {};
                                    const ft = bl.family_time || {
                                      start: "17:00",
                                      end: "20:00",
                                      days: [0, 1, 2, 3, 4, 5, 6],
                                      services: [],
                                    };
                                    let services = [...(ft.services || [])];
                                    if (e.target.checked) {
                                      services = [...services, svc.id].sort();
                                    } else {
                                      services = services.filter((id) => id !== svc.id);
                                    }
                                    groups[i] = {
                                      ...groups[i],
                                      blocklist: {
                                        ...bl,
                                        family_time: { ...ft, services },
                                      },
                                    };
                                    updateSystemConfig("client_groups", null, groups);
                                  }}
                                />
                                {svc.name}
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="form-group" style={{ marginTop: "1rem" }}>
            <label className="field-label">Safe Search</label>
            <p className="muted" style={{ marginTop: 0, marginBottom: 8 }}>
              Override global safe search for this group. When enabled, forces Google/Bing
              safe search for devices in this group.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <label className="checkbox">
                <input
                  type="radio"
                  name={`safe-search-${g.id}`}
                  checked={
                    g.safe_search === undefined || g.safe_search === null
                  }
                  onChange={() => {
                    const groups = [...(systemConfig.client_groups || [])];
                    const next = { ...groups[i] };
                    delete next.safe_search;
                    groups[i] = next;
                    updateSystemConfig("client_groups", null, groups);
                  }}
                />
                Use global setting
              </label>
              <label className="checkbox">
                <input
                  type="radio"
                  name={`safe-search-${g.id}`}
                  checked={g.safe_search?.enabled === true}
                  onChange={() => {
                    const groups = [...(systemConfig.client_groups || [])];
                    groups[i] = {
                      ...groups[i],
                      safe_search: {
                        enabled: true,
                        google: groups[i].safe_search?.google !== false,
                        bing: groups[i].safe_search?.bing !== false,
                      },
                    };
                    updateSystemConfig("client_groups", null, groups);
                  }}
                />
                Enable for this group
              </label>
              <label className="checkbox">
                <input
                  type="radio"
                  name={`safe-search-${g.id}`}
                  checked={g.safe_search?.enabled === false}
                  onChange={() => {
                    const groups = [...(systemConfig.client_groups || [])];
                    groups[i] = {
                      ...groups[i],
                      safe_search: { enabled: false },
                    };
                    updateSystemConfig("client_groups", null, groups);
                  }}
                />
                Disable for this group
              </label>
            </div>
            {g.safe_search?.enabled === true && (
              <div style={{ marginTop: 12, marginLeft: "1.5rem" }}>
                <label className="checkbox" style={{ display: "block", marginBottom: 4 }}>
                  <input
                    type="checkbox"
                    checked={g.safe_search?.google !== false}
                    onChange={(e) => {
                      const groups = [...(systemConfig.client_groups || [])];
                      groups[i] = {
                        ...groups[i],
                        safe_search: {
                          ...groups[i].safe_search,
                          google: e.target.checked,
                        },
                      };
                      updateSystemConfig("client_groups", null, groups);
                    }}
                  />
                  Google
                </label>
                <label className="checkbox" style={{ display: "block" }}>
                  <input
                    type="checkbox"
                    checked={g.safe_search?.bing !== false}
                    onChange={(e) => {
                      const groups = [...(systemConfig.client_groups || [])];
                      groups[i] = {
                        ...groups[i],
                        safe_search: {
                          ...groups[i].safe_search,
                          bing: e.target.checked,
                        },
                      };
                      updateSystemConfig("client_groups", null, groups);
                    }}
                  />
                  Bing
                </label>
              </div>
            )}
          </div>
          {g.id !== "default" && (
            <button
              type="button"
              className="button"
              onClick={() => {
                const groups = (systemConfig.client_groups || []).filter((_, j) => j !== i);
                updateSystemConfig("client_groups", null, groups);
              }}
            >
              Remove group
            </button>
          )}
        </CollapsibleSection>
      ))}
      <button
        type="button"
        className="button"
        onClick={() => {
          const groups = systemConfig.client_groups || [];
          const id = `group-${Date.now()}`;
          updateSystemConfig("client_groups", null, [
            ...groups,
            { id, name: "New group", description: "" },
          ]);
        }}
      >
        Add group
      </button>
    </section>
  );
}

import {
  RESOLVER_STRATEGY_OPTIONS,
  SUGGESTED_UPSTREAM_RESOLVERS,
} from "../utils/constants.js";
import { getRowErrorText } from "../utils/validation.js";
import { useDnsState } from "../hooks/useDnsState.js";
import { useAppContext } from "../context/AppContext.jsx";
import { SkeletonSection } from "../components/Skeleton.jsx";

export default function DnsPage() {
  const { isReplica } = useAppContext();
  const dns = useDnsState();
  const {
    dnsInitialLoading,
    upstreams,
    resolverStrategy,
    setResolverStrategy,
    upstreamTimeout,
    setUpstreamTimeout,
    upstreamBackoff,
    setUpstreamBackoff,
    upstreamsError,
    upstreamsStatus,
    upstreamsLoading,
    upstreamValidation,
    saveUpstreams,
    confirmApplyUpstreams,
    updateUpstream,
    removeUpstream,
    addUpstream,
    addSuggestedUpstream,
    localRecords,
    localRecordsError,
    localRecordsStatus,
    localRecordsLoading,
    localRecordsValidation,
    saveLocalRecords,
    confirmApplyLocalRecords,
    updateLocalRecord,
    removeLocalRecord,
    addLocalRecord,
    responseBlocked,
    setResponseBlocked,
    responseBlockedTtl,
    setResponseBlockedTtl,
    responseError,
    responseStatus,
    responseLoading,
    responseValidation,
    saveResponse,
    confirmApplyResponse,
    safeSearchEnabled,
    setSafeSearchEnabled,
    safeSearchGoogle,
    setSafeSearchGoogle,
    safeSearchBing,
    setSafeSearchBing,
    safeSearchError,
    safeSearchStatus,
    safeSearchLoading,
    saveSafeSearch,
    confirmApplySafeSearch,
  } = dns;

  if (dnsInitialLoading) {
    return (
      <>
        <section className="section">
          <h2>Upstream Resolvers</h2>
          <SkeletonSection />
        </section>
        <section className="section">
          <h2>Local DNS Records</h2>
          <SkeletonSection />
        </section>
        <section className="section">
          <h2>Blocked Response</h2>
          <SkeletonSection />
        </section>
        <section className="section">
          <h2>Safe Search</h2>
          <SkeletonSection />
        </section>
      </>
    );
  }

  return (
    <>
      <section className="section">
        <div className="section-header">
          <h2>Upstream Resolvers</h2>
          {isReplica ? (
            <span className="badge muted">Synced from primary</span>
          ) : (
            <div className="actions">
              <button
                className="button"
                onClick={saveUpstreams}
                disabled={upstreamsLoading || upstreamValidation.hasErrors}
              >
                Save
              </button>
              <button
                className="button primary"
                onClick={confirmApplyUpstreams}
                disabled={upstreamsLoading || upstreamValidation.hasErrors}
              >
                Apply changes
              </button>
            </div>
          )}
        </div>
        {isReplica && (
          <p className="muted">DNS settings are managed by the primary instance.</p>
        )}
        <p className="muted">
          Configure upstream DNS resolvers and how queries are distributed. Changes
          take effect immediately when applied.
        </p>
        {upstreamsStatus && <p className="status">{upstreamsStatus}</p>}
        {upstreamsError && <div className="error">{upstreamsError}</div>}

        <div className="form-group">
          <label className="field-label">Resolver strategy</label>
          <p
            className="muted"
            style={{ fontSize: "0.85rem", marginTop: 0, marginBottom: "0.5rem" }}
          >
            How to distribute queries across upstreams: Failover tries in order and
            uses the next on failure; Load Balance round-robins; Weighted prefers
            faster upstreams by response time.
          </p>
          <select
            className="input"
            value={resolverStrategy}
            onChange={(e) => setResolverStrategy(e.target.value)}
            style={{ maxWidth: "280px" }}
          >
            {RESOLVER_STRATEGY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label} – {opt.desc}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label className="field-label">Upstream timeout</label>
          <p
            className="muted"
            style={{ fontSize: "0.85rem", marginTop: 0, marginBottom: "0.5rem" }}
          >
            How long to wait for upstream DNS responses (e.g. 10s, 30s). Increase if
            seeing &quot;i/o timeout&quot; errors on refresh.
          </p>
          <input
            className="input"
            type="text"
            value={upstreamTimeout}
            onChange={(e) => setUpstreamTimeout(e.target.value)}
            placeholder="10s"
            style={{ maxWidth: "120px" }}
          />
        </div>

        <div className="form-group">
          <label className="field-label">Upstream backoff</label>
          <p
            className="muted"
            style={{ fontSize: "0.85rem", marginTop: 0, marginBottom: "0.5rem" }}
          >
            Duration to skip a failed upstream before retrying (e.g. 30s). Use 0 to
            disable and retry every query.
          </p>
          <input
            className="input"
            type="text"
            value={upstreamBackoff}
            onChange={(e) => setUpstreamBackoff(e.target.value)}
            placeholder="30s"
            style={{ maxWidth: "120px" }}
          />
        </div>

        <div className="form-group">
          <label className="field-label">Upstream servers</label>
          <p
            className="muted"
            style={{ fontSize: "0.85rem", marginTop: 0, marginBottom: "0.5rem" }}
          >
            Add DNS resolvers to use. Use host:port for plain DNS (e.g. 1.1.1.1:53),
            tls://host:853 for DoT, or https://host/dns-query for DoH. Order matters
            for failover strategy.
          </p>
          <div className="list">
            {upstreams.map((u, index) => (
              <div key={index}>
                <div className="list-row">
                  <input
                    className="input"
                    placeholder="Name (e.g. cloudflare)"
                    value={u.name || ""}
                    onChange={(e) => updateUpstream(index, "name", e.target.value)}
                    style={{ minWidth: "100px" }}
                  />
                  <input
                    className={`input ${
                      upstreamValidation.rowErrors[index]?.address ? "input-invalid" : ""
                    }`}
                    placeholder="1.1.1.1:53, tls://host:853, quic://host:853, or https://host/dns-query"
                    value={u.address || ""}
                    onChange={(e) => updateUpstream(index, "address", e.target.value)}
                    style={{ minWidth: "180px" }}
                  />
                  <select
                    className={`input ${
                      upstreamValidation.rowErrors[index]?.protocol ? "input-invalid" : ""
                    }`}
                    value={u.protocol || "udp"}
                    onChange={(e) =>
                      updateUpstream(index, "protocol", e.target.value)
                    }
                    style={{ minWidth: "80px" }}
                  >
                    <option value="udp">UDP</option>
                    <option value="tcp">TCP</option>
                    <option value="tls">DoT</option>
                    <option value="quic">DoQ</option>
                    <option value="https">DoH</option>
                  </select>
                  <button
                    className="icon-button"
                    onClick={() => removeUpstream(index)}
                  >
                    Remove
                  </button>
                </div>
                {getRowErrorText(upstreamValidation.rowErrors[index]) && (
                  <div className="field-error">
                    {getRowErrorText(upstreamValidation.rowErrors[index])}
                  </div>
                )}
              </div>
            ))}
          </div>
          {upstreamValidation.generalErrors.map((message) => (
            <div key={message} className="field-error">
              {message}
            </div>
          ))}
          <div
            className="actions"
            style={{ marginTop: "0.5rem", gap: "0.5rem", flexWrap: "wrap" }}
          >
            <button className="button" onClick={addUpstream}>
              Add upstream
            </button>
            <select
              className="input"
              style={{ maxWidth: "220px" }}
              value=""
              onChange={(e) => {
                const idx = parseInt(e.target.value, 10);
                if (
                  !Number.isNaN(idx) &&
                  idx >= 0 &&
                  idx < SUGGESTED_UPSTREAM_RESOLVERS.length
                ) {
                  addSuggestedUpstream({
                    ...SUGGESTED_UPSTREAM_RESOLVERS[idx],
                  });
                }
                e.target.value = "";
              }}
            >
              <option value="">Add suggested resolver…</option>
              <optgroup label="UDP">
                {SUGGESTED_UPSTREAM_RESOLVERS.filter((s) => s.protocol === "udp").map(
                  (s) => (
                    <option
                      key={`udp-${s.name}`}
                      value={SUGGESTED_UPSTREAM_RESOLVERS.indexOf(s)}
                    >
                      {s.name} ({s.address})
                    </option>
                  )
                )}
              </optgroup>
              <optgroup label="TCP">
                {SUGGESTED_UPSTREAM_RESOLVERS.filter((s) => s.protocol === "tcp").map(
                  (s) => (
                    <option
                      key={`tcp-${s.name}`}
                      value={SUGGESTED_UPSTREAM_RESOLVERS.indexOf(s)}
                    >
                      {s.name} ({s.address})
                    </option>
                  )
                )}
              </optgroup>
              <optgroup label="DoT (DNS over TLS)">
                {SUGGESTED_UPSTREAM_RESOLVERS.filter((s) => s.protocol === "tls").map(
                  (s) => (
                    <option
                      key={`tls-${s.name}`}
                      value={SUGGESTED_UPSTREAM_RESOLVERS.indexOf(s)}
                    >
                      {s.name} ({s.address})
                    </option>
                  )
                )}
              </optgroup>
              <optgroup label="DoQ (DNS over QUIC)">
                {SUGGESTED_UPSTREAM_RESOLVERS.filter((s) => s.protocol === "quic").map(
                  (s) => (
                    <option
                      key={`quic-${s.name}`}
                      value={SUGGESTED_UPSTREAM_RESOLVERS.indexOf(s)}
                    >
                      {s.name} ({s.address})
                    </option>
                  )
                )}
              </optgroup>
              <optgroup label="DoH (DNS over HTTPS)">
                {SUGGESTED_UPSTREAM_RESOLVERS.filter(
                  (s) => s.protocol === "https"
                ).map((s) => (
                  <option
                    key={`https-${s.name}`}
                    value={SUGGESTED_UPSTREAM_RESOLVERS.indexOf(s)}
                  >
                    {s.name} ({s.address})
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <h2>Local DNS Records</h2>
          {!isReplica && (
            <div className="actions">
              <button
                className="button"
                onClick={saveLocalRecords}
                disabled={
                  localRecordsLoading || localRecordsValidation.hasErrors
                }
              >
                Save
              </button>
              <button
                className="button primary"
                onClick={confirmApplyLocalRecords}
                disabled={
                  localRecordsLoading || localRecordsValidation.hasErrors
                }
              >
                Apply changes
              </button>
            </div>
          )}
        </div>
        <p className="muted">
          Local records are returned immediately without upstream lookup. They work
          even when the internet is down.
        </p>
        <p
          className="muted"
          style={{ fontSize: "0.85rem", marginTop: "0.25rem", marginBottom: "0.5rem" }}
        >
          Use A for IPv4, AAAA for IPv6, CNAME for aliases, TXT for text records, or
          PTR for reverse lookups. Name can be a hostname (e.g. router.local); value
          is the IP or target.
        </p>
        {localRecordsStatus && <p className="status">{localRecordsStatus}</p>}
        {localRecordsError && <div className="error">{localRecordsError}</div>}

        <div className="form-group">
          <label className="field-label">Records</label>
          <div className="list">
            {localRecords.map((rec, index) => (
              <div key={index}>
                <div className="list-row">
                  <input
                    className={`input ${
                      localRecordsValidation.rowErrors[index]?.name
                        ? "input-invalid"
                        : ""
                    }`}
                    placeholder="Name (e.g. router.local)"
                    value={rec.name || ""}
                    onChange={(e) =>
                      updateLocalRecord(index, "name", e.target.value)
                    }
                  />
                  <select
                    className={`input ${
                      localRecordsValidation.rowErrors[index]?.type
                        ? "input-invalid"
                        : ""
                    }`}
                    value={rec.type || "A"}
                    onChange={(e) =>
                      updateLocalRecord(index, "type", e.target.value)
                    }
                  >
                    <option value="A">A</option>
                    <option value="AAAA">AAAA</option>
                    <option value="CNAME">CNAME</option>
                    <option value="TXT">TXT</option>
                    <option value="PTR">PTR</option>
                  </select>
                  <input
                    className={`input ${
                      localRecordsValidation.rowErrors[index]?.value
                        ? "input-invalid"
                        : ""
                    }`}
                    placeholder="Value (IP or hostname)"
                    value={rec.value || ""}
                    onChange={(e) =>
                      updateLocalRecord(index, "value", e.target.value)
                    }
                  />
                  <button
                    className="icon-button"
                    onClick={() => removeLocalRecord(index)}
                  >
                    Remove
                  </button>
                </div>
                {getRowErrorText(localRecordsValidation.rowErrors[index]) && (
                  <div className="field-error">
                    {getRowErrorText(localRecordsValidation.rowErrors[index])}
                  </div>
                )}
              </div>
            ))}
          </div>
          <button className="button" onClick={addLocalRecord}>
            Add record
          </button>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <h2>Blocked Response</h2>
          {isReplica ? (
            <span className="badge muted">Synced from primary</span>
          ) : (
            <div className="actions">
              <button
                className="button"
                onClick={saveResponse}
                disabled={responseLoading || responseValidation.hasErrors}
              >
                Save
              </button>
              <button
                className="button primary"
                onClick={confirmApplyResponse}
                disabled={responseLoading || responseValidation.hasErrors}
              >
                Apply changes
              </button>
            </div>
          )}
        </div>
        {isReplica && (
          <p className="muted">
            Response config is managed by the primary instance.
          </p>
        )}
        <p className="muted">
          How to respond when a domain is blocked. Use nxdomain (NXDOMAIN) or an IP
          address (e.g. 0.0.0.0) to sinkhole.
        </p>
        <p
          className="muted"
          style={{ fontSize: "0.85rem", marginTop: "0.25rem", marginBottom: "0.5rem" }}
        >
          Response type: nxdomain returns NXDOMAIN (domain does not exist); 0.0.0.0
          or another IP sinkholes to that address. Blocked TTL controls how long
          clients cache the response (e.g. 1h).
        </p>
        {responseStatus && <p className="status">{responseStatus}</p>}
        {responseError && <div className="error">{responseError}</div>}

        <div className="form-group">
          <label className="field-label">Response type</label>
          <input
            className={`input ${
              responseValidation.fieldErrors.blocked ? "input-invalid" : ""
            }`}
            placeholder="nxdomain or 0.0.0.0"
            value={responseBlocked}
            onChange={(e) => setResponseBlocked(e.target.value)}
            style={{ maxWidth: "200px" }}
          />
          {responseValidation.fieldErrors.blocked && (
            <div className="field-error">
              {responseValidation.fieldErrors.blocked}
            </div>
          )}
        </div>
        <div className="form-group">
          <label className="field-label">Blocked TTL</label>
          <input
            className={`input ${
              responseValidation.fieldErrors.blockedTtl ? "input-invalid" : ""
            }`}
            placeholder="1h"
            value={responseBlockedTtl}
            onChange={(e) => setResponseBlockedTtl(e.target.value)}
            style={{ maxWidth: "120px" }}
          />
          {responseValidation.fieldErrors.blockedTtl && (
            <div className="field-error">
              {responseValidation.fieldErrors.blockedTtl}
            </div>
          )}
        </div>

        <div className="form-group" style={{ marginTop: 32 }}>
          <div className="section-header">
            <h2 style={{ margin: 0 }}>Safe Search</h2>
            {isReplica ? (
              <span className="badge muted">Synced from primary</span>
            ) : (
              <div className="actions">
                <button
                  className="button"
                  onClick={saveSafeSearch}
                  disabled={safeSearchLoading}
                >
                  Save
                </button>
                <button
                  className="button primary"
                  onClick={confirmApplySafeSearch}
                  disabled={safeSearchLoading}
                >
                  Apply changes
                </button>
              </div>
            )}
          </div>
          <p className="muted" style={{ marginTop: 8, marginBottom: 12 }}>
            Force safe search for Google and Bing. Redirects search queries to
            family-friendly results.
          </p>
          {safeSearchStatus && <p className="status">{safeSearchStatus}</p>}
          {safeSearchError && <div className="error">{safeSearchError}</div>}
          {!isReplica && (
            <>
              <label
                className="checkbox"
                style={{ display: "block", marginBottom: 12 }}
              >
                <input
                  type="checkbox"
                  checked={safeSearchEnabled}
                  onChange={(e) => setSafeSearchEnabled(e.target.checked)}
                />
                Enable safe search
              </label>
              {safeSearchEnabled && (
                <div style={{ marginLeft: 20 }}>
                  <label
                    className="checkbox"
                    style={{ display: "block", marginBottom: 8 }}
                  >
                    <input
                      type="checkbox"
                      checked={safeSearchGoogle}
                      onChange={(e) => setSafeSearchGoogle(e.target.checked)}
                    />
                    Google (forcesafesearch.google.com)
                  </label>
                  <label className="checkbox" style={{ display: "block" }}>
                    <input
                      type="checkbox"
                      checked={safeSearchBing}
                      onChange={(e) => setSafeSearchBing(e.target.checked)}
                    />
                    Bing (strict.bing.com)
                  </label>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </>
  );
}

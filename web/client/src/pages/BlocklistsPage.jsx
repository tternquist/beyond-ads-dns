import { SUGGESTED_BLOCKLISTS, DAY_LABELS, BLOCKABLE_SERVICES } from "../utils/constants.js";
import { formatNumber } from "../utils/format.js";
import { getRowErrorText } from "../utils/validation.js";
import { isServiceBlockedByDenylist } from "../utils/blocklist.js";
import StatCard from "../components/StatCard.jsx";
import DomainEditor from "../components/DomainEditor.jsx";
import { SkeletonCard } from "../components/Skeleton.jsx";

export default function BlocklistsPage({
  isReplica,
  saveBlocklists,
  confirmApplyBlocklists,
  blocklistLoading,
  blocklistValidation,
  scheduledPauseValidation,
  familyTimeValidation,
  blocklistStatus,
  blocklistError,
  blocklistStatsError,
  blocklistStats,
  refreshInterval,
  setRefreshInterval,
  blocklistSources,
  updateSource,
  removeSource,
  addSource,
  addSuggestedBlocklist,
  addDomain,
  removeDomain,
  allowlist,
  setAllowlist,
  denylist,
  setDenylist,
  toggleServiceBlockingGlobal,
  scheduledPause,
  setScheduledPause,
  toggleScheduledPauseDay,
  familyTime,
  setFamilyTime,
  toggleFamilyTimeService,
  healthCheck,
  setHealthCheck,
  checkBlocklistHealth,
  healthCheckLoading,
  healthCheckResults,
}) {
  return (
    <section className="section">
      <div className="section-header">
        <h2>Blocklist Management</h2>
        {isReplica ? (
          <span className="badge muted">Synced from primary</span>
        ) : (
          <div className="actions">
            <button
              className="button"
              onClick={saveBlocklists}
              disabled={
                blocklistLoading ||
                blocklistValidation.hasErrors ||
                scheduledPauseValidation.hasErrors ||
                familyTimeValidation.hasErrors
              }
            >
              Save
            </button>
            <button
              className="button primary"
              onClick={confirmApplyBlocklists}
              disabled={
                blocklistLoading ||
                blocklistValidation.hasErrors ||
                scheduledPauseValidation.hasErrors ||
                familyTimeValidation.hasErrors
              }
            >
              Apply changes
            </button>
          </div>
        )}
      </div>
      {isReplica && (
        <p className="muted">Blocklists are managed by the primary instance.</p>
      )}
      {blocklistStatus && <p className="status">{blocklistStatus}</p>}
      {blocklistError && <div className="error">{blocklistError}</div>}
      {blocklistStatsError && <div className="error">{blocklistStatsError}</div>}

      <div className="grid">
        {blocklistLoading && !blocklistStats && !blocklistError ? (
          [1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <StatCard
              label="Blocked domains"
              value={
                blocklistStats
                  ? formatNumber(blocklistStats.blocked + blocklistStats.deny)
                  : "-"
              }
              subtext="lists + manual blocks"
            />
            <StatCard
              label="List entries"
              value={formatNumber(blocklistStats?.blocked)}
            />
            <StatCard
              label="Manual blocks"
              value={formatNumber(blocklistStats?.deny)}
            />
            <StatCard
              label="Allowlist"
              value={formatNumber(blocklistStats?.allow)}
            />
          </>
        )}
      </div>

      <div className="form-group">
        <label className="field-label">Refresh interval</label>
        <input
          className={`input ${
            blocklistValidation.fieldErrors.refreshInterval ? "input-invalid" : ""
          }`}
          value={refreshInterval}
          onChange={(event) => setRefreshInterval(event.target.value)}
        />
        {blocklistValidation.fieldErrors.refreshInterval && (
          <div className="field-error">
            {blocklistValidation.fieldErrors.refreshInterval}
          </div>
        )}
      </div>

      <div className="form-group">
        <label className="field-label">Blocklist sources</label>
        <p className="muted" style={{ marginTop: 0, marginBottom: 12 }}>
          Add suggested blocklists below or add your own. Each list blocks ads,
          trackers, and/or malware.
        </p>
        <div className="list">
          {blocklistSources.map((source, index) => (
            <div key={`${source.url}-${index}`}>
              <div className="list-row">
                <input
                  className="input"
                  placeholder="Name"
                  value={source.name || ""}
                  onChange={(event) =>
                    updateSource(index, "name", event.target.value)
                  }
                />
                <input
                  className={`input ${
                    blocklistValidation.rowErrors[index]?.url ? "input-invalid" : ""
                  }`}
                  placeholder="URL"
                  value={source.url || ""}
                  onChange={(event) =>
                    updateSource(index, "url", event.target.value)
                  }
                />
                <button
                  className="icon-button"
                  onClick={() => removeSource(index)}
                >
                  Remove
                </button>
              </div>
              {getRowErrorText(blocklistValidation.rowErrors[index]) && (
                <div className="field-error">
                  {getRowErrorText(blocklistValidation.rowErrors[index])}
                </div>
              )}
            </div>
          ))}
        </div>
        {blocklistValidation.generalErrors.map((message) => (
          <div key={message} className="field-error">
            {message}
          </div>
        ))}
        <div
          className="actions"
          style={{ marginTop: "0.5rem", gap: "0.5rem", flexWrap: "wrap" }}
        >
          <button className="button" onClick={addSource}>
            Add blocklist
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
                addSuggestedBlocklist(SUGGESTED_BLOCKLISTS[idx]);
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

      <div className="grid">
        <div className="form-group">
          <label className="field-label">Allowlist (exceptions)</label>
          <DomainEditor
            items={allowlist}
            onAdd={(value) => addDomain(setAllowlist, value)}
            onRemove={(value) => removeDomain(setAllowlist, value)}
          />
        </div>
        <div className="form-group">
          <label className="field-label">Manual blocklist</label>
          <DomainEditor
            items={denylist}
            onAdd={(value) => addDomain(setDenylist, value)}
            onRemove={(value) => removeDomain(setDenylist, value)}
          />
        </div>
        <div className="form-group">
          <label className="field-label">Block by service</label>
          <p className="muted" style={{ marginTop: 0, marginBottom: 8 }}>
            Block top consumer services globally. Adds domains to the manual
            blocklist above.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {BLOCKABLE_SERVICES.map((svc) => (
              <label key={svc.id} className="checkbox" style={{ marginRight: 8 }}>
                <input
                  type="checkbox"
                  checked={isServiceBlockedByDenylist(svc, denylist)}
                  onChange={(e) =>
                    toggleServiceBlockingGlobal(svc, e.target.checked)
                  }
                  disabled={blocklistLoading}
                />
                {svc.name}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="form-group">
        <label className="field-label">Scheduled pause</label>
        <p className="muted" style={{ marginTop: 0, marginBottom: 8 }}>
          Don&apos;t block during specific hours (e.g. work hours). Useful for
          allowing work tools.
        </p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={scheduledPause.enabled}
            onChange={(e) =>
              setScheduledPause((prev) => ({ ...prev, enabled: e.target.checked }))
            }
          />
          Enable scheduled pause
        </label>
        {scheduledPause.enabled && (
          <div
            style={{
              marginTop: 12,
              display: "flex",
              flexWrap: "wrap",
              gap: 16,
              alignItems: "flex-start",
            }}
          >
            <div>
              <label className="field-label" style={{ fontSize: 12 }}>
                Start
              </label>
              <input
                className={`input ${
                  scheduledPauseValidation.fieldErrors.start ? "input-invalid" : ""
                }`}
                type="text"
                placeholder="09:00"
                value={scheduledPause.start}
                onChange={(e) =>
                  setScheduledPause((prev) => ({ ...prev, start: e.target.value }))
                }
                style={{ width: 80 }}
              />
              {scheduledPauseValidation.fieldErrors.start && (
                <div className="field-error">
                  {scheduledPauseValidation.fieldErrors.start}
                </div>
              )}
            </div>
            <div>
              <label className="field-label" style={{ fontSize: 12 }}>
                End
              </label>
              <input
                className={`input ${
                  scheduledPauseValidation.fieldErrors.end ? "input-invalid" : ""
                }`}
                type="text"
                placeholder="17:00"
                value={scheduledPause.end}
                onChange={(e) =>
                  setScheduledPause((prev) => ({ ...prev, end: e.target.value }))
                }
                style={{ width: 80 }}
              />
              {scheduledPauseValidation.fieldErrors.end && (
                <div className="field-error">
                  {scheduledPauseValidation.fieldErrors.end}
                </div>
              )}
            </div>
            <div>
              <label className="field-label" style={{ fontSize: 12 }}>
                Days (0=Sun, 6=Sat)
              </label>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  marginTop: 4,
                }}
              >
                {DAY_LABELS.map((label, i) => (
                  <label key={i} className="checkbox" style={{ marginRight: 4 }}>
                    <input
                      type="checkbox"
                      checked={scheduledPause.days?.includes(i) ?? false}
                      onChange={() => toggleScheduledPauseDay(i)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              {scheduledPauseValidation.fieldErrors.days && (
                <div className="field-error">
                  {scheduledPauseValidation.fieldErrors.days}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="form-group">
        <label className="field-label">Family time</label>
        <p className="muted" style={{ marginTop: 0, marginBottom: 8 }}>
          Block selected services during scheduled hours (e.g. dinner, homework
          time). Choose services and set the time window.
        </p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={familyTime.enabled}
            onChange={(e) =>
              setFamilyTime((prev) => ({ ...prev, enabled: e.target.checked }))
            }
          />
          Enable family time
        </label>
        {familyTime.enabled && (
          <div
            style={{
              marginTop: 12,
              display: "flex",
              flexWrap: "wrap",
              gap: 16,
              alignItems: "flex-start",
            }}
          >
            <div>
              <label className="field-label" style={{ fontSize: 12 }}>
                Start
              </label>
              <input
                className={`input ${
                  familyTimeValidation.fieldErrors.start ? "input-invalid" : ""
                }`}
                type="text"
                placeholder="17:00"
                value={familyTime.start}
                onChange={(e) =>
                  setFamilyTime((prev) => ({ ...prev, start: e.target.value }))
                }
                style={{ width: 80 }}
              />
              {familyTimeValidation.fieldErrors.start && (
                <div className="field-error">
                  {familyTimeValidation.fieldErrors.start}
                </div>
              )}
            </div>
            <div>
              <label className="field-label" style={{ fontSize: 12 }}>
                End
              </label>
              <input
                className={`input ${
                  familyTimeValidation.fieldErrors.end ? "input-invalid" : ""
                }`}
                type="text"
                placeholder="20:00"
                value={familyTime.end}
                onChange={(e) =>
                  setFamilyTime((prev) => ({ ...prev, end: e.target.value }))
                }
                style={{ width: 80 }}
              />
              {familyTimeValidation.fieldErrors.end && (
                <div className="field-error">
                  {familyTimeValidation.fieldErrors.end}
                </div>
              )}
            </div>
            <div>
              <label className="field-label" style={{ fontSize: 12 }}>
                Days (0=Sun, 6=Sat)
              </label>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  marginTop: 4,
                }}
              >
                {DAY_LABELS.map((label, i) => (
                  <label key={i} className="checkbox" style={{ marginRight: 4 }}>
                    <input
                      type="checkbox"
                      checked={familyTime.days?.includes(i) ?? false}
                      onChange={() => toggleFamilyTimeDay(i)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              {familyTimeValidation.fieldErrors.days && (
                <div className="field-error">
                  {familyTimeValidation.fieldErrors.days}
                </div>
              )}
            </div>
            <div style={{ flex: "1 1 100%" }}>
              <label className="field-label" style={{ fontSize: 12 }}>
                Services to block
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
                      checked={familyTime.services?.includes(svc.id) ?? false}
                      onChange={() => toggleFamilyTimeService(svc.id)}
                    />
                    {svc.name}
                  </label>
                ))}
              </div>
              {familyTimeValidation.fieldErrors.services && (
                <div className="field-error">
                  {familyTimeValidation.fieldErrors.services}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="form-group">
        <label className="field-label">Blocklist health check</label>
        <p className="muted" style={{ marginTop: 0, marginBottom: 8 }}>
          Validate blocklist URLs before apply. When enabled, apply can fail if
          sources are unreachable.
        </p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={healthCheck.enabled}
            onChange={(e) =>
              setHealthCheck((prev) => ({ ...prev, enabled: e.target.checked }))
            }
          />
          Validate blocklist URLs before apply
        </label>
        {healthCheck.enabled && (
          <label className="checkbox" style={{ display: "block", marginTop: 8 }}>
            <input
              type="checkbox"
              checked={healthCheck.fail_on_any}
              onChange={(e) =>
                setHealthCheck((prev) => ({
                  ...prev,
                  fail_on_any: e.target.checked,
                }))
              }
            />
            Fail apply if any source fails
          </label>
        )}
        <div style={{ marginTop: 12 }}>
          <button
            className="button"
            onClick={checkBlocklistHealth}
            disabled={healthCheckLoading}
          >
            {healthCheckLoading ? "Checking…" : "Check health now"}
          </button>
        </div>
        {healthCheckResults && (
          <div style={{ marginTop: 12 }}>
            {healthCheckResults.error ? (
              <div className="error">{healthCheckResults.error}</div>
            ) : (
              <div className="table-container">
                <div className="table-header">
                  <span>Source</span>
                  <span>URL</span>
                  <span>Status</span>
                </div>
                {(healthCheckResults.sources || []).map((s, i) => (
                  <div key={i} className="table-row">
                    <span>{s.name || "-"}</span>
                    <span className="mono" style={{ fontSize: 12 }}>
                      {s.url || "-"}
                    </span>
                    <span>
                      {s.ok ? (
                        <span className="badge active">OK</span>
                      ) : (
                        <span
                          className="badge paused"
                          title={s.error}
                        >
                          {s.error || "Failed"}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
                {(!healthCheckResults.sources ||
                  healthCheckResults.sources.length === 0) && (
                  <div className="table-row muted">No sources to check</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

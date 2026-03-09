import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { SUPPORTED_LOCAL_RECORD_TYPES } from "../utils/constants.js";
import { getRowErrorText } from "../utils/validation.js";
import { useLocalRecordsState } from "../hooks/useLocalRecordsState.js";
import { useAppContext } from "../context/AppContext.jsx";
import { SkeletonSection } from "../components/Skeleton.jsx";

const RECORD_TYPES = Array.from(SUPPORTED_LOCAL_RECORD_TYPES);

function matchesFilter(rec, filterSearch, filterType) {
  const search = (filterSearch || "").trim().toLowerCase();
  if (search) {
    const name = (rec.name || "").toLowerCase();
    const value = (rec.value || "").toLowerCase();
    const type = (rec.type || "").toLowerCase();
    if (
      !name.includes(search) &&
      !value.includes(search) &&
      !type.includes(search)
    ) {
      return false;
    }
  }
  if (filterType && (rec.type || "").toUpperCase() !== filterType) {
    return false;
  }
  return true;
}

function CopyButton({ value, label }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      type="button"
      className="icon-button copy-button"
      onClick={handleCopy}
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default function LocalRecordsPage() {
  const { isReplica } = useAppContext();
  const readOnly = isReplica;
  const {
    initialLoading,
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
    removeSelectedRecords,
  } = useLocalRecordsState();

  const [filterSearch, setFilterSearch] = useState("");
  const [filterType, setFilterType] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [selectedIndices, setSelectedIndices] = useState(new Set());

  const filteredRecordsWithIndex = useMemo(() => {
    return localRecords
      .map((rec, idx) => ({ rec, globalIndex: idx }))
      .filter(({ rec }) => matchesFilter(rec, filterSearch, filterType));
  }, [localRecords, filterSearch, filterType]);

  const filteredRecords = filteredRecordsWithIndex.map(({ rec }) => rec);
  const filteredIndices = filteredRecordsWithIndex.map(({ globalIndex }) => globalIndex);

  const selectedRecord =
    selectedIndex != null && selectedIndex >= 0 && selectedIndex < localRecords.length
      ? localRecords[selectedIndex]
      : null;

  const toggleSelect = (index) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const allFilteredSelected =
    filteredIndices.length > 0 &&
    filteredIndices.every((i) => selectedIndices.has(i));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedIndices(new Set());
    } else {
      setSelectedIndices(new Set(filteredIndices));
    }
  };

  const handleDeleteSelected = () => {
    removeSelectedRecords(selectedIndices);
    setSelectedIndices(new Set());
    if (selectedIndex != null && selectedIndices.has(selectedIndex)) {
      setSelectedIndex(null);
    }
  };

  const handleDeleteRecord = (index) => {
    removeLocalRecord(index);
    if (selectedIndex === index) setSelectedIndex(null);
    else if (selectedIndex != null && selectedIndex > index) {
      setSelectedIndex(selectedIndex - 1);
    }
  };

  if (initialLoading) {
    return (
      <section className="section">
        <h2>Local DNS Records</h2>
        <SkeletonSection />
      </section>
    );
  }

  return (
    <section className="section local-records-page">
      <div className="local-records-header">
        <div>
          <h2>Local DNS Records</h2>
          <p className="muted">
            Local records are returned immediately without upstream lookup. They
            work even when the internet is down.{" "}
            <Link to="/dns" className="link">
              DNS Settings →
            </Link>
          </p>
        </div>
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

      {isReplica && (
        <p className="muted" style={{ marginTop: 0 }}>
          Local DNS records are managed by the primary instance.
        </p>
      )}
      {localRecordsStatus && <p className="status">{localRecordsStatus}</p>}
      {localRecordsError && <div className="error">{localRecordsError}</div>}

      <div className="local-records-layout">
        <div className="local-records-panel">
          <div className="local-records-toolbar">
            <div className="local-records-toolbar-actions">
              {!readOnly && (
                <>
                  <button
                    className="button primary"
                    onClick={addLocalRecord}
                    disabled={readOnly}
                  >
                    Create record
                  </button>
                  <button
                    className="button"
                    onClick={handleDeleteSelected}
                    disabled={readOnly || selectedIndices.size === 0}
                  >
                    Delete record{selectedIndices.size !== 1 ? "s" : ""}
                  </button>
                </>
              )}
            </div>
            <div className="local-records-filters">
              <input
                className="input filter-input"
                placeholder="Filter records by name, type, or value"
                value={filterSearch}
                onChange={(e) => setFilterSearch(e.target.value)}
                aria-label="Filter records"
              />
              <select
                className="input"
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                aria-label="Filter by type"
                style={{ minWidth: 100 }}
              >
                <option value="">All types</option>
                {RECORD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="local-records-info">
            Records ({filteredRecords.length}/{localRecords.length})
          </div>

          <div className="local-records-table-wrapper">
            <div className={`table local-records-table ${!readOnly ? "with-actions" : ""}`}>
              <div className="table-header">
                {!readOnly && (
                  <span className="table-cell table-cell-checkbox">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleSelectAll}
                      aria-label="Select all"
                    />
                  </span>
                )}
                <span className="table-cell">Record name</span>
                <span className="table-cell">Type</span>
                <span className="table-cell">Value</span>
                {!readOnly && <span className="table-cell table-cell-actions" />}
              </div>
              {filteredRecords.length === 0 ? (
                <div className="table-empty">
                  {localRecords.length === 0
                    ? "No records. Create one to get started."
                    : "No records match the filter."}
                </div>
              ) : (
                filteredRecordsWithIndex.map(({ rec, globalIndex }) => {
                  const isSelected = selectedIndex === globalIndex;
                  const isChecked = selectedIndices.has(globalIndex);
                  const rowErrors = localRecordsValidation.rowErrors?.[globalIndex];
                  return (
                    <div
                      key={`${globalIndex}-${rec.name}-${rec.type}-${rec.value}`}
                      className={`table-row local-records-row ${isSelected ? "selected" : ""}`}
                      onClick={() => setSelectedIndex(globalIndex)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedIndex(globalIndex);
                        }
                      }}
                      aria-selected={isSelected}
                    >
                      {!readOnly && (
                        <span
                          className="table-cell table-cell-checkbox"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleSelect(globalIndex)}
                            aria-label={`Select ${rec.name}`}
                          />
                        </span>
                      )}
                      <span className="table-cell mono" title={rec.name}>
                        {rec.name || "—"}
                      </span>
                      <span className="table-cell">{rec.type || "A"}</span>
                      <span className="table-cell mono" title={rec.value}>
                        {rec.value || "—"}
                      </span>
                      {!readOnly && (
                        <span
                          className="table-cell table-cell-actions"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            className="icon-button"
                            onClick={() => handleDeleteRecord(globalIndex)}
                            disabled={readOnly}
                            title="Delete record"
                          >
                            Remove
                          </button>
                        </span>
                      )}
                      {rowErrors && Object.keys(rowErrors).length > 0 && (
                        <div className="field-error">
                          {getRowErrorText(rowErrors)}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div className="local-records-details-panel">
          <div className="local-records-details-header">
            <h3>Record details</h3>
          </div>
          {selectedRecord ? (
            <div className="local-records-details-content">
              <div className="form-group">
                <label className="field-label">Record name</label>
                <div className="field-with-copy">
                  <input
                    className={`input ${
                      localRecordsValidation.rowErrors?.[selectedIndex]?.name
                        ? "input-invalid"
                        : ""
                    }`}
                    value={selectedRecord.name || ""}
                    onChange={(e) =>
                      updateLocalRecord(selectedIndex, "name", e.target.value)
                    }
                    placeholder="e.g. router.local"
                    disabled={readOnly}
                  />
                  <CopyButton value={selectedRecord.name} label="Record name" />
                </div>
              </div>
              <div className="form-group">
                <label className="field-label">Record type</label>
                <select
                  className={`input ${
                    localRecordsValidation.rowErrors?.[selectedIndex]?.type
                      ? "input-invalid"
                      : ""
                  }`}
                  value={selectedRecord.type || "A"}
                  onChange={(e) =>
                    updateLocalRecord(selectedIndex, "type", e.target.value)
                  }
                  disabled={readOnly}
                >
                  {RECORD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="field-label">Value</label>
                <div className="field-with-copy">
                  <input
                    className={`input ${
                      localRecordsValidation.rowErrors?.[selectedIndex]?.value
                        ? "input-invalid"
                        : ""
                    }`}
                    value={selectedRecord.value || ""}
                    onChange={(e) =>
                      updateLocalRecord(selectedIndex, "value", e.target.value)
                    }
                    placeholder="IP address or hostname"
                    disabled={readOnly}
                  />
                  <CopyButton value={selectedRecord.value} label="Value" />
                </div>
              </div>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: 8 }}>
                A for IPv4, AAAA for IPv6, CNAME for aliases, TXT for text, PTR
                for reverse lookups. Use * for wildcards (e.g. *.local).
              </p>
              {!readOnly && (
                <button
                  className="button"
                  onClick={() => handleDeleteRecord(selectedIndex)}
                  style={{ marginTop: 16 }}
                >
                  Delete this record
                </button>
              )}
            </div>
          ) : (
            <div className="local-records-details-empty">
              <p>Select a record to view or edit its details.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

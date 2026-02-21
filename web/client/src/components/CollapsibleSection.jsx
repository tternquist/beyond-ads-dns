import { useEffect, useState } from "react";
import { COLLAPSIBLE_STORAGE_KEY } from "../utils/constants.js";

function loadCollapsed(id, defaultCollapsed = false) {
  try {
    const stored = localStorage.getItem(COLLAPSIBLE_STORAGE_KEY);
    if (!stored) return defaultCollapsed;
    const parsed = JSON.parse(stored);
    if (!(id in parsed)) return defaultCollapsed;
    return Boolean(parsed[id]);
  } catch {
    return defaultCollapsed;
  }
}

function saveCollapsed(id, collapsed) {
  try {
    const stored = localStorage.getItem(COLLAPSIBLE_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    parsed[id] = collapsed;
    localStorage.setItem(COLLAPSIBLE_STORAGE_KEY, JSON.stringify(parsed));
  } catch {}
}

export default function CollapsibleSection({ id, title, children, collapsed: controlledCollapsed, onToggle, badges, storageKey, defaultCollapsed }) {
  const storageId = id ?? storageKey;
  const contentId = `collapsible-${storageId}`;
  const [internalCollapsed, setInternalCollapsed] = useState(() =>
    loadCollapsed(storageId, defaultCollapsed ?? false)
  );
  const isControlled = controlledCollapsed !== undefined && onToggle != null;
  const isCollapsed = isControlled ? controlledCollapsed : internalCollapsed;

  useEffect(() => {
    if (!isControlled && storageId) saveCollapsed(storageId, internalCollapsed);
  }, [storageId, internalCollapsed, isControlled]);

  const handleToggle = () => {
    if (isControlled) {
      onToggle?.(storageId ?? id);
    } else if (storageId) {
      setInternalCollapsed((prev) => {
        const next = !prev;
        saveCollapsed(storageId, next);
        return next;
      });
    }
  };

  return (
    <section className="section collapsible-section">
      <div
        className="collapsible-header"
        onClick={handleToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleToggle();
          }
        }}
        role="button"
        tabIndex={0}
        aria-expanded={!isCollapsed}
        aria-controls={contentId}
      >
        <div className="collapsible-header-inner">
          <h2>{title}</h2>
          {badges}
        </div>
        <span className={`collapsible-chevron ${isCollapsed ? "collapsed" : ""}`} aria-hidden>▼</span>
      </div>
      <div id={contentId} className={`collapsible-content ${isCollapsed ? "collapsed" : ""}`}>
        {!isCollapsed && <div className="collapsible-content-inner">{children}</div>}
      </div>
    </section>
  );
}

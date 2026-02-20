import { useEffect, useState } from "react";
import { COLLAPSIBLE_STORAGE_KEY } from "../utils/constants.js";

function loadCollapsed(id) {
  try {
    const stored = localStorage.getItem(COLLAPSIBLE_STORAGE_KEY);
    if (!stored) return false;
    const parsed = JSON.parse(stored);
    return Boolean(parsed[id]);
  } catch {
    return false;
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

export default function CollapsibleSection({ id, title, children, collapsed: controlledCollapsed, onToggle, badges }) {
  const contentId = `collapsible-${id}`;
  const [internalCollapsed, setInternalCollapsed] = useState(() => loadCollapsed(id));
  const isControlled = controlledCollapsed !== undefined && onToggle != null;
  const isCollapsed = isControlled ? controlledCollapsed : internalCollapsed;

  useEffect(() => {
    if (!isControlled) saveCollapsed(id, internalCollapsed);
  }, [id, internalCollapsed, isControlled]);

  const handleToggle = () => {
    if (isControlled) {
      onToggle?.(id);
    } else {
      setInternalCollapsed((prev) => {
        const next = !prev;
        saveCollapsed(id, next);
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

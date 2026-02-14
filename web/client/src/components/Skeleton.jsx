export function SkeletonCard() {
  return (
    <div className="skeleton-card card">
      <div className="skeleton-line skeleton-label" />
      <div className="skeleton-line skeleton-value" />
      <div className="skeleton-line skeleton-sub" />
    </div>
  );
}

export function SkeletonTable({ rows = 5 }) {
  return (
    <div className="table">
      <div className="table-filters">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton-input" />
        ))}
      </div>
      <div className="table-header">
        {[1, 2, 3, 4, 5, 6, 7].map((i) => (
          <div key={i} className="skeleton-line" style={{ width: 60 }} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="table-row">
          {[1, 2, 3, 4, 5, 6, 7].map((j) => (
            <div key={j} className="skeleton-line" style={{ width: "100%" }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonChart() {
  return (
    <div className="chart-container skeleton-chart">
      <div className="skeleton-line" style={{ width: "60%", marginBottom: 16 }} />
      <div className="skeleton-bars" />
    </div>
  );
}

export function EmptyState({ icon, title, description, action }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state-icon">{icon}</div>}
      <h3 className="empty-state-title">{title}</h3>
      <p className="empty-state-description">{description}</p>
      {action}
    </div>
  );
}

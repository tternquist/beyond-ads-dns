import Tooltip from "./Tooltip.jsx";

export default function StatCard({ label, value, subtext, tooltip, drillDownOutcome, onDrillDown }) {
  const canDrillDown = drillDownOutcome && onDrillDown;
  return (
    <div
      className={`card ${canDrillDown ? "card-clickable" : ""}`}
      onClick={canDrillDown ? () => onDrillDown(drillDownOutcome) : undefined}
      role={canDrillDown ? "button" : undefined}
      tabIndex={canDrillDown ? 0 : undefined}
      onKeyDown={
        canDrillDown
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onDrillDown(drillDownOutcome);
              }
            }
          : undefined
      }
    >
      <div className="card-label">
        <Tooltip content={tooltip}>
          <span>{label}</span>
        </Tooltip>
      </div>
      <div className="card-value">{value}</div>
      {subtext && <div className="card-subtext">{subtext}</div>}
      {canDrillDown && (
        <div className="card-drilldown" title="View in Queries">
          View details →
        </div>
      )}
    </div>
  );
}

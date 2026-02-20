import { OUTCOME_COLORS } from "../utils/constants.js";

export default function DonutChart({ data, total, size = 160, colorPalette, ariaLabel }) {
  const filtered = (data || []).filter((d) => d.count > 0);
  if (!filtered.length || total === 0) return null;
  const strokeWidth = size * 0.2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const segments = filtered.map(({ key, count, label }, idx) => {
    const pct = count / total;
    const dashLength = pct * circumference;
    const color = colorPalette
      ? colorPalette[idx % colorPalette.length]
      : (OUTCOME_COLORS[key] || "#9ca3af");
    const segment = { key, count, label, color, dashLength, offset };
    offset += dashLength;
    return segment;
  });
  const defaultLabel = segments
    .map((s) => `${s.label}: ${s.count} (${((s.count / total) * 100).toFixed(1)}%)`)
    .join(". ");
  return (
    <div className="donut-chart-container">
      <div className="donut-chart-wrapper">
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={ariaLabel || defaultLabel}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--chart-grid)"
            strokeWidth={strokeWidth}
          />
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            {segments.map(({ key, color, dashLength, offset: segOffset }) => (
              <circle
                key={key}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeDasharray={`${dashLength} ${circumference}`}
                strokeDashoffset={-segOffset}
                strokeLinecap="round"
              />
            ))}
          </g>
        </svg>
      </div>
      <div className="donut-chart-legend">
        {segments.map(({ key, label, count, color }) => (
          <div key={key} className="donut-legend-item">
            <span className="donut-legend-dot" style={{ background: color }} />
            <span className="donut-legend-label">{label}</span>
            <span className="donut-legend-value">
              {count.toLocaleString()} ({((count / total) * 100).toFixed(1)}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

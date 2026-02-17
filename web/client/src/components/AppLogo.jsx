/**
 * BEYOND-ADS-DNS logo component.
 * Renders the shield with circuitry motif and brand text.
 * @param {Object} props
 * @param {boolean} [props.compact] - Show icon-only (shield) for collapsed sidebar
 * @param {number} [props.height] - Logo height in pixels
 * @param {boolean} [props.showText] - Include "BEYOND-ADS-DNS" text (default: true when not compact)
 */
export default function AppLogo({ compact = false, height = 32, showText = !compact }) {
  const darkBlue = "var(--logo-dark-blue, #1e3a5f)";
  const mediumBlue = "var(--logo-medium-blue, #2563eb)";
  const lightBlue = "var(--logo-light-blue, #7dd3fc)";
  const cyan = "var(--logo-cyan, #22d3ee)";
  const grey = "var(--logo-grey, #64748b)";

  const icon = (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      width={height}
      height={height}
      aria-hidden
    >
      <defs>
        <clipPath id="shield-clip">
          <path d="M24 4L8 10v14c0 11 8 20 16 22 8-2 16-11 16-22V10L24 4z" />
        </clipPath>
      </defs>
      {/* Outer shield - dark blue */}
      <path
        d="M24 4L8 10v14c0 11 8 20 16 22 8-2 16-11 16-22V10L24 4z"
        fill={darkBlue}
        stroke={grey}
        strokeWidth="0.5"
        strokeLinejoin="round"
      />
      {/* Grey accent upper right */}
      <path
        d="M36 12l-8 2v6l8-2v-6z"
        fill={grey}
        opacity="0.6"
      />
      {/* Inner shield - medium blue */}
      <path
        d="M24 8L12 12.5v12c0 8.5 6 15.5 12 17.5 6-2 12-9 12-17.5v-12L24 8z"
        fill={mediumBlue}
        stroke={lightBlue}
        strokeWidth="0.4"
        strokeLinejoin="round"
      />
      <g clipPath="url(#shield-clip)">
        {/* Circuitry lines - cyan */}
        <path
          d="M14 20h6M14 24h8M14 28h6M18 20v12M22 22v8"
          stroke={cyan}
          strokeWidth="0.8"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="14" cy="20" r="1.2" fill={cyan} />
        <circle cx="14" cy="24" r="1.2" fill={cyan} />
        <circle cx="14" cy="28" r="1.2" fill={cyan} />
        <circle cx="18" cy="20" r="1.2" fill={cyan} />
        <circle cx="22" cy="22" r="1.2" fill={cyan} />
        <circle cx="26" cy="24" r="1.2" fill={cyan} />
        <path
          d="M26 24h6M30 22v4"
          stroke={cyan}
          strokeWidth="0.8"
          strokeLinecap="round"
          fill="none"
        />
        {/* Dashed flow lines left */}
        <path
          d="M10 22h2M10 26h2"
          stroke={cyan}
          strokeWidth="0.6"
          strokeDasharray="1 1"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="10" cy="22" r="0.5" fill={cyan} />
        <circle cx="10" cy="26" r="0.5" fill={cyan} />
      </g>
    </svg>
  );

  if (compact) {
    return (
      <div className="app-logo app-logo--compact" title="Beyond Ads DNS">
        {icon}
      </div>
    );
  }

  return (
    <div className="app-logo" title="Beyond Ads DNS">
      {icon}
      {showText && (
        <span className="app-logo-text">
          <span className="app-logo-text-primary">BEYOND-ADS</span>
          <span className="app-logo-text-muted">-DNS</span>
        </span>
      )}
    </div>
  );
}

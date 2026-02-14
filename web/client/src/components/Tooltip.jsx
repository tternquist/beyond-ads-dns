export default function Tooltip({ children, content }) {
  if (!content) return children;
  return (
    <span className="tooltip-trigger">
      {children}
      <span className="tooltip-icon" aria-hidden>ⓘ</span>
      <span className="tooltip-content" role="tooltip">{content}</span>
    </span>
  );
}

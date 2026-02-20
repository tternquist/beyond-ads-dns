import { useId, useState } from "react";

export default function Tooltip({ children, content }) {
  const id = useId();
  const [visible, setVisible] = useState(false);

  if (!content) return children;

  return (
    <span
      className="tooltip-trigger"
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      tabIndex={0}
      aria-describedby={id}
    >
      {children}
      <span className="tooltip-icon" aria-hidden>ⓘ</span>
      <span
        id={id}
        className="tooltip-content"
        role="tooltip"
        aria-hidden={!visible}
      >
        {content}
      </span>
    </span>
  );
}

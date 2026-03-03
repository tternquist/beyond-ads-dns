import { useState } from "react";

function isValidDomain(value) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const labels = trimmed.split(".");
  if (labels.some((l) => !l.length)) return false;
  const validLabel = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;
  return labels.every((l) => validLabel.test(l));
}

export default function DomainEditor({ items, onAdd, onRemove, readOnly = false }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const trimmed = value.trim();
  const domain = trimmed.toLowerCase();
  const canAdd = trimmed && isValidDomain(trimmed) && !items.includes(domain);

  const handleAdd = () => {
    if (readOnly || !canAdd) return;
    if (items.includes(domain)) {
      setError("Domain already in list");
      return;
    }
    setError("");
    onAdd(domain);
    setValue("");
  };

  const handleChange = (e) => {
    if (readOnly) return;
    setValue(e.target.value);
    setError("");
  };

  return (
    <div className="domain-editor">
      <div className="domain-input">
        <input
          className={`input ${error ? "input-invalid" : ""}`}
          placeholder="example.com"
          value={value}
          onChange={handleChange}
          onBlur={() => setError("")}
          aria-invalid={!!error}
          aria-describedby={error ? "domain-editor-error" : undefined}
          disabled={readOnly}
        />
        <button
          className="button"
          onClick={handleAdd}
          disabled={!canAdd || readOnly}
          type="button"
        >
          Add
        </button>
      </div>
      {error && (
        <div id="domain-editor-error" className="field-error">
          {error}
        </div>
      )}
      <div className="tags">
        {items.length === 0 && <span className="muted">None</span>}
        {items.map((item) => (
          <span key={item} className="tag">
            {item}
            <button
              type="button"
              className="tag-remove"
              onClick={() => {
                if (readOnly) return;
                onRemove(item);
              }}
              aria-label={`Remove ${item}`}
              disabled={readOnly}
            >
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

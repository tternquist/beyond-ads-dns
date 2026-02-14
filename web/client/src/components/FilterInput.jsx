import { useState } from "react";

export default function FilterInput({ value, onChange, placeholder, options = [] }) {
  const [showDropdown, setShowDropdown] = useState(false);

  const handleSelect = (selectedValue) => {
    onChange(selectedValue);
    setShowDropdown(false);
  };

  const handleInputChange = (e) => {
    onChange(e.target.value);
  };

  const handleInputFocus = () => {
    if (options.length > 0) setShowDropdown(true);
  };

  const handleInputBlur = () => {
    setTimeout(() => setShowDropdown(false), 200);
  };

  return (
    <div className="filter-input-wrapper">
      <input
        className="input filter-input"
        placeholder={placeholder}
        value={value}
        onChange={handleInputChange}
        onFocus={handleInputFocus}
        onBlur={handleInputBlur}
      />
      {showDropdown && options.length > 0 && (
        <div className="filter-dropdown">
          {options.map((option, index) => (
            <button
              key={index}
              className="filter-dropdown-item"
              onClick={() => handleSelect(option.value)}
              type="button"
            >
              <span className="filter-dropdown-value">{option.value || "-"}</span>
              <span className="filter-dropdown-count">
                {(option.count || 0).toLocaleString()}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

import { useState, useRef, useEffect } from "react";

export default function FilterInput({ value, onChange, placeholder, options = [], id: idProp }) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const wrapperRef = useRef(null);
  const dropdownRef = useRef(null);
  const id = idProp || `filter-input-${Math.random().toString(36).slice(2)}`;

  const handleSelect = (selectedValue) => {
    onChange(selectedValue);
    setShowDropdown(false);
    setHighlightedIndex(-1);
  };

  const handleInputChange = (e) => {
    onChange(e.target.value);
    setHighlightedIndex(-1);
  };

  const handleInputFocus = () => {
    if (options.length > 0) setShowDropdown(true);
  };

  const handleInputBlur = () => {
    setTimeout(() => {
      if (!wrapperRef.current?.contains(document.activeElement)) {
        setShowDropdown(false);
        setHighlightedIndex(-1);
      }
    }, 150);
  };

  const handleKeyDown = (e) => {
    if (!showDropdown || options.length === 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((i) => (i < options.length - 1 ? i + 1 : 0));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((i) => (i > 0 ? i - 1 : options.length - 1));
        break;
      case "Enter":
        e.preventDefault();
        if (highlightedIndex >= 0 && options[highlightedIndex]) {
          handleSelect(options[highlightedIndex].value);
        }
        break;
      case "Escape":
        e.preventDefault();
        setShowDropdown(false);
        setHighlightedIndex(-1);
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    if (showDropdown && highlightedIndex >= 0) {
      dropdownRef.current?.children[highlightedIndex]?.scrollIntoView({
        block: "nearest",
      });
    }
  }, [highlightedIndex, showDropdown]);

  return (
    <div
      ref={wrapperRef}
      className="filter-input-wrapper"
      onBlur={handleInputBlur}
    >
      <input
        id={id}
        className="input filter-input"
        placeholder={placeholder}
        value={value}
        onChange={handleInputChange}
        onFocus={handleInputFocus}
        onKeyDown={handleKeyDown}
        aria-expanded={showDropdown && options.length > 0}
        aria-haspopup="listbox"
        aria-controls={showDropdown ? `${id}-listbox` : undefined}
        aria-autocomplete="list"
      />
      {showDropdown && options.length > 0 && (
        <div
          ref={dropdownRef}
          id={`${id}-listbox`}
          className="filter-dropdown"
          role="listbox"
        >
          {options.map((option, index) => (
            <button
              key={option.value ?? index}
              className={`filter-dropdown-item ${index === highlightedIndex ? "filter-dropdown-item--highlighted" : ""}`}
              onClick={() => handleSelect(option.value)}
              onMouseEnter={() => setHighlightedIndex(index)}
              type="button"
              role="option"
              aria-selected={index === highlightedIndex}
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

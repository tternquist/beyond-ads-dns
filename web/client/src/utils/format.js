export function formatNumber(value) {
  if (value === null || value === undefined) return "-";
  return value.toLocaleString();
}

export function formatUtcToLocalTime(ts) {
  if (ts == null) return "";
  let date;
  if (typeof ts === "number") {
    date = new Date(ts);
  } else {
    const str = String(ts).trim();
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(str) && !/[Zz]$|[+-]\d{2}:?\d{2}$/.test(str)) {
      date = new Date(str.replace(" ", "T") + "Z");
    } else {
      date = new Date(ts);
    }
  }
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

export function formatUtcToLocalDateTime(ts) {
  if (ts == null) return "";
  let date;
  if (typeof ts === "number") {
    date = new Date(ts);
  } else {
    const str = String(ts).trim();
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(str) && !/[Zz]$|[+-]\d{2}:?\d{2}$/.test(str)) {
      date = new Date(str.replace(" ", "T") + "Z");
    } else {
      date = new Date(ts);
    }
  }
  return date.toLocaleString([], {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

export function formatPercent(value) {
  if (value === null || value === undefined) return "-";
  return `${(value * 100).toFixed(2)}%`;
}

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

/** Returns % for a single outcome from response_distribution (outcome -> count). */
export function formatPctFromDistribution(dist, outcome) {
  if (!dist || dist.total == null || dist.total === 0) return "—";
  const count = dist[outcome] ?? 0;
  return `${((count / dist.total) * 100).toFixed(2)}%`;
}

/** Returns % for error outcomes (upstream_error, servfail, servfail_backoff, invalid). */
export function formatErrorPctFromDistribution(dist) {
  if (!dist || dist.total == null || dist.total === 0) return "—";
  const errorOutcomes = ["upstream_error", "servfail", "servfail_backoff", "invalid"];
  const errorCount = errorOutcomes.reduce((s, k) => s + (dist[k] ?? 0), 0);
  return `${((errorCount / dist.total) * 100).toFixed(2)}%`;
}

/**
 * Parses slog output (JSON or text format) to extract message and attributes.
 * Returns { msg, attrs, isStructured } or null if not parseable.
 */
export function parseSlogMessage(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();

  // slog JSON format: {"time":"...","level":"ERROR","msg":"...","err":"..."}
  if (s.startsWith("{")) {
    try {
      const obj = JSON.parse(s);
      const msg = obj.msg ?? obj.message ?? "";
      const attrs = {};
      const skip = new Set(["time", "level", "msg", "message"]);
      for (const [k, v] of Object.entries(obj)) {
        if (!skip.has(k) && v != null && v !== "") attrs[k] = v;
      }
      return { msg: String(msg), attrs, isStructured: true };
    } catch {
      return null;
    }
  }

  // slog text format: time=... level=ERROR msg="sync: blocklist reload error" err=...
  if (s.includes("=") && (s.includes("level=") || s.includes(" msg="))) {
    const msgMatch = s.match(/msg="([^"]*)"/) || s.match(/msg=(\S+)/);
    const msg = msgMatch ? (msgMatch[1] ?? "").trim() : "";
    const attrs = {};
    const attrRegex = /(\w+)=([^\s]+|"[^"]*")/g;
    const skip = new Set(["time", "level", "msg"]);
    let m;
    while ((m = attrRegex.exec(s)) !== null) {
      if (!skip.has(m[1])) {
        let val = m[2];
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        attrs[m[1]] = val;
      }
    }
    return { msg, attrs, isStructured: true };
  }

  return null;
}

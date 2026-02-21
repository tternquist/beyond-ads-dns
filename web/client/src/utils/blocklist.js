/**
 * Domain/blocklist helper functions used across blocklist and query pages.
 */

export function normalizeDomainForBlocklist(qname) {
  if (!qname || typeof qname !== "string") return "";
  return qname.trim().toLowerCase().replace(/\.$/, "");
}

export function escapeDomainForRegex(domain) {
  return domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isDomainBlockedByDenylist(qname, list) {
  const normalized = normalizeDomainForBlocklist(qname);
  if (!normalized || !list?.length) return false;
  for (const entry of list) {
    if (entry.startsWith("/") && entry.endsWith("/") && entry.length > 2) {
      try {
        const pattern = entry.slice(1, -1);
        if (new RegExp(pattern).test(normalized)) return true;
      } catch {
        /* skip invalid regex */
      }
    } else {
      let remaining = normalized;
      while (remaining) {
        if (entry === remaining) return true;
        const idx = remaining.indexOf(".");
        if (idx === -1) break;
        remaining = remaining.slice(idx + 1);
      }
    }
  }
  return false;
}

export function getDenylistEntriesBlocking(qname, list) {
  const normalized = normalizeDomainForBlocklist(qname);
  if (!normalized || !list?.length) return [];
  const entries = [];
  for (const entry of list) {
    if (entry.startsWith("/") && entry.endsWith("/") && entry.length > 2) {
      try {
        const pattern = entry.slice(1, -1);
        if (new RegExp(pattern).test(normalized)) entries.push(entry);
      } catch {
        /* skip invalid regex */
      }
    } else {
      let remaining = normalized;
      while (remaining) {
        if (entry === remaining) {
          entries.push(entry);
          break;
        }
        const idx = remaining.indexOf(".");
        if (idx === -1) break;
        remaining = remaining.slice(idx + 1);
      }
    }
  }
  return entries;
}

export function isDomainInAllowlist(qname, list) {
  const normalized = normalizeDomainForBlocklist(qname);
  if (!normalized || !list?.length) return false;
  for (const entry of list) {
    if (entry.startsWith("/") && entry.endsWith("/") && entry.length > 2) {
      try {
        const pattern = entry.slice(1, -1);
        if (new RegExp(pattern).test(normalized)) return true;
      } catch {
        /* skip invalid regex */
      }
    } else {
      let remaining = normalized;
      while (remaining) {
        if (entry === remaining) return true;
        const idx = remaining.indexOf(".");
        if (idx === -1) break;
        remaining = remaining.slice(idx + 1);
      }
    }
  }
  return false;
}

export function isServiceBlockedByDenylist(service, list) {
  if (!list?.length || !service?.domains?.length) return false;
  return service.domains.every((d) => isDomainBlockedByDenylist(d, list));
}

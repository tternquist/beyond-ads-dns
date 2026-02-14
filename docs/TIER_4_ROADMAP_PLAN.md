# Tier 4 Roadmap Implementation Plan

This document outlines the implementation plan for the four Tier 4 "Nice-to-Have" features from `docs/COMPETITIVE_ANALYSIS_AND_ROADMAP.md`.

---

## Overview

| Feature | Effort | Rationale |
|---------|--------|------------|
| Safe search / Safe browsing | Medium | Parental controls; AdGuard differentiator |
| API for third-party integration | Low | Automation, Home Assistant, etc. |
| Blocklist recommendations | Low | Onboarding UX |
| Dark mode for UI | Low | Accessibility, preference |

**Suggested implementation order:** Dark mode → Blocklist recommendations → API/webhooks → Safe search (increasing complexity).

---

## 1. Dark Mode for UI

**Effort:** Low  
**Files:** `web/client/src/App.jsx`, `web/client/src/index.css` (or new theme file)

### Approach

- Add a theme toggle (light/dark/system) in the UI header or System Settings.
- Use CSS variables for colors; define light and dark palettes.
- Persist preference in `localStorage` (e.g. `theme: "light" | "dark" | "system"`).
- System preference via `prefers-color-scheme` when `theme === "system"`.

### Implementation Steps

1. **Define CSS variables** for both themes:
   - Background, foreground, accent, muted, borders, error/success colors.
2. **Add theme state** in `App.jsx`:
   - `useState` + `useEffect` to read/write `localStorage` and apply `data-theme` on `<html>` or root.
3. **Add toggle component** in header or System Settings tab.
4. **Update existing styles** to use CSS variables instead of hardcoded colors.

### Config (Optional)

- Add `ui.theme: "light" | "dark" | "system"` to config for default; can be overridden by user preference.

---

## 2. Blocklist Recommendations

**Effort:** Low  
**Files:** `web/client/src/App.jsx`, `web/server/src/index.js` (optional preset API)

### Approach

- Define presets: **Strict** (Hagezi Pro++, malware), **Balanced** (Hagezi Pro), **Minimal** (Hagezi Light).
- Show preset cards on Blocklists tab when sources are empty or user clicks "Get recommendations".
- Selecting a preset populates `sources` with known URLs; user can still edit before saving.

### Implementation Steps

1. **Define preset data** (in client or small JSON):
   ```js
   const BLOCKLIST_PRESETS = [
     { id: "strict", label: "Strict", description: "Maximum blocking (ads, trackers, malware)", sources: [...] },
     { id: "balanced", label: "Balanced", description: "Good balance for most users", sources: [...] },
     { id: "minimal", label: "Minimal", description: "Light blocking, fewer false positives", sources: [...] },
   ];
   ```
2. **Add "Recommendations" section** on Blocklists tab:
   - Show when `blocklistSources.length === 0` or via "Show recommendations" button.
   - Cards for each preset; click applies sources to form (does not save).
3. **Use official Hagezi URLs** (or similar) for each preset; document in README.

### Config

- No config changes. Presets are UI-only suggestions.

---

## 3. API for Third-Party Integration

**Effort:** Low  
**Files:** `cmd/beyond-ads-dns/main.go`, `internal/dnsresolver/resolver.go`, `internal/config/config.go`, `config/config.example.yaml`

### Approach

- **Webhook on block:** HTTP POST to configurable URL when a query is blocked. Payload: `{ "qname", "client_ip", "timestamp", "outcome": "blocked" }`.
- **REST API for external tools:** Extend existing Control API with optional endpoints (e.g. `GET /blocklists/stats`, `POST /blocklists/pause`) if not already exposed; document for Home Assistant, scripts, etc.

### Implementation Steps

#### 3a. Webhook on Block

1. **Config:**
   ```yaml
   webhooks:
     on_block:
       enabled: true
       url: "https://example.com/webhook"
       # Optional: headers, timeout, method (POST)
   ```
2. **Go:** Add `webhooks` config struct; in resolver's `blockedReply` path, fire async HTTP POST (non-blocking, fire-and-forget or with short timeout).
3. **Payload:** JSON with `qname`, `client_ip` (or anonymized), `timestamp`, `outcome: "blocked"`.
4. **Rate limiting:** Optional cap (e.g. max 10/min per client) to avoid flooding.

#### 3b. REST API Documentation

- Document Control API endpoints in README or `docs/API.md` for third-party integration (blocklists, pause/resume, stats, etc.).
- No new endpoints required if existing ones suffice; focus on documentation and webhook.

### Config

- New `webhooks` section in `config.go` and `config.example.yaml`.

---

## 4. Safe Search / Safe Browsing

**Effort:** Medium  
**Files:** `internal/dnsresolver/resolver.go`, `internal/config/config.go`, `config/config.example.yaml`, `web/client/src/App.jsx`, `web/server/src/index.js`

### Approach

- **Safe Search:** For queries to Google, Bing, DuckDuckGo search domains, return CNAME or A records that force safe search (e.g. `forcesafesearch.google.com`).
- **Safe Browsing:** Google Safe Browsing API integration is heavier; start with Safe Search only for Tier 4.

### Implementation Steps

1. **Define rewrite rules** (config-driven):
   - `www.google.com` → `forcesafesearch.google.com` (CNAME)
   - `www.bing.com` → `strict.bing.com` (CNAME)
   - `duckduckgo.com` → safe search via query param (DDG uses `safe=on` in URL; DNS-level is limited—may need to document that DDG safe search is URL-based).

2. **Config:**
   ```yaml
   safe_search:
     enabled: true
     # Optional: per-engine overrides
     engines:
       google: true
       bing: true
       duckduckgo: true  # If DNS-level support exists
   ```

3. **Resolver logic:**
   - Before blocklist check (or in a dedicated "rewrite" phase), if `safe_search.enabled` and qname matches known search domains:
     - Return CNAME to the safe-search domain (e.g. `forcesafesearch.google.com`).
   - Use a small map of domain → safe CNAME; keep it static in code or config.

4. **UI:**
   - Add "Safe Search" toggle in DNS Settings or new "Parental" section.
   - Sync with config; hot-reload if supported.

### Domain Mappings (Reference)

- **Google:** `www.google.com`, `google.com` → `forcesafesearch.google.com`
- **Bing:** `www.bing.com`, `bing.com` → `strict.bing.com`
- **DuckDuckGo:** DNS-level safe search is not standard; document limitation or skip for v1.

### Config

- New `safe_search` section; include in `DNSAffectingConfig` for sync if replicas should inherit.

---

## Dependencies and Ordering

| Feature | Depends On | Blocks |
|---------|------------|--------|
| Dark mode | None | None |
| Blocklist recommendations | None | None |
| API/webhooks | None | None |
| Safe search | None | None |

All four can be implemented in parallel. Recommended order for incremental value:

1. **Dark mode** — Quick win, improves UX immediately.
2. **Blocklist recommendations** — Helps new users; no backend changes.
3. **API/webhooks** — Enables automation; moderate backend work.
4. **Safe search** — More complex resolver changes; test thoroughly.

---

## Testing Strategy

- **Dark mode:** Manual UI check; optional E2E for theme persistence.
- **Blocklist recommendations:** Unit test preset application; manual UI verification.
- **Webhooks:** Integration test with mock HTTP server; verify payload and non-blocking behavior.
- **Safe search:** DNS resolution tests for `www.google.com` → `forcesafesearch.google.com`; verify CNAME response.

---

## Documentation Updates

- **README:** Add sections for Safe Search, Webhooks, Blocklist presets, Dark mode.
- **config.example.yaml:** Document all new config keys.
- **COMPETITIVE_ANALYSIS_AND_ROADMAP.md:** Update Tier 4 status as each feature is completed.

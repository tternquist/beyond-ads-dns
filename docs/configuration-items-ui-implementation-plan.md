# Configuration Items UI Implementation Plan

This document evaluates configuration items that are **not yet in the UI** and provides a phased implementation plan. The focus is on blocklist-related settings: **scheduled blocklist pause** and **blocklist health check**.

---

## 1. Evaluation: Missing Configuration Items

### 1.1 Blocklist Settings (Blocklists Tab)

| Config Item | Backend | API | UI | Notes |
|-------------|---------|-----|-----|-------|
| `refresh_interval` | ✅ | ✅ GET/PUT | ✅ | In Blocklists tab |
| `sources` | ✅ | ✅ GET/PUT | ✅ | In Blocklists tab |
| `allowlist` | ✅ | ✅ GET/PUT | ✅ | In Blocklists tab |
| `denylist` | ✅ | ✅ GET/PUT | ✅ | In Blocklists tab |
| **`scheduled_pause`** | ✅ | ❌ | ❌ | **Missing** – recurring schedule (e.g. 9am–5pm Mon–Fri) |
| **`health_check`** | ✅ | ❌ | ❌ | **Missing** – validate URLs before apply |

**Important distinction:**
- **Manual pause** (temporary): Already in Overview "Blocking Control" – pause for 1/5/30/60 min via API. Works per-instance.
- **Scheduled pause** (recurring): Config-based. Pause blocking during specific hours/days (e.g. work hours). **Not exposed in UI.**

### 1.2 Scheduled Blocklist Pause – Details

**Config structure** (`blocklists.scheduled_pause`):

```yaml
scheduled_pause:
  enabled: true
  start: "09:00"   # HH:MM (24h)
  end: "17:00"     # HH:MM (24h)
  days: [1, 2, 3, 4, 5]  # 0=Sun, 1=Mon, ..., 6=Sat. Empty = all days
```

- **Hot-reloadable:** Yes – applied via `blocklists/reload` (same as other blocklist config).
- **Backend:** `internal/blocklist/manager.go` parses and applies on `ApplyConfig`.
- **Sync:** Included in DNS-affecting config; replicas receive from primary.

**Current behavior:** If a user saves blocklists from the UI, the PUT handler overwrites `blocklists` with only `refresh_interval`, `sources`, `allowlist`, `denylist`. **`scheduled_pause` is lost** (and `health_check` too).

### 1.3 Blocklist Health Check – Details

**Config structure** (`blocklists.health_check`):

```yaml
health_check:
  enabled: true
  fail_on_any: true   # If true, apply fails when any source fails
```

- **Hot-reloadable:** Yes – applied via `blocklists/reload`.
- **Backend:** `internal/blocklist/manager.go` validates URLs (HEAD/GET) before apply.
- **Control API:** `GET /blocklists/health` returns validation results per source.
- **Web server:** No proxy for `/api/blocklists/health`; no UI to view or configure.

---

## 2. Implementation Plan

### Phase 1: Scheduled Blocklist Pause UI (High Priority)

**Goal:** Allow users to configure recurring blocklist pause (e.g. don't block during work hours) from the Blocklists tab.

#### 1.1 Web Server API Changes

**File:** `web/server/src/index.js`

1. **GET `/api/blocklists`** – Include `scheduled_pause` in response:
   ```javascript
   res.json({
     refreshInterval: blocklists.refresh_interval || "6h",
     sources: blocklists.sources || [],
     allowlist: blocklists.allowlist || [],
     denylist: blocklists.denylist || [],
     scheduled_pause: blocklists.scheduled_pause || null,  // ADD
   });
   ```

2. **PUT `/api/blocklists`** – Accept and persist `scheduled_pause`:
   - Accept `scheduled_pause` from `req.body` (optional).
   - When writing `overrideConfig.blocklists`, merge `scheduled_pause` so it is preserved.
   - Validate: if present, `enabled` is bool, `start`/`end` are HH:MM, `days` is array of 0–6.

#### 1.2 Client UI Changes

**File:** `web/client/src/App.jsx`

1. **State:** Add `scheduledPause` state:
   ```javascript
   const [scheduledPause, setScheduledPause] = useState({
     enabled: false,
     start: "09:00",
     end: "17:00",
     days: [1, 2, 3, 4, 5],
   });
   ```

2. **Load:** In `loadBlocklists`, set `scheduledPause` from `data.scheduled_pause`.

3. **Save:** In `saveBlocklists` / `applyBlocklists`, include `scheduled_pause` in the PUT body.

4. **UI section** (Blocklists tab, after Manual blocklist / Allowlist):
   - Toggle: "Scheduled pause (don't block during specific hours)"
   - When enabled: `start` (time input), `end` (time input), `days` (checkboxes Mon–Sun).
   - Helper text: "Useful for allowing work tools during business hours."
   - Validation: `start` < `end`; `days` 0–6.

#### 1.3 Validation

- **Client:** `validateScheduledPauseForm({ enabled, start, end, days })`.
- **Server:** Validate before write; reject invalid HH:MM or invalid days.

---

### Phase 2: Blocklist Health Check UI (Medium Priority)

**Goal:** Allow users to enable/configure blocklist health checks and view validation results.

#### 2.1 Web Server API Changes

**File:** `web/server/src/index.js`

1. **GET `/api/blocklists`** – Include `health_check` in response:
   ```javascript
   health_check: blocklists.health_check || null,  // ADD
   ```

2. **PUT `/api/blocklists`** – Accept and persist `health_check`:
   - Accept `health_check` from `req.body` (optional).
   - Merge into `overrideConfig.blocklists`.
   - Validate: `enabled` bool, `fail_on_any` bool.

3. **GET `/api/blocklists/health`** – New proxy to control server:
   ```javascript
   app.get("/api/blocklists/health", async (_req, res) => {
     const response = await fetch(`${dnsControlUrl}/blocklists/health`, { ... });
     const data = await response.json();
     res.json(data);
   });
   ```

#### 2.2 Client UI Changes

**File:** `web/client/src/App.jsx`

1. **State:** Add `healthCheck` and `healthCheckResults`:
   ```javascript
   const [healthCheck, setHealthCheck] = useState({
     enabled: false,
     fail_on_any: true,
   });
   const [healthCheckResults, setHealthCheckResults] = useState(null);
   ```

2. **Load:** In `loadBlocklists`, set `healthCheck` from `data.health_check`.

3. **Save:** Include `health_check` in PUT body.

4. **UI section** (Blocklists tab):
   - Toggle: "Validate blocklist URLs before apply"
   - When enabled: Checkbox "Fail apply if any source fails" (`fail_on_any`).
   - Button: "Check health now" – calls `GET /api/blocklists/health`, shows results (per-source ok/error).

5. **Health results display:** Table or list showing each source name, URL, status (ok/fail), and error message if any.

---

### Phase 3: Preserve Existing Config on Save (Critical)

**Problem:** Current PUT overwrites `blocklists` with a fixed set of keys. Any existing `scheduled_pause` or `health_check` in the override file is lost when the user saves.

**Fix:** When building `overrideConfig.blocklists` for PUT, **merge** with existing override blocklists so we only update the keys we're editing, and preserve `scheduled_pause` and `health_check` when the client sends them.

**Implementation:**
- Always send `scheduled_pause` and `health_check` from client (even if null/disabled).
- Server merges: `overrideConfig.blocklists = { ...existing, ...incoming }` for these keys.

---

## 3. Implementation Order

| Step | Task | Effort | Dependencies |
|------|------|--------|--------------|
| 1 | Web server: Add `scheduled_pause` to GET/PUT `/api/blocklists` | Low | None |
| 2 | Client: State, load, save for `scheduled_pause` | Low | Step 1 |
| 3 | Client: Scheduled pause UI section + validation | Medium | Step 2 |
| 4 | Web server: Add `health_check` to GET/PUT `/api/blocklists` | Low | None |
| 5 | Web server: Add GET `/api/blocklists/health` proxy | Low | None |
| 6 | Client: State, load, save for `health_check` | Low | Step 4 |
| 7 | Client: Health check UI section + "Check health now" | Medium | Step 5, 6 |
| 8 | Ensure PUT preserves existing `scheduled_pause`/`health_check` when not in body | Low | Steps 1, 4 |

---

## 4. UI Mockup (Blocklists Tab Additions)

```
┌─────────────────────────────────────────────────────────────────┐
│ Blocklist Management                    [Save] [Apply changes]  │
├─────────────────────────────────────────────────────────────────┤
│ ... (existing: refresh interval, sources, allowlist, denylist)   │
├─────────────────────────────────────────────────────────────────┤
│ Scheduled pause                                                  │
│ ☑ Don't block during specific hours (e.g. work hours)            │
│   Start: [09:00]  End: [17:00]                                  │
│   Days: ☐Sun ☑Mon ☑Tue ☑Wed ☑Thu ☑Fri ☐Sat                       │
│   When enabled, blocking is paused during this window.           │
├─────────────────────────────────────────────────────────────────┤
│ Blocklist health check                                           │
│ ☑ Validate blocklist URLs before apply                          │
│   ☑ Fail apply if any source fails                              │
│   [Check health now]                                             │
│   (If checked: table of source | URL | Status | Error)           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Testing Checklist

- [ ] Scheduled pause: Enable, set start/end/days, save, apply – verify config file has correct YAML.
- [ ] Scheduled pause: Disable – verify config removes or sets `enabled: false`.
- [ ] Scheduled pause: Replica receives from primary via sync.
- [ ] Health check: Enable, set fail_on_any, save, apply – verify config.
- [ ] Health check: "Check health now" returns correct results from control API.
- [ ] Save blocklists (sources only) – verify `scheduled_pause` and `health_check` are preserved.
- [ ] Validation: Invalid HH:MM, invalid days – client and server reject.

---

## 6. Other Config Items (Out of Scope for This Plan)

The following are documented in `docs/dns-settings-system-config-plan.md` but are separate efforts:

| Config | Status | Notes |
|--------|--------|-------|
| `response` (blocked, blocked_ttl) | ✅ In UI | DNS Settings tab |
| `server`, `cache`, `query_store`, `control`, `ui` | System Settings tab | Restart required |
| `sync` | ✅ Sync tab | Role, tokens, replica config |

This plan focuses solely on **scheduled blocklist pause** and **blocklist health check** within the Blocklists tab.

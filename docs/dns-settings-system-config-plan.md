# DNS Settings & System Configuration Plan

This document outlines a plan to fully build out DNS settings with relevant config, make them editable with validation, and organize system-level settings. It also addresses how to make applying settings as easy as possible—whether via apply-without-restart or apply-and-restart.

---

## 1. Current State Summary

### 1.1 DNS Settings Tab (Existing)

| Setting | Editable | Validation | Apply Method |
|---------|----------|------------|--------------|
| Upstream resolvers | Yes | Client + server | Save → Apply (hot-reload) |
| Resolver strategy | Yes | Client + server | Save → Apply (hot-reload) |
| Local DNS records | Yes | Client + server | Save → Apply (hot-reload) |

**Flow:** Save writes to override config file → Apply calls Go control server `/local-records/reload` or `/upstreams/reload` → Config reloaded from disk, applied in-memory. **No restart required.**

### 1.2 Config Not Yet in DNS Settings UI

| Config Section | Key Fields | Hot-Reloadable? |
|----------------|------------|-----------------|
| `response` | `blocked` (nxdomain or IP), `blocked_ttl` | No (resolver reads at init) |
| `server` | `listen`, `protocols`, `read_timeout`, `write_timeout` | No (binds at startup) |
| `cache` | Redis, TTLs, refresh params | No |
| `query_store` | Address, table, retention | No |
| `control` | Listen, token | No |
| `sync` | Role, primary_url, tokens | No |

### 1.3 Architecture

- **Web UI (Node)** → reads/writes config via `/api/dns/*`, `/api/blocklists`, `/api/config`
- **Go control server** → `/local-records/reload`, `/upstreams/reload`, `/blocklists/reload` (hot-reload)
- **Config** → default.yaml + override file (CONFIG_PATH)

---

## 2. Plan: Fully Build Out DNS Settings

### 2.1 Add Response Config to DNS Settings Tab

**Fields to add:**
- `blocked`: How to respond to blocked domains
  - Options: `nxdomain` (default), or an IPv4/IPv6 address (e.g. `0.0.0.0`, `::`)
- `blocked_ttl`: TTL for blocked responses (e.g. `1h`, `300s`)

**Validation:**
- `blocked`: Must be `nxdomain` or valid IPv4/IPv6
- `blocked_ttl`: Must be valid duration (e.g. `30s`, `1h`)

**Apply strategy:** Response config is **not** currently hot-reloadable. Two options:

| Option | Effort | UX |
|--------|--------|-----|
| A. Add `ApplyResponseConfig` to resolver + `/response/reload` | Medium | Apply without restart |
| B. Save only, show "Restart required" | Low | User must restart |

**Recommendation:** Option A. The resolver already holds `blockedResponse` and `blockedTTL`; adding a mutex and `ApplyResponseConfig(cfg)` is straightforward. This keeps DNS Settings fully apply-without-restart.

**Implementation outline:**
1. **Go:** Add `ApplyResponseConfig(cfg config.Config)` to `Resolver`, protect `blockedResponse`/`blockedTTL` with mutex.
2. **Go control:** Add `POST /response/reload` that loads config and calls `resolver.ApplyResponseConfig(cfg)`.
3. **Web server:** Add `GET/PUT /api/dns/response`, `POST /api/dns/response/apply` (proxy to control server).
4. **Client:** Add Response section to DNS Settings tab with validation.

### 2.2 Validation Enhancements

**Client-side (App.jsx):**
- Reuse/extend `validateUpstreamAddress`, `validateLocalRecordsForm`.
- Add `validateResponseForm({ blocked, blockedTTL })`:
  - `blocked`: `nxdomain` or `isValidIPv4`/`isValidIPv6`
  - `blocked_ttl`: `isValidDuration`

**Server-side (web server + Go):**
- Web server PUT handlers: validate before writing config.
- Go control: Config load already validates via `config.Load()`; reload handlers will fail if config is invalid.

**TXT record validation:** For local records type TXT, value can be arbitrary string (no strict IP/hostname check). Current validation may be too strict—ensure TXT allows free-form text.

### 2.3 DNS Settings Tab Structure (Final)

```
DNS Settings
├── Upstream Resolvers (existing)
│   ├── Resolver strategy
│   └── Upstream servers (name, address, protocol)
├── Local DNS Records (existing)
│   └── Records (name, type, value)
└── Blocked Response (new)
    ├── Response type: nxdomain | IP address
    └── Blocked TTL: duration
```

---

## 3. Plan: System Settings Tab

### 3.1 Rationale

Many settings affect the **system** (server, cache, query store, control, sync) rather than DNS resolution. These typically require a restart. Grouping them in a **System Settings** (or **Advanced**) tab:

- Keeps DNS Settings focused on DNS-affecting, hot-reloadable config.
- Provides a clear place for "restart required" settings.
- Avoids cluttering the Config tab (which is raw YAML view/import/export).

### 3.2 Proposed Tab Structure

**Option A: Rename "Config" to "System Settings" and add form-based editing**

- Current Config tab: raw JSON, Import, Export, Restart.
- Add form sections for: Server, Cache, Query Store, Control, Sync, UI.
- Keep raw view as "Advanced" or collapsible.

**Option B: New "System Settings" tab, keep "Config" for raw YAML**

- **System Settings:** Form-based editing of server, cache, query store, control, sync, UI.
- **Config:** Raw YAML view, Import, Export, Restart (unchanged).

**Recommendation:** Option B. Clear separation: DNS Settings = DNS resolution (mostly hot-reload). System Settings = infrastructure (restart required). Config = power users / import-export.

### 3.3 System Settings Sections

| Section | Fields | Restart Required |
|---------|--------|-------------------|
| Server | listen addresses, protocols, read/write timeout | Yes |
| Cache | Redis address, min/max/negative TTL, refresh params | Yes |
| Query Store | enabled, address, database, table, retention_days | Yes |
| Control | enabled, listen, token | Yes |
| Sync | role, enabled, primary_url, sync_token, sync_interval, tokens | Yes |
| UI | hostname | Yes (or could be hot-reload if API supports it) |

**Note:** Sync is already in its own Sync tab. System Settings could either:
- Include Sync summary + link to Sync tab, or
- Keep Sync tab as-is and only put server/cache/query_store/control in System Settings.

**Simpler approach:** System Settings = Server, Cache, Query Store, Control, UI. Sync stays in Sync tab.

---

## 4. Apply UX: Making It Easy

### 4.1 Current Pain Points

1. **Two-step flow:** Save then Apply. Users might forget Apply.
2. **Inconsistent behavior:** Blocklists have "Apply changes" (save + reload). DNS has separate Save and Apply.
3. **Restart required:** Some config (import, system settings) requires restart; messaging could be clearer.

### 4.2 Recommendations

#### 4.2.1 Unified "Apply" Button (Primary Action)

For DNS Settings (upstreams, local records, response):

- **Single "Apply" button** that:
  1. Validates
  2. Saves to config file
  3. Calls reload endpoint(s)
- Optionally keep "Save" as secondary (save only, no reload) for users who want to batch changes.

**Blocklists already do this:** "Apply changes" = save + reload. Align DNS Settings to the same pattern.

#### 4.2.2 Per-Section Apply vs Global Apply

**Option A: Per-section Apply**
- Upstream Resolvers: [Apply]
- Local Records: [Apply]
- Blocked Response: [Apply]

**Option B: Single "Apply all DNS changes"**
- One button at top of DNS Settings that saves and reloads upstreams, local records, response.

**Recommendation:** Option A. Smaller blast radius; user can apply one section at a time. Matches current UX (each section has its own Apply).

#### 4.2.3 Clear Restart Messaging

For System Settings and Config import:

- After save: **"Saved. Restart the service to apply changes."**
- Prominent **"Restart service"** button.
- Optional: Detect unsaved changes and warn before navigating away.

#### 4.2.4 Apply Without Restart (Summary)

| Section | Apply Method | Button Label |
|---------|--------------|--------------|
| Blocklists | Save + reload | Apply changes |
| Upstreams | Save + reload | Apply changes |
| Local records | Save + reload | Apply changes |
| Blocked response | Save + reload (after adding reload) | Apply changes |
| System settings | Save only | Save (Restart required) |
| Config import | Import only | Import (Restart required) |

### 4.3 Technical: Batch Apply for DNS

If we add a single "Apply all DNS" button:

- **Web server:** `POST /api/dns/apply-all` that:
  1. Validates all DNS sections (upstreams, local records, response)
  2. Writes override config
  3. Calls control server: `/upstreams/reload`, `/local-records/reload`, `/response/reload` (and optionally `/blocklists/reload` if blocklists are considered part of "DNS")
- **Client:** One button that triggers this.

**Simpler:** Keep per-section Apply. Less complexity, clearer feedback.

---

## 5. Implementation Phases

### Phase 1: DNS Settings – Blocked Response (Hot-Reload)

1. **Go resolver:** Add `ApplyResponseConfig(cfg)` and mutex for `blockedResponse`/`blockedTTL`.
2. **Go control:** Add `POST /response/reload`.
3. **Web server:** Add `GET/PUT /api/dns/response`, `POST /api/dns/response/apply`.
4. **Client:** Add Blocked Response section to DNS Settings with validation and Apply.

### Phase 2: Validation Hardening

1. **Client:** Ensure TXT records allow free-form value; tighten any edge cases.
2. **Server:** Add validation to PUT handlers (e.g. response blocked format, duration).
3. **Consistency:** Align error messages between client and server.

### Phase 3: System Settings Tab (Optional)

1. Add "System Settings" tab.
2. Form sections: Server, Cache, Query Store, Control, UI.
3. GET/PUT API for each section (or combined `/api/system/config`).
4. Clear "Restart required" messaging.

### Phase 4: Apply UX Polish (Optional)

1. Unify button labels: "Apply changes" for all hot-reload sections.
2. Consider "Apply all DNS" if users request it.
3. Improve restart flow: toast/notification after save.

---

## 6. Config File Layout

Override file (CONFIG_PATH) is merged with default. Only override keys need to be written. Example:

```yaml
# Override: only DNS-affecting + any overridden system settings
upstreams:
  - name: cloudflare
    address: "1.1.1.1:53"
    protocol: udp
resolver_strategy: failover
local_records:
  - name: router.local
    type: A
    value: "192.168.1.1"
response:
  blocked: nxdomain
  blocked_ttl: "1h"
```

---

## 7. Replica Behavior (Sync)

Per `docs/instance-sync-feature-plan.md`:

- **DNS-affecting** (upstreams, local_records, response, blocklists): Replicas receive from primary. DNS Settings tab is **read-only** for replicas.
- **System settings** (server, cache, query_store, control): Replicas can tune locally (e.g. query store retention). System Settings tab would be **editable** for replicas for non-DNS-affecting sections.

---

## 8. Summary

| Item | Action |
|------|--------|
| DNS Settings – Blocked Response | Add UI + API + hot-reload (`/response/reload`) |
| Validation | Harden client + server for response, TXT records |
| System Settings tab | New tab for server, cache, query store, control, UI (restart required) |
| Apply UX | Use "Apply changes" consistently; clear restart messaging |
| Apply without restart | All DNS Settings (upstreams, local records, response) support hot-reload after Phase 1 |

# Client Groups and Parental Controls — Feature Plan

## Executive Summary

This document outlines a feature to introduce full-featured client management with dedicated UI, client groups, and per-group blocklists—enabling parental controls and other use cases where different devices need different filtering policies.

---

## Implementation Status

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1 | ✅ Done | Clients page, move client identification from System Settings |
| Phase 2 | ✅ Done | Groups config, `group_id` on clients, `ResolveGroup` in resolver |
| Phase 3 | ✅ Done | Per-group blocklist resolution |
| Phase 4 | ✅ Done | Per-group safe search |
| Phase 5 | ✅ Done | Per-group scheduled pause (via blocklist `scheduled_pause` on groups with custom blocklist) |
| Phase 6 | ✅ Done | Control API CRUD for clients and groups, client discovery from query store |

---

## Current State (Pre-Phase 1)

### Client Identification
- **Location**: Buried in System Settings tab
- **Config**: `client_identification.clients` — simple `map[string]string` (IP → name)
- **Purpose**: Per-device analytics only ("Which device queries X?" in query logs)
- **API**: Single reload endpoint (`POST /client-identification/reload`)
- **Storage**: Config file only; no persistence layer

### Blocklist
- **Scope**: Global — one blocklist applies to all clients
- **Resolver**: `blocklist.IsBlocked(qname)` — no client awareness
- **Config**: `blocklists.sources`, `allowlist`, `denylist`, `scheduled_pause`

### Safe Search
- **Scope**: Global — applies to all clients
- **Config**: `safe_search.enabled`, `google`, `bing`

---

## Goals

1. **Dedicated Clients Page** — Break client identification out of System Settings onto its own page with full CRUD, discovery, and grouping
2. **Groups** — Create named groups (e.g. "Kids", "Adults", "Guest") and assign clients to groups
3. **Per-Group Blocklists** — Each group can have its own blocklist sources, allowlist, denylist, and scheduled pause
4. **Parental Controls** — Support use cases like:
   - Kids group: strict blocklist + safe search + time-based pause (e.g. no social media after 9pm)
   - Adults group: lighter or no blocklist
   - Guest: minimal blocking

---

## Proposed Architecture

### 1. Data Model

#### Clients (enhanced)
```yaml
client_identification:
  enabled: true
  clients:
    - id: "uuid-1"                    # Optional; auto-generated if missing
      ip: "192.168.1.10"
      name: "Kids Tablet"
      group_id: "kids"                # Reference to group
      # Optional: MAC address, hostname for discovery
```

#### Groups
```yaml
client_groups:
  - id: "kids"
    name: "Kids"
    description: "Children's devices - strict filtering"
    blocklist:
      sources:
        - name: hagezi-pro-plus
          url: "https://..."
      allowlist: []
      denylist: []
      scheduled_pause:
        enabled: true
        start: "21:00"
        end: "07:00"
        days: [0, 1, 2, 3, 4, 5, 6]   # All days - no internet at night
    safe_search:
      enabled: true
      google: true
      bing: true
  - id: "adults"
    name: "Adults"
    blocklist:
      sources: []                      # No blocking, or light list
    safe_search:
      enabled: false
  - id: "default"                     # Fallback when client has no group
    name: "Default"
    blocklist:                         # Inherits global blocklists if not specified
      inherit_global: true
```

#### Resolution Order
1. Client IP → lookup in `clients` → get `group_id`
2. If group has `blocklist` with `inherit_global: false` → use group blocklist only
3. If group has `blocklist` with `inherit_global: true` or no blocklist → use global blocklist
4. Safe search: group-level overrides global when set

---

### 2. Backend Changes

#### 2.1 Config (`internal/config/config.go`)
- Add `ClientGroupsConfig` with `Groups []ClientGroup`
- Add `ClientGroup` struct: `ID`, `Name`, `Description`, `Blocklist`, `SafeSearch`
- Extend `ClientIdentificationConfig`: support `clients` as list of `ClientEntry` with `IP`, `Name`, `GroupID`
- Add `BlocklistConfig` reference for groups (can reuse existing struct with optional `InheritGlobal`)

#### 2.2 Client ID Resolver (`internal/clientid/resolver.go`)
- Extend to return `(name string, groupID string)` — or add `ResolveGroup(ip string) string`
- Support client → group mapping

#### 2.3 Blocklist Manager
**Option A: Per-group blocklist managers**
- Create `blocklist.Manager` per group that has custom blocklist
- Resolver holds: `globalBlocklist *Manager`, `groupBlocklists map[string]*Manager`
- On query: resolve client IP → group → use group's manager or global

**Option B: Single manager with group-aware API**
- Add `IsBlockedForGroup(qname, groupID string) bool`
- Manager internally holds `map[groupID]*Snapshot` + global
- More complex but single component

**Recommendation**: Option A — clearer separation, reuses existing Manager logic, easier to reason about.

#### 2.4 DNS Resolver (`internal/dnsresolver/resolver.go`)
- Change blocklist check from `r.blocklist.IsBlocked(qname)` to:
  ```go
  groupID := ""
  if r.clientIDResolver != nil {
    groupID = r.clientIDResolver.ResolveGroup(clientIP)
  }
  if groupID != "" && r.groupBlocklists[groupID] != nil {
    if r.groupBlocklists[groupID].IsBlocked(qname) { ... }
  } else {
    if r.blocklist.IsBlocked(qname) { ... }
  }
  ```
- Safe search: similar — resolve group, use group's safe search config or global

#### 2.5 Control API
| Method | Path | Description |
|--------|------|-------------|
| GET | `/clients` | List clients (from config + optional discovery) |
| POST | `/clients` | Add/update client |
| DELETE | `/clients/:id` | Remove client |
| GET | `/client-groups` | List groups |
| POST | `/client-groups` | Add/update group |
| DELETE | `/client-groups/:id` | Remove group |
| POST | `/client-identification/reload` | Reload (existing, extended) |

*Note*: If config is the source of truth, POST/DELETE would write to config file. Consider whether to support runtime-only clients (in-memory) for discovery before assignment.

---

### 3. Frontend Changes

#### 3.1 New Tab: Clients
- Add `{ id: "clients", label: "Clients", group: "configure", icon: "clients" }` to TABS
- Route: `/clients`

#### 3.2 Clients Page Layout
```
┌─────────────────────────────────────────────────────────────────┐
│ Clients & Groups                                    [Add Client] │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─ Clients ─────────────────────────────────────────────────┐  │
│  │ IP            │ Name         │ Group    │ Actions          │  │
│  │ 192.168.1.10  │ Kids Tablet  │ Kids     │ Edit | Remove    │  │
│  │ 192.168.1.11  │ Mom's Phone  │ Adults   │ Edit | Remove    │  │
│  │ 192.168.1.12  │ (Unidentified)│ Default │ Assign | Add     │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Groups ───────────────────────────────────────────────────┐ │
│  │ [Kids] [Adults] [Default]                      [Add Group]  │ │
│  │                                                             │ │
│  │ Selected: Kids                                              │ │
│  │ Blocklist: hagezi-pro-plus, 2 allowlist, 0 denylist          │ │
│  │ Safe search: Google ✓, Bing ✓                               │ │
│  │ Scheduled pause: 21:00–07:00 daily                          │ │
│  │ [Edit Group] [Edit Blocklist] [Edit Schedule]               │ │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Discovery (optional): Show recent client IPs from query store   │
│  that aren't yet assigned — "Add as client"                      │
└─────────────────────────────────────────────────────────────────┘
```

#### 3.3 Group Editor
- Modal or slide-out: Name, Description, Blocklist (sources, allowlist, denylist), Safe Search toggles, Scheduled Pause
- Reuse blocklist UI patterns from Blocklists tab (sources list, allow/deny editors)

#### 3.4 Migration from System Settings
- Move Client Identification section from System Settings to Clients page
- System Settings: remove or collapse to a link: "Manage clients →"

---

### 4. Config Schema (YAML)

```yaml
# Global blocklist (used when group has inherit_global or no blocklist)
blocklists:
  refresh_interval: "6h"
  sources: [...]
  allowlist: []
  denylist: []

# Client groups - each can have its own blocklist and safe search
client_groups:
  - id: "default"
    name: "Default"
    blocklist:
      inherit_global: true
    safe_search:
      enabled: false
  - id: "kids"
    name: "Kids"
    blocklist:
      inherit_global: false
      sources:
        - name: hagezi-pro-plus
          url: "https://..."
      allowlist: []
      denylist: ["roblox.com"]   # Extra deny for kids
      scheduled_pause:
        enabled: true
        start: "21:00"
        end: "07:00"
        days: [0, 1, 2, 3, 4, 5, 6]
    safe_search:
      enabled: true
      google: true
      bing: true
  - id: "adults"
    name: "Adults"
    blocklist:
      inherit_global: true       # Use global blocklist
    safe_search:
      enabled: false

# Client identification - IP to name and group
client_identification:
  enabled: true
  clients:
    - ip: "192.168.1.10"
      name: "Kids Tablet"
      group_id: "kids"
    - ip: "192.168.1.11"
      name: "Mom's Phone"
      group_id: "adults"
```

---

### 5. Sync Considerations

- `DNSAffectingConfig` must include `client_groups` and `client_identification` (clients + groups)
- Replicas receive group definitions and client mappings; blocklist resolution happens per-query using group-specific managers

---

### 6. Implementation Phases

#### Phase 1: Clients Page (no groups yet)
- Add `/clients` route and Clients tab
- Move client identification UI from System Settings to Clients page
- Improve UX: table view, validation, add/remove
- Backend: no structural change; same config shape

#### Phase 2: Groups (config only)
- Add `client_groups` config and parsing
- Add `group_id` to client entries
- Extend clientid resolver to return group
- UI: Groups section, create/edit groups (blocklist config stored but not yet applied at resolution time)

#### Phase 3: Per-Group Blocklist Resolution
- Create blocklist managers per group (when group has custom blocklist)
- Modify resolver to use group-specific blocklist when client is in a group
- Add `inherit_global` behavior

#### Phase 4: Per-Group Safe Search
- Extend safe search to be group-aware
- Resolver uses group's safe search when set

#### Phase 5: Per-Group Scheduled Pause
- Blocklist manager already supports scheduled pause
- Ensure each group's blocklist manager gets its own scheduled pause config

#### Phase 6: Control API & Discovery
- Add GET/POST/DELETE for clients and groups (if not config-file-only)
- Optional: "Discover clients" from query store (recent IPs not in config)

---

### 7. Edge Cases

| Scenario | Behavior |
|----------|----------|
| Client IP not in config | Use default group (or global blocklist if no default group) |
| Client in group with no blocklist | Use global blocklist |
| Group deleted but clients reference it | Fall back to default group; validation warning on save |
| Empty `client_groups` | All clients use global blocklist (backward compatible) |
| `client_identification.enabled: false` | No group resolution; global blocklist for all |

---

### 8. Testing

- Unit: `clientid.ResolveGroup`, blocklist selection logic
- Integration: Resolver with mock group blocklists, verify correct IsBlocked per client
- E2E: Create group, assign client, verify blocked domain differs by client

### 10. Performance

- **Fast path**: When no group blocklists exist, the resolver skips client/group resolution and uses the global blocklist directly (zero overhead).
- **With group blocklists**: One extra RLock, `ResolveGroup` map lookup, and group blocklist map lookup per query. Benchmarks show negligible impact (~8 extra allocs, similar latency).

---

### 9. Documentation

- Update `config.example.yaml` with `client_groups` and extended `client_identification`
- Update Control API doc with new endpoints
- Add "Parental Controls" guide: how to set up Kids vs Adults groups

---

## Summary

| Component | Change | Phase 1–2 Status |
|-----------|--------|------------------|
| Config | `client_groups[]`, extended `client_identification.clients` with `group_id` | ✅ |
| clientid | `ResolveGroup(ip) string` | ✅ |
| blocklist | Per-group Manager instances when group has custom blocklist | ✅ |
| resolver | Use group blocklist when client has group; else global | ✅ |
| safe_search | Group-level override | ✅ |
| UI | New Clients page, Groups CRUD, Group blocklist editor, per-group safe search | ✅ |
| Control API | CRUD for clients and groups (GET/POST/DELETE) | ✅ |

This plan enables parental controls by allowing different blocklists, safe search, and time-based pause per group, while keeping backward compatibility when no groups are defined.

## Documentation

- **[Clients and Groups](clients-and-groups.md)** — User guide for client identification and groups
- **[Control API](control-api.md)** — Client identification reload endpoint
- **config/config.example.yaml** — Example `client_identification` and `client_groups` config

# Clients and Groups

Client identification maps client IP addresses to friendly names for per-device analytics. Client groups organize devices for per-group policies (e.g. parental controls with different blocklists per group).

## Overview

- **Client identification**: Map IP addresses to display names (e.g. `192.168.1.10` → "Kids Tablet"). Used in the Queries tab to show which device made each query.
- **Groups**: Assign clients to groups (e.g. Kids, Adults). Each group can use the global blocklist or have its own (sources, allowlist, denylist).
- **Management**: Configure via the Metrics UI **Clients** tab (Configure → Clients) or by editing the config file.

## Configuration

### client_identification

```yaml
client_identification:
  enabled: true
  clients:
    - ip: "192.168.1.10"
      name: "Kids Tablet"
      group_id: "kids"
    - ip: "192.168.1.11"
      name: "Adults Phone"
      group_id: "adults"
```

| Field | Description |
|-------|-------------|
| `enabled` | When `true`, client names are resolved and shown in query analytics. |
| `clients` | List of client entries. Each entry has `ip`, `name`, and optional `group_id`. |

**Legacy format** (backward compatible): You can still use a map of IP → name:

```yaml
client_identification:
  enabled: true
  clients:
    "192.168.1.10": "kids-phone"
    "192.168.1.11": "laptop"
```

Legacy format has no group assignment; clients use the default behavior.

### client_groups

```yaml
client_groups:
  - id: "kids"
    name: "Kids"
    description: "Children's devices - strict filtering"
    blocklist:
      inherit_global: false
      sources:
        - name: "hagezi-pro-plus"
          url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/pro.plus.txt"
      allowlist: []
      denylist: ["roblox.com"]
  - id: "adults"
    name: "Adults"
    description: "Adult devices"
    blocklist:
      inherit_global: true
```

| Field | Description |
|-------|-------------|
| `id` | Unique identifier. Referenced by `client_identification.clients[].group_id`. |
| `name` | Display name shown in the UI. |
| `description` | Optional description. |
| `blocklist` | Optional per-group blocklist. When `inherit_global: false`, the group uses its own sources, allowlist, and denylist. When `inherit_global: true` or omitted, the group uses the global blocklist. |

When a client has no `group_id` or `group_id` is empty, it uses the default behavior (global blocklist). The `id` "default" is reserved for the fallback group.

## Metrics UI

The **Clients** tab (Configure → Clients) provides:

1. **Enable/disable** client identification
2. **Client table**: Add, edit, remove IP → name mappings and assign groups
3. **Groups section**: Create, edit, remove groups with name, description, and per-group blocklist (sources, allowlist, denylist)

Changes apply immediately when you click **Save**—no restart required. The control API reloads client identification from config.

## API

- **Reload**: `POST /client-identification/reload` (Control API) reloads client and group mappings from config.
- **System config**: `GET /api/system/config` and `PUT /api/system/config` (Node.js API) read and write `client_identification` and `client_groups` as part of the system config.

## Use Cases

### Per-device analytics

Enable client identification and add IP → name mappings. The Queries tab will show friendly names instead of raw IPs (e.g. "Kids Tablet" instead of "192.168.1.10").

### Parental controls

Create groups (e.g. Kids, Adults) and assign clients. Set `inherit_global: false` on the Kids group and configure a stricter blocklist (sources, denylist). Adults can use `inherit_global: true` to share the global blocklist.

### DHCP and static IPs

For best results, use static DHCP reservations so each device keeps the same IP. Otherwise, names may become incorrect when IPs change.

## See Also

- [Client Groups and Parental Controls — Feature Plan](client-groups-and-controls-feature-plan.md) — Roadmap and implementation phases
- [Control API Reference](control-api.md) — Client identification reload endpoint
